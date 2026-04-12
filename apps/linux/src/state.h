/*
 * state.h
 *
 * State definitions for the OpenClaw Linux Companion App.
 *
 * Declares the core state structures and accessors used to communicate
 * status across the systemd, gateway client, and UI layers.
 *
 * Status Precedence Rule:
 *   Runtime connectivity (HTTP + WS + RPC/auth) determines whether
 *   the gateway is operational. Systemd contributes management/install
 *   context, not primary liveness truth. The state machine must not
 *   regress into "systemd inactive => gateway down" when the native
 *   client is successfully attached.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>

typedef enum {
    STATE_NEEDS_SETUP,
    STATE_NEEDS_GATEWAY_INSTALL,
    STATE_NEEDS_ONBOARDING,
    STATE_USER_SYSTEMD_UNAVAILABLE,
    STATE_SYSTEM_UNSUPPORTED,
    STATE_CONFIG_INVALID,
    STATE_STOPPED,
    STATE_STARTING,
    STATE_STOPPING,
    STATE_RUNNING,
    STATE_RUNNING_WITH_WARNING,
    STATE_DEGRADED,
    STATE_ERROR
} AppState;

typedef struct {
    gboolean systemd_unavailable;
    gboolean installed;
    gboolean system_installed_unsupported;
    gboolean active;
    gboolean activating;
    gboolean deactivating;
    gboolean failed;
    char *unit_name;
    char *active_state;
    char *sub_state;
} SystemdState;

typedef enum {
    HTTP_PROBE_NONE = 0,                /* no probe attempted yet */
    HTTP_PROBE_OK,                      /* 2xx + valid JSON health response */
    HTTP_PROBE_CONNECT_REFUSED,         /* TCP connect refused (nothing listening) */
    HTTP_PROBE_CONNECT_TIMEOUT,         /* TCP connect timed out (no SYN-ACK) */
    HTTP_PROBE_TIMED_OUT_AFTER_CONNECT, /* TCP connected, no HTTP response in time */
    HTTP_PROBE_INVALID_RESPONSE,        /* got bytes, but not valid gateway health */
    HTTP_PROBE_UNKNOWN_ERROR,           /* catch-all */
} HttpProbeResult;

typedef struct {
    gint64 last_updated; /* g_get_real_time() in microseconds */

    gboolean http_ok;       /* GET /health succeeded */
    HttpProbeResult http_probe_result; /* phase-aware probe outcome */
    gboolean ws_connected;  /* WebSocket handshake complete */
    gboolean rpc_ok;        /* RPC channel operational */
    gboolean auth_ok;       /* Auth handshake succeeded */
    gboolean config_valid;  /* Config loaded successfully */

    gchar *endpoint_host;
    int endpoint_port;
    gchar *gateway_version;
    gchar *auth_source;
    gchar *last_error;

    gboolean setup_detected;

    gboolean config_audit_ok;
    int config_issues_count;

    gboolean has_model_config; /* diagnostic only: config has model/provider for runtime */
    gboolean has_provider_config;
    gboolean has_default_model_config;
    gchar *configured_default_model_id;
    gboolean model_catalog_available;
    gboolean selected_model_resolved;
    gboolean agents_available;

    /* Feature B: Wizard onboard marker fields */
    gboolean has_wizard_onboard_marker;
    gboolean wizard_is_local;
    gchar *wizard_last_run_command;
    gchar *wizard_last_run_at;
    gchar *wizard_last_run_mode;
    gchar *wizard_marker_fail_reason;
} HealthState;

/* ---------- Runtime Mode (proof-oriented) ----------
 *
 * A separate semantic dimension from AppState. AppState answers "what
 * lifecycle/readiness class are we in?" RuntimeMode answers "what kind
 * of runtime situation was observed from the available evidence?"
 *
 * These names describe what the app can actually infer — they do NOT
 * claim lifecycle ownership ("started by us") or macOS-style attach
 * knowledge ("adopted existing").
 */
typedef enum {
    RUNTIME_NONE,                             /* no runtime evidence gathered yet */
    RUNTIME_EXPECTED_SERVICE_HEALTHY,          /* expected systemd unit active + endpoint healthy */
    RUNTIME_HEALTHY_OUTSIDE_EXPECTED_SERVICE,  /* endpoint healthy, expected unit not the active explanation */
    RUNTIME_LISTENER_PRESENT_UNRESPONSIVE,     /* TCP connected (probe-proven), health/protocol failed */
    RUNTIME_LISTENER_PRESENT_UNVERIFIED,       /* something answered, not validated as healthy OpenClaw */
    RUNTIME_SERVICE_ACTIVE_NOT_PROVEN,         /* service manager says active, runtime proof missing */
    RUNTIME_UNKNOWN,                           /* fallback */
} RuntimeMode;

typedef struct {
    const char *label;       /* e.g. "Expected Service Healthy" */
    const char *explanation; /* human-readable detail for diagnostics */
} RuntimeModePresentation;

typedef struct {
    gboolean initialized;
    gboolean connected;
} GatewayConnectionTransitionTracker;

typedef enum {
    CHAT_BLOCK_NONE = 0,
    CHAT_BLOCK_NO_CONFIG,
    CHAT_BLOCK_CONFIG_INVALID,
    CHAT_BLOCK_BOOTSTRAP_INCOMPLETE,
    CHAT_BLOCK_SERVICE_INACTIVE,
    CHAT_BLOCK_GATEWAY_UNREACHABLE,
    CHAT_BLOCK_AUTH_INVALID,
    CHAT_BLOCK_PROVIDER_MISSING,
    CHAT_BLOCK_DEFAULT_MODEL_MISSING,
    CHAT_BLOCK_MODEL_CATALOG_EMPTY,
    CHAT_BLOCK_SELECTED_MODEL_UNRESOLVED,
    CHAT_BLOCK_AGENTS_UNAVAILABLE,
    CHAT_BLOCK_UNKNOWN,
} ChatBlockReason;

typedef struct {
    gboolean config_present;
    gboolean config_valid;
    gboolean wizard_completed;
    gboolean service_installed;
    gboolean service_active;
    gboolean gateway_http_ok;
    gboolean gateway_ws_ok;
    gboolean gateway_rpc_ok;
    gboolean gateway_auth_ok;
    gboolean provider_configured;
    gboolean default_model_configured;
    gboolean model_catalog_available;
    gboolean selected_model_resolved;
    gboolean agents_available;
    gboolean desktop_chat_ready;
    ChatBlockReason chat_block_reason;
} DesktopReadinessSnapshot;

void state_init(void);
void health_state_clear(HealthState *hs);
void state_update_systemd(const SystemdState *sys_state);
void state_update_health(const HealthState *health_state);
void state_set_model_catalog_fact(gboolean fetch_succeeded,
                                  guint model_count,
                                  gboolean selected_model_resolved);
void state_set_agents_fact(gboolean fetch_succeeded,
                           guint agent_count);
void state_reset_resolved_facts(void);

AppState state_get_current(void);
const char* state_get_current_string(void);
guint64 state_get_health_generation(void);

RuntimeMode state_get_runtime_mode(void);
gboolean health_state_listener_proven(const HealthState *hs);
void runtime_mode_describe(RuntimeMode mode, RuntimeModePresentation *out);
gboolean state_connection_transition_step(GatewayConnectionTransitionTracker *tracker,
                                          gboolean connected_now,
                                          gboolean *out_connected_now);
const DesktopReadinessSnapshot* state_get_readiness_snapshot(void);

SystemdState* state_get_systemd(void);
HealthState* state_get_health(void);

const gchar* systemd_get_canonical_unit_name(void);
void systemd_get_runtime_context(gchar **out_profile, gchar **out_state_dir, gchar **out_config_path);

/* Callbacks (implemented elsewhere) */
void notify_on_transition(AppState old_state, AppState new_state);
void notify_on_gateway_connection_transition(gboolean connected);
void tray_update_from_state(AppState state);
void state_on_gateway_refresh_requested(void);
