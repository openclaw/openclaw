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
    STATE_NOT_INSTALLED,
    STATE_USER_SYSTEMD_UNAVAILABLE,
    STATE_SYSTEM_UNSUPPORTED,
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

typedef struct {
    gint64 last_updated; /* g_get_real_time() in microseconds */

    gboolean http_ok;       /* GET /health succeeded */
    gboolean ws_connected;  /* WebSocket handshake complete */
    gboolean rpc_ok;        /* RPC channel operational */
    gboolean auth_ok;       /* Auth handshake succeeded */
    gboolean config_valid;  /* Config loaded successfully */

    char *endpoint_host;
    int endpoint_port;
    char *gateway_version;
    char *auth_source;
    char *last_error;

    gboolean config_audit_ok;
    int config_issues_count;
} HealthState;

void state_init(void);
void health_state_clear(HealthState *hs);
void state_update_systemd(const SystemdState *sys_state);
void state_update_health(const HealthState *health_state);

AppState state_get_current(void);
const char* state_get_current_string(void);
guint64 state_get_health_generation(void);

SystemdState* state_get_systemd(void);
HealthState* state_get_health(void);

const gchar* systemd_get_canonical_unit_name(void);

/* Callbacks (implemented elsewhere) */
void notify_on_transition(AppState old_state, AppState new_state);
void tray_update_from_state(AppState state);
void state_on_gateway_refresh_requested(void);
