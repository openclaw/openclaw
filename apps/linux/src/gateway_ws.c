/*
 * gateway_ws.c
 *
 * Persistent WebSocket client for the OpenClaw Linux Companion App.
 *
 * Maintains a long-lived WebSocket connection to the local gateway,
 * handling the challenge→connect→auth handshake, receive loop,
 * reconnect with exponential backoff, tick watchdog, and keepalive.
 *
 * Mirrors the shared/macOS gateway protocol semantics as implemented
 * in GatewayChannelActor (GatewayChannel.swift:165-753):
 *   - backoff: 500ms initial, doubles to 30000ms max
 *   - keepalive: ping at 15s intervals
 *   - tick watchdog: tickIntervalMs * 2 tolerance
 *   - connect timeout: 12s, challenge timeout: 6s
 *   - client identity: role "operator", scopes from defaultOperatorConnectScopes
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_ws.h"
#include "gateway_protocol.h"
#include "log.h"
#include <libsoup/soup.h>
#include <string.h>

/* Protocol constants from GatewayChannel.swift:177-198 */
#define BACKOFF_INITIAL_MS       500.0
#define BACKOFF_MAX_MS           30000.0
#define KEEPALIVE_INTERVAL_S     15.0
#define CONNECT_TIMEOUT_S        12.0
#define CHALLENGE_TIMEOUT_S      6.0
#define DEFAULT_TICK_INTERVAL_MS 30000.0

/* Client identity from the established operator-client contract
 * (GatewayChannel.swift:127-133, 374-381) */
static const gchar *DEFAULT_CLIENT_ID   = "openclaw-linux";
static const gchar *DEFAULT_CLIENT_MODE = "ui";
static const gchar *DEFAULT_ROLE        = "operator";
static const gchar * const DEFAULT_SCOPES[] = {
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
    NULL
};

typedef struct {
    SoupSession *session;
    SoupWebsocketConnection *ws_conn;
    GatewayWsState state;
    GatewayWsStatusCallback callback;
    gpointer user_data;

    gchar *url;
    gchar *auth_mode;
    gchar *token;
    gchar *password;

    gchar *auth_source;
    gchar *last_error;
    gboolean rpc_ok;

    gdouble backoff_ms;
    gboolean should_reconnect;
    gboolean reconnect_paused_for_auth;

    gdouble tick_interval_ms;
    gint64 last_tick_us;

    guint reconnect_timer_id;
    guint keepalive_timer_id;
    guint tick_watchdog_timer_id;
    guint challenge_timeout_id;
    guint connect_timeout_id;
} GatewayWsClient;

static GatewayWsClient *ws_client = NULL;

static void ws_publish_status(void);
static void ws_schedule_reconnect(void);
static void ws_start_keepalive(void);
static void ws_start_tick_watchdog(void);
static void ws_stop_timers(void);
static void ws_do_connect(void);
static void ws_handle_message(SoupWebsocketConnection *conn, SoupWebsocketDataType type, GBytes *message, gpointer user_data);

static void ws_set_state(GatewayWsState new_state) {
    if (!ws_client) return;
    ws_client->state = new_state;
    ws_publish_status();
}

static void ws_set_error(const gchar *error) {
    if (!ws_client) return;
    g_free(ws_client->last_error);
    ws_client->last_error = error ? g_strdup(error) : NULL;
}

static void ws_publish_status(void) {
    if (!ws_client || !ws_client->callback) return;
    GatewayWsStatus status = {
        .state = ws_client->state,
        .auth_source = ws_client->auth_source,
        .last_error = ws_client->last_error,
        .rpc_ok = ws_client->rpc_ok,
    };
    ws_client->callback(&status, ws_client->user_data);
}

static void ws_cleanup_connection(void) {
    if (!ws_client) return;
    ws_stop_timers();
    if (ws_client->ws_conn) {
        if (soup_websocket_connection_get_state(ws_client->ws_conn) == SOUP_WEBSOCKET_STATE_OPEN) {
            soup_websocket_connection_close(ws_client->ws_conn, SOUP_WEBSOCKET_CLOSE_GOING_AWAY, NULL);
        }
        g_clear_object(&ws_client->ws_conn);
    }
}

static void ws_stop_timers(void) {
    if (!ws_client) return;
    if (ws_client->reconnect_timer_id) {
        g_source_remove(ws_client->reconnect_timer_id);
        ws_client->reconnect_timer_id = 0;
    }
    if (ws_client->keepalive_timer_id) {
        g_source_remove(ws_client->keepalive_timer_id);
        ws_client->keepalive_timer_id = 0;
    }
    if (ws_client->tick_watchdog_timer_id) {
        g_source_remove(ws_client->tick_watchdog_timer_id);
        ws_client->tick_watchdog_timer_id = 0;
    }
    if (ws_client->challenge_timeout_id) {
        g_source_remove(ws_client->challenge_timeout_id);
        ws_client->challenge_timeout_id = 0;
    }
    if (ws_client->connect_timeout_id) {
        g_source_remove(ws_client->connect_timeout_id);
        ws_client->connect_timeout_id = 0;
    }
}

static gboolean ws_on_reconnect_timer(gpointer user_data) {
    (void)user_data;
    if (!ws_client) return G_SOURCE_REMOVE;
    ws_client->reconnect_timer_id = 0;
    if (ws_client->should_reconnect && !ws_client->reconnect_paused_for_auth) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "ws reconnect timer fired, reconnecting");
        ws_do_connect();
    }
    return G_SOURCE_REMOVE;
}

static void ws_schedule_reconnect(void) {
    if (!ws_client || !ws_client->should_reconnect || ws_client->reconnect_paused_for_auth) return;
    gdouble delay_s = ws_client->backoff_ms / 1000.0;
    ws_client->backoff_ms = MIN(ws_client->backoff_ms * 2.0, BACKOFF_MAX_MS);
    guint delay_ms = (guint)(delay_s * 1000.0);
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "ws scheduling reconnect in %u ms", delay_ms);
    if (ws_client->reconnect_timer_id) g_source_remove(ws_client->reconnect_timer_id);
    ws_client->reconnect_timer_id = g_timeout_add(delay_ms, ws_on_reconnect_timer, NULL);
}

static gboolean ws_on_keepalive_timer(gpointer user_data) {
    (void)user_data;
    if (!ws_client || !ws_client->ws_conn) return G_SOURCE_REMOVE;
    if (ws_client->state != GATEWAY_WS_CONNECTED) return G_SOURCE_REMOVE;
    if (soup_websocket_connection_get_state(ws_client->ws_conn) == SOUP_WEBSOCKET_STATE_OPEN) {
        /* Best-effort ping keeps NAT/proxy state alive */
        soup_websocket_connection_send_text(ws_client->ws_conn, "{\"type\":\"ping\"}");
    }
    return G_SOURCE_CONTINUE;
}

static void ws_start_keepalive(void) {
    if (!ws_client) return;
    if (ws_client->keepalive_timer_id) g_source_remove(ws_client->keepalive_timer_id);
    ws_client->keepalive_timer_id = g_timeout_add_seconds((guint)KEEPALIVE_INTERVAL_S, ws_on_keepalive_timer, NULL);
}

static gboolean ws_on_tick_watchdog(gpointer user_data) {
    (void)user_data;
    if (!ws_client || ws_client->state != GATEWAY_WS_CONNECTED) return G_SOURCE_REMOVE;
    if (ws_client->last_tick_us > 0) {
        gint64 now = g_get_monotonic_time();
        gdouble delta_ms = (now - ws_client->last_tick_us) / 1000.0;
        gdouble tolerance = ws_client->tick_interval_ms * 2.0;
        if (delta_ms > tolerance) {
            OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "ws tick missed (%.0f ms > %.0f ms tolerance), reconnecting", delta_ms, tolerance);
            ws_cleanup_connection();
            ws_set_error("Tick missed; reconnecting");
            ws_set_state(GATEWAY_WS_DISCONNECTED);
            ws_schedule_reconnect();
            return G_SOURCE_REMOVE;
        }
    }
    return G_SOURCE_CONTINUE;
}

static void ws_start_tick_watchdog(void) {
    if (!ws_client) return;
    if (ws_client->tick_watchdog_timer_id) g_source_remove(ws_client->tick_watchdog_timer_id);
    guint interval_ms = (guint)(ws_client->tick_interval_ms * 2.0);
    ws_client->tick_watchdog_timer_id = g_timeout_add(interval_ms, ws_on_tick_watchdog, NULL);
}

static gboolean ws_on_challenge_timeout(gpointer user_data) {
    (void)user_data;
    if (!ws_client) return G_SOURCE_REMOVE;
    ws_client->challenge_timeout_id = 0;
    if (ws_client->state == GATEWAY_WS_CHALLENGE_WAIT) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "ws challenge timeout (%.0f s)", CHALLENGE_TIMEOUT_S);
        ws_cleanup_connection();
        ws_set_error("Challenge timeout");
        ws_set_state(GATEWAY_WS_DISCONNECTED);
        ws_schedule_reconnect();
    }
    return G_SOURCE_REMOVE;
}

static gboolean ws_on_connect_timeout(gpointer user_data) {
    (void)user_data;
    if (!ws_client) return G_SOURCE_REMOVE;
    ws_client->connect_timeout_id = 0;
    if (ws_client->state == GATEWAY_WS_CONNECTING || ws_client->state == GATEWAY_WS_AUTHENTICATING) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "ws connect timeout (%.0f s)", CONNECT_TIMEOUT_S);
        ws_cleanup_connection();
        ws_set_error("Connect timeout");
        ws_set_state(GATEWAY_WS_DISCONNECTED);
        ws_schedule_reconnect();
    }
    return G_SOURCE_REMOVE;
}

static void ws_send_connect_request(void) {
    if (!ws_client || !ws_client->ws_conn) return;

    g_autofree gchar *request_id = g_uuid_string_random();
    gchar *json = gateway_protocol_build_connect_request(
        request_id,
        DEFAULT_CLIENT_ID,
        DEFAULT_CLIENT_MODE,
        "OpenClaw Linux Companion",
        DEFAULT_ROLE,
        DEFAULT_SCOPES,
        ws_client->auth_mode,
        ws_client->token,
        ws_client->password,
        "linux",
        "dev");

    if (json) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "ws sending connect request id=%s", request_id);
        ws_set_state(GATEWAY_WS_AUTHENTICATING);
        soup_websocket_connection_send_text(ws_client->ws_conn, json);
        g_free(json);
    }
}

static void ws_handle_frame(const gchar *text) {
    if (!ws_client) return;

    GatewayFrame *frame = gateway_protocol_parse_frame(text);
    if (!frame) return;

    switch (frame->type) {
    case GATEWAY_FRAME_EVENT:
        if (g_strcmp0(frame->event_type, "connect.challenge") == 0) {
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "ws received connect.challenge");
            if (ws_client->challenge_timeout_id) {
                g_source_remove(ws_client->challenge_timeout_id);
                ws_client->challenge_timeout_id = 0;
            }
            ws_send_connect_request();
        } else if (g_strcmp0(frame->event_type, "tick") == 0) {
            ws_client->last_tick_us = g_get_monotonic_time();
        }
        break;

    case GATEWAY_FRAME_RES:
        if (ws_client->state == GATEWAY_WS_AUTHENTICATING) {
            if (frame->error) {
                OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "ws auth rejected: code=%d msg=%s",
                          frame->code, frame->error);
                ws_client->reconnect_paused_for_auth = TRUE;
                ws_set_error(frame->error);
                ws_set_state(GATEWAY_WS_AUTH_FAILED);
                ws_cleanup_connection();
            } else {
                /* connect-ok */
                gchar *auth_src = NULL;
                gdouble tick_ms = DEFAULT_TICK_INTERVAL_MS;
                gateway_protocol_parse_hello_ok(frame, &auth_src, &tick_ms);

                g_free(ws_client->auth_source);
                ws_client->auth_source = auth_src;
                ws_client->tick_interval_ms = tick_ms;
                ws_client->rpc_ok = TRUE;
                ws_client->backoff_ms = BACKOFF_INITIAL_MS;
                ws_client->reconnect_paused_for_auth = FALSE;
                ws_client->last_tick_us = g_get_monotonic_time();

                if (ws_client->connect_timeout_id) {
                    g_source_remove(ws_client->connect_timeout_id);
                    ws_client->connect_timeout_id = 0;
                }

                OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY, "ws connected auth_source=%s tick_ms=%.0f",
                          auth_src ? auth_src : "none", tick_ms);

                ws_start_keepalive();
                ws_start_tick_watchdog();
                ws_set_state(GATEWAY_WS_CONNECTED);
            }
        }
        break;

    default:
        break;
    }

    gateway_frame_free(frame);
}

static void ws_handle_message(SoupWebsocketConnection *conn, SoupWebsocketDataType type,
                              GBytes *message, gpointer user_data) {
    (void)conn;
    (void)user_data;
    if (type != SOUP_WEBSOCKET_DATA_TEXT) return;

    gsize size = 0;
    const gchar *data = g_bytes_get_data(message, &size);
    if (!data || size == 0) return;

    g_autofree gchar *text = g_strndup(data, size);
    ws_handle_frame(text);
}

static void ws_on_closed(SoupWebsocketConnection *conn, gpointer user_data) {
    (void)conn;
    (void)user_data;
    if (!ws_client) return;

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "ws connection closed");
    ws_client->rpc_ok = FALSE;
    g_clear_object(&ws_client->ws_conn);
    ws_stop_timers();

    if (ws_client->state != GATEWAY_WS_AUTH_FAILED) {
        ws_set_error("Connection closed");
        ws_set_state(GATEWAY_WS_DISCONNECTED);
        ws_schedule_reconnect();
    }
}

static void ws_on_error(SoupWebsocketConnection *conn, GError *error, gpointer user_data) {
    (void)conn;
    (void)user_data;
    if (!ws_client) return;
    OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "ws error: %s", error ? error->message : "unknown");
    ws_set_error(error ? error->message : "Unknown WebSocket error");
}

static void ws_on_connect_ready(GObject *source, GAsyncResult *res, gpointer user_data) {
    (void)user_data;
    g_autoptr(GError) error = NULL;
    SoupWebsocketConnection *conn = soup_session_websocket_connect_finish(
        SOUP_SESSION(source), res, &error);

    if (!ws_client) {
        g_clear_object(&conn);
        return;
    }

    if (!conn) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_GATEWAY, "ws connect failed: %s", error ? error->message : "unknown");
        ws_set_error(error ? error->message : "Connect failed");
        ws_set_state(GATEWAY_WS_DISCONNECTED);
        ws_schedule_reconnect();
        return;
    }

    ws_client->ws_conn = conn;

    g_signal_connect(conn, "message", G_CALLBACK(ws_handle_message), NULL);
    g_signal_connect(conn, "closed", G_CALLBACK(ws_on_closed), NULL);
    g_signal_connect(conn, "error", G_CALLBACK(ws_on_error), NULL);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "ws transport connected, waiting for challenge");
    ws_set_state(GATEWAY_WS_CHALLENGE_WAIT);

    /* Start challenge timeout */
    ws_client->challenge_timeout_id = g_timeout_add_seconds(
        (guint)CHALLENGE_TIMEOUT_S, ws_on_challenge_timeout, NULL);
}

static void ws_do_connect(void) {
    if (!ws_client || !ws_client->session) return;

    ws_cleanup_connection();
    ws_set_state(GATEWAY_WS_CONNECTING);

    SoupMessage *msg = soup_message_new("GET", ws_client->url);
    if (!msg) {
        ws_set_error("Invalid WebSocket URL");
        ws_set_state(GATEWAY_WS_ERROR);
        return;
    }

    /* Start overall connect timeout */
    ws_client->connect_timeout_id = g_timeout_add_seconds(
        (guint)CONNECT_TIMEOUT_S, ws_on_connect_timeout, NULL);

    soup_session_websocket_connect_async(
        ws_client->session, msg, NULL, NULL,
        G_PRIORITY_DEFAULT, NULL,
        ws_on_connect_ready, NULL);
    g_object_unref(msg);
}

void gateway_ws_init(void) {
    if (ws_client) return;
    ws_client = g_new0(GatewayWsClient, 1);
    ws_client->session = soup_session_new();
    ws_client->backoff_ms = BACKOFF_INITIAL_MS;
    ws_client->tick_interval_ms = DEFAULT_TICK_INTERVAL_MS;
    ws_client->should_reconnect = TRUE;
}

void gateway_ws_connect(const gchar *ws_url, const gchar *auth_mode,
                        const gchar *token, const gchar *password,
                        GatewayWsStatusCallback callback, gpointer user_data) {
    if (!ws_client) gateway_ws_init();

    g_free(ws_client->url);
    g_free(ws_client->auth_mode);
    g_free(ws_client->token);
    g_free(ws_client->password);
    ws_client->url = g_strdup(ws_url);
    ws_client->auth_mode = g_strdup(auth_mode);
    ws_client->token = g_strdup(token);
    ws_client->password = g_strdup(password);
    ws_client->callback = callback;
    ws_client->user_data = user_data;
    ws_client->should_reconnect = TRUE;
    ws_client->reconnect_paused_for_auth = FALSE;
    ws_client->backoff_ms = BACKOFF_INITIAL_MS;

    ws_do_connect();
}

void gateway_ws_disconnect(void) {
    if (!ws_client) return;
    ws_client->should_reconnect = FALSE;
    ws_cleanup_connection();
    ws_client->rpc_ok = FALSE;
    ws_set_state(GATEWAY_WS_DISCONNECTED);
}

void gateway_ws_shutdown(void) {
    if (!ws_client) return;
    ws_client->should_reconnect = FALSE;
    ws_client->callback = NULL;
    ws_cleanup_connection();
    g_clear_object(&ws_client->session);
    g_free(ws_client->url);
    g_free(ws_client->auth_mode);
    g_free(ws_client->token);
    g_free(ws_client->password);
    g_free(ws_client->auth_source);
    g_free(ws_client->last_error);
    g_free(ws_client);
    ws_client = NULL;
}

GatewayWsState gateway_ws_get_state(void) {
    return ws_client ? ws_client->state : GATEWAY_WS_DISCONNECTED;
}

const gchar* gateway_ws_get_last_error(void) {
    return ws_client ? ws_client->last_error : NULL;
}

const gchar* gateway_ws_state_to_string(GatewayWsState state) {
    switch (state) {
        case GATEWAY_WS_DISCONNECTED:    return "Disconnected";
        case GATEWAY_WS_CONNECTING:      return "Connecting";
        case GATEWAY_WS_CHALLENGE_WAIT:  return "Waiting for Challenge";
        case GATEWAY_WS_AUTHENTICATING:  return "Authenticating";
        case GATEWAY_WS_CONNECTED:       return "Connected";
        case GATEWAY_WS_AUTH_FAILED:     return "Auth Failed";
        case GATEWAY_WS_ERROR:           return "Error";
        default:                         return "Unknown";
    }
}
