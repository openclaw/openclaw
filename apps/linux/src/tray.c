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

static GSubprocess *helper_process = NULL;
static GOutputStream *helper_stdin = NULL;
static GDataInputStream *helper_stdout_stream = NULL;

extern void systemd_start_gateway(void);
extern void systemd_stop_gateway(void);
extern void systemd_restart_gateway(void);
extern void health_probe_gateway(void);
extern void health_run_deep_probe(void);
extern void diagnostics_show_window(void);

static void handle_helper_action(const gchar *action) {
    if (g_strcmp0(action, "START") == 0) {
        systemd_start_gateway();
    } else if (g_strcmp0(action, "STOP") == 0) {
        systemd_stop_gateway();
    } else if (g_strcmp0(action, "RESTART") == 0) {
        systemd_restart_gateway();
    } else if (g_strcmp0(action, "REFRESH") == 0) {
        // Triggers async lanes. The health module itself enforces the
        // single in-flight lock, so we don't pile up subprocesses here.
        health_probe_gateway();
        health_run_deep_probe();
    } else if (g_strcmp0(action, "DIAGNOSTICS") == 0) {
        // Note: Opening diagnostics may explicitly request a background deep probe refresh
        // just in case the last one is stale. The probe execution remains guarded by 
        // the lane's `in_flight` lock, so no overlapping probe jobs are created.
        health_run_deep_probe();
        diagnostics_show_window();
    } else if (g_strcmp0(action, "QUIT") == 0) {
        GApplication *app = g_application_get_default();
        if (app) g_application_quit(app);
    }
}

static void on_helper_line_read(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    (void)user_data;
    GDataInputStream *data_stream = G_DATA_INPUT_STREAM(source_object);
    g_autoptr(GError) error = NULL;
    gsize length = 0;
    
    gchar *line = g_data_input_stream_read_line_finish(data_stream, res, &length, &error);
    if (line) {
        if (g_str_has_prefix(line, "ACTION:")) {
            handle_helper_action(line + 7);
        }
        g_free(line);
        
        // Read next line asynchronously on the main thread context
        g_data_input_stream_read_line_async(data_stream, G_PRIORITY_DEFAULT, NULL, on_helper_line_read, NULL);
    } else {
        if (error) {
            g_warning("Error reading from helper stdout: %s", error->message);
        }
        // Stream ended, release reference kept for the loop
        g_object_unref(data_stream);
        helper_stdout_stream = NULL;
    }
}

static void on_helper_exited(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    (void)user_data;
    g_autoptr(GError) error = NULL;
    g_subprocess_wait_finish(G_SUBPROCESS(source_object), res, &error);
    g_print("Tray helper exited.\n");
    g_clear_object(&helper_process);
    helper_stdin = NULL;
    
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
        g_warning("OPENCLAW_LIBEXEC_DIR not defined. Falling back to PWD.");
        helper_path = g_strdup("./openclaw-tray-helper");
#endif
    }
    
    const gchar *argv[] = { helper_path, NULL };
    
    helper_process = g_subprocess_newv(argv,
                                       G_SUBPROCESS_FLAGS_STDIN_PIPE | G_SUBPROCESS_FLAGS_STDOUT_PIPE,
                                       &error);
    if (!helper_process) {
        g_warning("Failed to spawn tray helper (%s): %s", helper_path, error->message);
        GApplication *app = g_application_get_default();
        if (app) g_application_quit(app);
        return;
    }
    
    helper_stdin = g_subprocess_get_stdin_pipe(helper_process);
    GInputStream *helper_stdout = g_subprocess_get_stdout_pipe(helper_process);
    
    helper_stdout_stream = g_data_input_stream_new(helper_stdout);
    
    // Start reading output asynchronously on the main loop
    g_data_input_stream_read_line_async(helper_stdout_stream, G_PRIORITY_DEFAULT, NULL, on_helper_line_read, NULL);
    
    g_subprocess_wait_async(helper_process, NULL, on_helper_exited, NULL);
}

static void send_to_helper(const gchar *cmd) {
    if (!helper_stdin) return;
    g_output_stream_write_all(helper_stdin, cmd, strlen(cmd), NULL, NULL, NULL);
    g_output_stream_flush(helper_stdin, NULL, NULL);
}

void tray_update_from_state(AppState state) {
    if (!helper_stdin) return;
    
    const char *status_str = state_get_current_string();
    g_autofree gchar *cmd = g_strdup_printf("STATE:%s\n", status_str);
    send_to_helper(cmd);
    
    // Determine action sensitivities based on strict 8-case state
    gboolean can_start = FALSE;
    gboolean can_stop = FALSE;
    gboolean can_restart = FALSE;
    
    switch (state) {
        case STATE_NOT_INSTALLED:
        case STATE_USER_SYSTEMD_UNAVAILABLE:
        case STATE_SYSTEM_UNSUPPORTED:
            break;
        case STATE_STOPPED:
        case STATE_ERROR:
            can_start = TRUE;
            break;
        case STATE_STARTING:
            can_stop = TRUE;
            break;
        case STATE_STOPPING:
            break;
        case STATE_RUNNING:
        case STATE_RUNNING_WITH_WARNING:
        case STATE_DEGRADED:
            can_stop = TRUE;
            can_restart = TRUE;
            break;
    }
    
    g_autofree gchar *cmd_start = g_strdup_printf("SENSITIVE:START:%d\n", can_start ? 1 : 0);
    g_autofree gchar *cmd_stop = g_strdup_printf("SENSITIVE:STOP:%d\n", can_stop ? 1 : 0);
    g_autofree gchar *cmd_restart = g_strdup_printf("SENSITIVE:RESTART:%d\n", can_restart ? 1 : 0);
    
    send_to_helper(cmd_start);
    send_to_helper(cmd_stop);
    send_to_helper(cmd_restart);
}
