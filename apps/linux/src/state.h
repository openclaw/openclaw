/*
 * state.h
 *
 * State definitions for the OpenClaw Linux Companion App.
 *
 * Declares the core state structures and accessors used to communicate
 * status across the systemd, health probe, and UI layers.
 * Tracks asynchronous in-flight states and update timestamps.
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
    char *working_directory;
    char *active_state;
    char *sub_state;
    char **exec_start_argv;
    char **environment;
} SystemdState;

typedef struct {
    gboolean in_flight;
    gint64 last_updated; // g_get_real_time() in microseconds
    
    gboolean loaded;
    gboolean rpc_ok;
    gboolean health_healthy;
    gboolean config_audit_ok;
    int config_issues_count;
    char *bind_host;
    int port;
    char *probe_url;
} HealthState;

typedef struct {
    gboolean in_flight;
    gint64 last_updated; // g_get_real_time() in microseconds
    
    gboolean ran;
    gboolean reachable;
    gboolean connect_ok;
    gboolean rpc_ok;
    gboolean timed_out;
    char *summary;
} ProbeState;

void state_init(void);
void state_update_systemd(const SystemdState *sys_state);

void state_set_health_in_flight(gboolean in_flight);
void state_update_health(const HealthState *health_state);

void state_set_probe_in_flight(gboolean in_flight);
void state_update_probe(const ProbeState *probe_state);

AppState state_get_current(void);
const char* state_get_current_string(void);
guint64 state_get_health_generation(void);

SystemdState* state_get_systemd(void);
HealthState* state_get_health(void);
ProbeState* state_get_probe(void);

const gchar* systemd_get_canonical_unit_name(void);

// Callbacks (implemented elsewhere)
void notify_on_transition(AppState old_state, AppState new_state);
void tray_update_from_state(AppState state);
