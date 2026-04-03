/*
 * tray.c
 *
 * Helper-process management and IPC.
 *
 * Spawns and communicates with the private GTK3 tray helper daemon.
 * Resolves the helper binary deterministically, preferring a local
 * build-tree sibling before falling back to the configured libexec path.
 * Dispatches non-blocking async refreshes to the CLI lanes upon user request.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <gio/gio.h>
#include <stdio.h>
#include <string.h>
#include "state.h"
#include "log.h"
#include "app_window.h"
#include "gateway_client.h"
#include "gateway_config.h"
#include "display_model.h"

static GSubprocess *helper_process = NULL;
static GOutputStream *helper_stdin = NULL;
static GDataInputStream *helper_stdout_stream = NULL;
static guint helper_seq = 0;

static void on_helper_process_weak_notify(gpointer data, GObject *where_the_object_was) {
    (void)data;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "helper-finalize helper_process=%p", (void *)where_the_object_was);
}

static void on_helper_stdin_weak_notify(gpointer data, GObject *where_the_object_was) {
    (void)data;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "helper-finalize helper_stdin=%p", (void *)where_the_object_was);
}

static void on_helper_stdout_weak_notify(gpointer data, GObject *where_the_object_was) {
    (void)data;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "helper-finalize helper_stdout=%p", (void *)where_the_object_was);
}

static void on_helper_data_stream_weak_notify(gpointer data, GObject *where_the_object_was) {
    (void)data;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "helper-finalize helper_data_stream=%p", (void *)where_the_object_was);
}

extern void systemd_start_gateway(void);
extern void systemd_stop_gateway(void);
extern void systemd_restart_gateway(void);
extern void gateway_client_refresh(void);
extern void diagnostics_show_window(void);

static void handle_helper_action(const gchar *action) {
    guint seq = ++helper_seq;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "handle_helper_action entry seq=%u action='%s' process=%p stdin=%p stream=%p",
              seq, action, (void *)helper_process, (void *)helper_stdin, (void *)helper_stdout_stream);
    if (g_strcmp0(action, "START") == 0) {
        systemd_start_gateway();
    } else if (g_strcmp0(action, "STOP") == 0) {
        systemd_stop_gateway();
    } else if (g_strcmp0(action, "RESTART") == 0) {
        systemd_restart_gateway();
    } else if (g_strcmp0(action, "REFRESH") == 0) {
        // Run systemd discovery lane first for install/management context
        extern void systemd_refresh(void);
        systemd_refresh();
        // Trigger an immediate gateway client health check
        gateway_client_refresh();
    } else if (g_strcmp0(action, "DIAGNOSTICS") == 0) {
        gateway_client_refresh();
        app_window_navigate_to(SECTION_DIAGNOSTICS);
    } else if (g_strcmp0(action, "OPEN_MAIN") == 0) {
        app_window_show();
    } else if (g_strcmp0(action, "OPEN_DASHBOARD") == 0) {
        GatewayConfig *cfg = gateway_client_get_config();
        if (cfg) {
            g_autofree gchar *url = gateway_config_dashboard_url(cfg);
            if (url) {
                g_app_info_launch_default_for_uri(url, NULL, NULL);
            }
        }
    } else if (g_strcmp0(action, "OPEN_SETTINGS") == 0) {
        app_window_navigate_to(SECTION_GENERAL);
    } else if (g_strcmp0(action, "QUIT") == 0) {
        GApplication *app = g_application_get_default();
        if (app) g_application_quit(app);
    }
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "handle_helper_action exit seq=%u action='%s'", seq, action);
}

static void on_helper_line_read(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    (void)user_data;
    GDataInputStream *data_stream = G_DATA_INPUT_STREAM(source_object);
    g_autoptr(GError) error = NULL;
    gsize length = 0;
    
    guint seq = ++helper_seq;
    OC_LOG_TRACE(OPENCLAW_LOG_CAT_TRAY, "on_helper_line_read entry seq=%u source_object=%p data_stream=%p global_stream=%p match=%d",
              seq, (void *)source_object, (void *)data_stream, (void *)helper_stdout_stream,
              (source_object == (GObject *)helper_stdout_stream));

    gchar *line = g_data_input_stream_read_line_finish(data_stream, res, &length, &error);
    if (line) {
        OC_LOG_TRACE(OPENCLAW_LOG_CAT_TRAY, "on_helper_line_read line='%s' len=%zu", line, length);
        if (g_str_has_prefix(line, "ACTION:")) {
            handle_helper_action(line + 7);
        }
        g_free(line);
        
        // Only re-arm if the helper stream is still alive (not cleared by on_helper_exited)
        if (helper_stdout_stream && helper_process) {
            OC_LOG_TRACE(OPENCLAW_LOG_CAT_TRAY, "on_helper_line_read pre-rearm data_stream=%p", (void *)data_stream);
            g_data_input_stream_read_line_async(data_stream, G_PRIORITY_DEFAULT, NULL, on_helper_line_read, NULL);
            OC_LOG_TRACE(OPENCLAW_LOG_CAT_TRAY, "on_helper_line_read post-rearm");
        } else {
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "on_helper_line_read skip-rearm stream=%p helper_process=%p",
                      (void *)helper_stdout_stream, (void *)helper_process);
        }
    } else {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "on_helper_line_read stream-ended data_stream=%p error=%s",
                  (void *)data_stream, error ? error->message : "(none)");
        if (error) {
            OC_LOG_WARN(OPENCLAW_LOG_CAT_TRAY, "Error reading from helper stdout: %s", error->message);
        }
        // Stream ended — drop our owned reference via g_clear_object so that
        // on_helper_exited (which may also clear it) sees NULL and is a no-op.
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "helper-clear stdout_stream=%p (from stream-ended)", (void *)helper_stdout_stream);
        g_clear_object(&helper_stdout_stream);
    }
}

static void on_helper_exited(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    (void)user_data;
    g_autoptr(GError) error = NULL;
    g_subprocess_wait_finish(G_SUBPROCESS(source_object), res, &error);
    guint seq = ++helper_seq;
    OC_LOG_INFO(OPENCLAW_LOG_CAT_TRAY, "on_helper_exited entry seq=%u source=%p helper_process=%p helper_stdin=%p helper_stdout_stream=%p",
              seq, (void *)source_object, (void *)helper_process, (void *)helper_stdin, (void *)helper_stdout_stream);
    if (error) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_TRAY, "helper wait_finish error: %s", error->message);
    }
    OC_LOG_INFO(OPENCLAW_LOG_CAT_TRAY, "Tray helper exited");

    // Cleanup order: stdout_stream first (may already be NULL if stream-ended
    // callback ran first — g_clear_object is a no-op on NULL), then stdin
    // (owned ref), then process last (so streams are released before the
    // subprocess that backs them).
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "helper-clear stdout_stream=%p (from exited)", (void *)helper_stdout_stream);
    g_clear_object(&helper_stdout_stream);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "helper-clear stdin=%p (from exited)", (void *)helper_stdin);
    g_clear_object(&helper_stdin);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "helper-clear process=%p (from exited)", (void *)helper_process);
    g_clear_object(&helper_process);

    OC_LOG_INFO(OPENCLAW_LOG_CAT_TRAY, "on_helper_exited post-clear process=%p stdin=%p stdout_stream=%p",
              (void *)helper_process, (void *)helper_stdin, (void *)helper_stdout_stream);
    
    GApplication *app = g_application_get_default();
    if (app) {
        g_application_quit(app);
    }
}

void tray_init(void) {
    g_autoptr(GError) error = NULL;
    g_autofree gchar *helper_path = NULL;
    
    // 1. Try build-tree sibling path first
    g_autofree gchar *exe_path = g_file_read_link("/proc/self/exe", NULL);
    if (exe_path) {
        gchar *last_slash = strrchr(exe_path, '/');
        if (last_slash) *last_slash = '\0';
        g_autofree gchar *sibling_path = g_build_filename(exe_path, "openclaw-tray-helper", NULL);
        if (g_file_test(sibling_path, G_FILE_TEST_IS_EXECUTABLE)) {
            helper_path = g_steal_pointer(&sibling_path);
        }
    }
    
    // 2. Fallback to installed libexec path
    if (!helper_path) {
#ifdef OPENCLAW_LIBEXEC_DIR
        helper_path = g_build_filename(OPENCLAW_LIBEXEC_DIR, "openclaw-tray-helper", NULL);
#else
        OC_LOG_ERROR(OPENCLAW_LOG_CAT_TRAY, "OPENCLAW_LIBEXEC_DIR not defined. Falling back to PWD.");
        helper_path = g_strdup("./openclaw-tray-helper");
#endif
    }
    
    const gchar *argv[] = { helper_path, NULL };
    
    helper_process = g_subprocess_newv(argv,
                                       G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDOUT_PIPE,
                                       &error);
    if (!helper_process) {
        OC_LOG_ERROR(OPENCLAW_LOG_CAT_TRAY, "Failed to spawn tray helper (%s): %s", helper_path, error->message);
        GApplication *app = g_application_get_default();
        if (app) g_application_quit(app);
        return;
    }
    
    // Owned reference: g_subprocess_get_stdin_pipe returns a borrowed ref,
    // so we take our own to guarantee validity across async callbacks.
    helper_stdin = g_object_ref(g_subprocess_get_stdin_pipe(helper_process));
    GInputStream *helper_stdout = g_subprocess_get_stdout_pipe(helper_process);
    
    // Owned reference: g_data_input_stream_new returns a new object (refcount=1).
    // Shared cleanup responsibility with on_helper_line_read (stream-ended) and
    // on_helper_exited — both use g_clear_object to avoid double-unref.
    helper_stdout_stream = g_data_input_stream_new(helper_stdout);

    helper_seq = 0;
    OC_LOG_INFO(OPENCLAW_LOG_CAT_TRAY, "tray_init created seq=0 helper_process=%p helper_stdin=%p (owned) helper_stdout=%p (borrowed) helper_data_stream=%p (owned)",
              (void *)helper_process, (void *)helper_stdin, (void *)helper_stdout, (void *)helper_stdout_stream);

    g_object_weak_ref(G_OBJECT(helper_process), on_helper_process_weak_notify, NULL);
    if (helper_stdin)
        g_object_weak_ref(G_OBJECT(helper_stdin), on_helper_stdin_weak_notify, NULL);
    if (helper_stdout)
        g_object_weak_ref(G_OBJECT(helper_stdout), on_helper_stdout_weak_notify, NULL);
    g_object_weak_ref(G_OBJECT(helper_stdout_stream), on_helper_data_stream_weak_notify, NULL);

    // Start reading output asynchronously on the main loop
    g_data_input_stream_read_line_async(helper_stdout_stream, G_PRIORITY_DEFAULT, NULL, on_helper_line_read, NULL);
    
    g_subprocess_wait_async(helper_process, NULL, on_helper_exited, NULL);
}

static gboolean send_line_to_helper(const gchar *line, const gchar *log_line) {
    if (!helper_stdin || !line) return FALSE;

    g_autoptr(GError) write_err = NULL;
    g_autoptr(GError) flush_err = NULL;
    gsize bytes_written = 0;
    gboolean write_ok = g_output_stream_write_all(helper_stdin, line, strlen(line), &bytes_written, NULL, &write_err);
    gboolean flush_ok = g_output_stream_flush(helper_stdin, NULL, &flush_err);
    if (!write_ok || !flush_ok) {
        OC_LOG_WARN(OPENCLAW_LOG_CAT_TRAY, "send_line_to_helper error write_ok=%d flush_ok=%d write_err=%s flush_err=%s stdin=%p",
                  write_ok, flush_ok,
                  write_err ? write_err->message : "(none)",
                  flush_err ? flush_err->message : "(none)",
                  (void *)helper_stdin);
    } else {
        const gchar *log_str = log_line ? log_line : line;
        OC_LOG_TRACE(OPENCLAW_LOG_CAT_TRAY, "send_line_to_helper ok bytes=%zu stdin=%p line='%s'",
                  bytes_written, (void *)helper_stdin, log_str);
    }
    return TRUE;
}

static gchar* redact_dashboard_line_for_log(const gchar *line) {
    if (!line) return NULL;
    
    /* Look for # fragment in DASHBOARD_URL line */
    const gchar *hash = strchr(line, '#');
    if (!hash) return NULL;  /* No fragment to redact - use original line */
    
    /* Build redacted version safely with g_strdup_printf */
    return g_strdup_printf("%.*s#<redacted>\n", (int)(hash - line), line);
}

void tray_update_from_state(const AppState state) {
    if (!helper_stdin) return;
    
    /* Get systemd state via correct API */
    SystemdState *sys = state_get_systemd();
    
    /* A1: Compute service controllability - required for correct Stop/Restart gating.
     * A service is controllable only if:
     * - The unit is installed (we found a unit file)
     * - Systemd is available (not in container/no D-Bus scenarios)
     * - User has permission (implied by unit being in user unit path)
     */
    gboolean service_controllable = sys && sys->installed && !sys->systemd_unavailable;
    
    /* A2: Single authoritative STATE emission showing human-readable status.
     * tray_helper.c uses this for the status menu item label.
     */
    const gchar *status_str = state_get_current_string();
    g_autofree gchar *status_line = g_strdup_printf("STATE:%s\n", status_str);
    send_line_to_helper(status_line, NULL);
    
    OC_LOG_TRACE(OPENCLAW_LOG_CAT_TRAY, "tray_update_from_state state=%s controllable=%d", 
                 status_str, service_controllable);
    
    /* A3: Compute action sensitivities from BOTH app state AND service controllability.
     * Stop/Restart are only sensitive if the service is actually controllable.
     */
    gboolean can_start = FALSE;
    gboolean can_stop = FALSE;
    gboolean can_restart = FALSE;
    gboolean can_open_dashboard = FALSE;
    
    switch (state) {
        case STATE_NEEDS_SETUP:
        case STATE_NEEDS_GATEWAY_INSTALL:
        case STATE_USER_SYSTEMD_UNAVAILABLE:
        case STATE_SYSTEM_UNSUPPORTED:
        case STATE_CONFIG_INVALID:
            /* No actions possible in these states */
            break;
        case STATE_STOPPED:
        case STATE_ERROR:
            can_start = service_controllable;
            break;
        case STATE_STARTING:
            can_stop = service_controllable;
            break;
        case STATE_STOPPING:
            /* In stopping state, no actions until settled */
            break;
        case STATE_RUNNING:
        case STATE_RUNNING_WITH_WARNING:
        case STATE_DEGRADED:
            can_stop = service_controllable;
            can_restart = service_controllable;
            can_open_dashboard = TRUE;
            break;
    }
    
    /* A4: Send DASHBOARD_URL first (if available) with redacted logging.
     * Send real URL to helper but redact token fragment in logs.
     */
    if (can_open_dashboard) {
        GatewayConfig *cfg = gateway_client_get_config();
        if (cfg) {
            g_autofree gchar *url = gateway_config_dashboard_url(cfg);
            if (url) {
                g_autofree gchar *dashboard_line = g_strdup_printf("DASHBOARD_URL:%s\n", url);
                gchar *redacted_for_log = redact_dashboard_line_for_log(dashboard_line);
                send_line_to_helper(dashboard_line, redacted_for_log);
                g_free(redacted_for_log);
            }
        }
    }
    
    /* A5: Send SENSITIVE commands in exact format expected by tray_helper.c.
     * Format: SENSITIVE:ACTION:0|1 (tray_helper.c parses with g_strsplit(line, ":", 3))
     * Supported actions: START, STOP, RESTART, OPEN_DASHBOARD
     */
    g_autofree gchar *sensitive_start = g_strdup_printf("SENSITIVE:START:%d\n", can_start ? 1 : 0);
    g_autofree gchar *sensitive_stop = g_strdup_printf("SENSITIVE:STOP:%d\n", can_stop ? 1 : 0);
    g_autofree gchar *sensitive_restart = g_strdup_printf("SENSITIVE:RESTART:%d\n", can_restart ? 1 : 0);
    g_autofree gchar *sensitive_dashboard = g_strdup_printf("SENSITIVE:OPEN_DASHBOARD:%d\n", can_open_dashboard ? 1 : 0);
    
    send_line_to_helper(sensitive_start, NULL);
    send_line_to_helper(sensitive_stop, NULL);
    send_line_to_helper(sensitive_restart, NULL);
    send_line_to_helper(sensitive_dashboard, NULL);

    /* A6: Send runtime mode label if available.
     * tray_helper.c supports RUNTIME:<label> for the runtime menu item.
     */
    RuntimeMode rm = state_get_runtime_mode();
    TrayDisplayModel tdm;
    HealthState *health = state_get_health();
    tray_display_model_build(state, rm, health, &tdm);
    if (tdm.runtime_label) {
        g_autofree gchar *runtime_line = g_strdup_printf("RUNTIME:%s\n", tdm.runtime_label);
        send_line_to_helper(runtime_line, NULL);
    }

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_TRAY, "tray_update_from_state exit");
}
