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

    char *endpoint_host;
    int endpoint_port;
    char *gateway_version;
    char *auth_source;
    char *last_error;

    gboolean setup_detected;

    gboolean config_audit_ok;
    int config_issues_count;
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

void state_init(void);
void health_state_clear(HealthState *hs);
void state_update_systemd(const SystemdState *sys_state);
void state_update_health(const HealthState *health_state);

AppState state_get_current(void);
const char* state_get_current_string(void);
guint64 state_get_health_generation(void);

RuntimeMode state_get_runtime_mode(void);
gboolean health_state_listener_proven(const HealthState *hs);
void runtime_mode_describe(RuntimeMode mode, RuntimeModePresentation *out);

SystemdState* state_get_systemd(void);
HealthState* state_get_health(void);

const gchar* systemd_get_canonical_unit_name(void);
void systemd_get_runtime_context(gchar **out_profile, gchar **out_state_dir, gchar **out_config_path);

/* Callbacks (implemented elsewhere) */
void notify_on_transition(AppState old_state, AppState new_state);
void tray_update_from_state(AppState state);
void state_on_gateway_refresh_requested(void);
