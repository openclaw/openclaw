/*
 * health.c
 *
 * Status parsing and executable resolution strategy.
 *
 * Provides a 4-tier fallback system to deterministically locate the OpenClaw
 * CLI, whether launched from a systemd unit, a build tree, or a standard
 * user profile. Implements dual-status data collection using non-blocking
 * GIO subprocesses:
 *   1. Primary health (`gateway status --json`)
 *   2. Secondary deep probe (`gateway probe`)
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <gio/gio.h>
#include <json-glib/json-glib.h>
#include <string.h>
#include "state.h"

static gboolean pending_health_probe = FALSE;
static gboolean pending_deep_probe = FALSE;

static void internal_health_probe_gateway(gboolean is_eager);
static void internal_health_run_deep_probe(gboolean is_eager);

void health_init(void) {
    pending_health_probe = FALSE;
    pending_deep_probe = FALSE;
}

static gchar** resolve_openclaw_argv(const gchar *subcommand) {
    // Deterministic 4-tier executable resolution strategy:
    // Priority 1: Use systemd's ExecStart parsing if available (most reliable, matches what daemon runs)
    // Priority 2: Use build-tree repo-local sibling binary (for dev/test environments)
    // Priority 3: Fallback to PATH resolution using typical npm prefix paths
    // Priority 4: Hardcoded generic fallback

    SystemdState *sys = state_get_systemd();
    if (sys && sys->exec_start_argv && g_strv_length(sys->exec_start_argv) > 0) {
        gint len = g_strv_length(sys->exec_start_argv);
        gint gateway_idx = -1;
        
        for (gint i = 0; i < len; i++) {
            if (g_strcmp0(sys->exec_start_argv[i], "gateway") == 0) {
                gateway_idx = i;
                break;
            }
        }

        if (gateway_idx >= 0) {
            GPtrArray *arr = g_ptr_array_new();
            // Copy prefix up to and including 'gateway'
            for (gint i = 0; i <= gateway_idx; i++) {
                g_ptr_array_add(arr, g_strdup(sys->exec_start_argv[i]));
            }
            
            // Insert subcommand
            if (subcommand) {
                g_ptr_array_add(arr, g_strdup(subcommand));
                if (g_strcmp0(subcommand, "status") == 0) {
                    g_ptr_array_add(arr, g_strdup("--json"));
                }
            }
            
            // Explicit allowlist: we preserve only specific service context flags,
            // avoiding unsupported `run` flags that crash `status` or `probe`.
            for (gint i = gateway_idx + 1; i < len; i++) {
                const gchar *arg = sys->exec_start_argv[i];
                if (g_strcmp0(arg, "--port") == 0 || g_strcmp0(arg, "-p") == 0) {
                    g_ptr_array_add(arr, g_strdup(arg));
                    if (i + 1 < len) {
                        g_ptr_array_add(arr, g_strdup(sys->exec_start_argv[i + 1]));
                        i++; // Skip the value since we just consumed it
                    }
                }
            }
            
            g_ptr_array_add(arr, NULL);
            return (gchar **)g_ptr_array_free(arr, FALSE);
        }
    }

    // Priority 2: Repo-local
    g_autofree gchar *exe_path = g_file_read_link("/proc/self/exe", NULL);
    if (exe_path) {
        gchar *last_slash = strrchr(exe_path, '/');
        if (last_slash) *last_slash = '\0';
        
        g_autofree gchar *local_js = g_build_filename(exe_path, "..", "..", "..", "dist", "index.js", NULL);
        if (g_file_test(local_js, G_FILE_TEST_EXISTS)) {
            gchar **new_argv = g_new0(gchar*, subcommand && g_strcmp0(subcommand, "status") == 0 ? 6 : 5);
            new_argv[0] = g_strdup("node"); 
            new_argv[1] = g_strdup(local_js);
            new_argv[2] = g_strdup("gateway");
            if (subcommand) {
                new_argv[3] = g_strdup(subcommand);
                if (g_strcmp0(subcommand, "status") == 0) {
                    new_argv[4] = g_strdup("--json");
                }
            }
            return new_argv;
        }
    }

    // Priority 3: PATH
    g_autofree gchar *path_bin = g_find_program_in_path("openclaw");
    if (path_bin) {
        gchar **new_argv = g_new0(gchar*, subcommand && g_strcmp0(subcommand, "status") == 0 ? 5 : 4);
        new_argv[0] = g_strdup(path_bin);
        new_argv[1] = g_strdup("gateway");
        if (subcommand) {
            new_argv[2] = g_strdup(subcommand);
            if (g_strcmp0(subcommand, "status") == 0) {
                new_argv[3] = g_strdup("--json");
            }
        }
        return new_argv;
    }

    // Priority 4: Hardcoded
    const gchar *home_dir = g_get_home_dir();
    if (home_dir) {
        g_autofree gchar *npm_path = g_build_filename(home_dir, ".npm-global", "bin", "openclaw", NULL);
        if (g_file_test(npm_path, G_FILE_TEST_IS_EXECUTABLE)) {
            gchar **new_argv = g_new0(gchar*, subcommand && g_strcmp0(subcommand, "status") == 0 ? 5 : 4);
            new_argv[0] = g_strdup(npm_path);
            new_argv[1] = g_strdup("gateway");
            if (subcommand) {
                new_argv[2] = g_strdup(subcommand);
                if (g_strcmp0(subcommand, "status") == 0) {
                    new_argv[3] = g_strdup("--json");
                }
            }
            return new_argv;
        }
    }

    // Fallback
    gchar **new_argv = g_new0(gchar*, subcommand && g_strcmp0(subcommand, "status") == 0 ? 5 : 4);
    new_argv[0] = g_strdup("openclaw");
    new_argv[1] = g_strdup("gateway");
    if (subcommand) {
        new_argv[2] = g_strdup(subcommand);
        if (g_strcmp0(subcommand, "status") == 0) {
            new_argv[3] = g_strdup("--json");
        }
    }
    return new_argv;
}

static GSubprocess *spawn_gateway_subprocess(const gchar *subcommand, GError **error) {
    gchar **argv = resolve_openclaw_argv(subcommand);
    
    GSubprocessLauncher *launcher = g_subprocess_launcher_new(G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_PIPE);
    
    // Create an isolated environment to prevent ambient session variables
    // (like OPENCLAW_PROFILE or OPENCLAW_CONFIG_PATH) from implicitly overriding
    // the managed systemd service's configuration.
    gchar **envp = g_new0(gchar *, 1);
    
    // Narrowly seed required execution variables if present in the ambient session
    const gchar *whitelist[] = {"PATH", "USER", "HOME", "LOGNAME", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK"};
    for (size_t i = 0; i < G_N_ELEMENTS(whitelist); i++) {
        const gchar *val = g_getenv(whitelist[i]);
        if (val) {
            envp = g_environ_setenv(envp, whitelist[i], val, TRUE);
        }
    }
    
    SystemdState *sys = state_get_systemd();
    if (sys && sys->environment) {
        for (gint i = 0; sys->environment[i] != NULL; i++) {
            gchar *env_line = sys->environment[i];
            gchar *eq = strchr(env_line, '=');
            if (eq) {
                g_autofree gchar *key = g_strndup(env_line, eq - env_line);
                gchar *value = eq + 1;
                envp = g_environ_setenv(envp, key, value, TRUE);
            }
        }
    }
    
    // Explicitly align the CLI subprocess with the canonical D-Bus selected unit,
    // as legacy unit files lack a native profile environment variable.
    const gchar *canonical_unit = systemd_get_canonical_unit_name();
    if (canonical_unit) {
        envp = g_environ_setenv(envp, "OPENCLAW_SYSTEMD_UNIT", canonical_unit, TRUE);
    }
    
    g_subprocess_launcher_set_environ(launcher, envp);
    g_strfreev(envp);
    
    if (sys && sys->working_directory) {
        // Preserve WorkingDirectory to respect the execution fidelity of dev-mode
        // services which may rely on cwd to locate local dependencies or config.
        g_subprocess_launcher_set_cwd(launcher, sys->working_directory);
    }
    
    GSubprocess *subprocess = g_subprocess_launcher_spawnv(launcher, (const gchar *const *)argv, error);
    
    g_object_unref(launcher);
    g_strfreev(argv);
    
    return subprocess;
}

static void on_health_probe_finished(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    guint64 launch_gen = 0;
    if (user_data) {
        launch_gen = *(guint64 *)user_data;
        g_free(user_data);
    }
    
    GSubprocess *subprocess = G_SUBPROCESS(source_object);
    g_autoptr(GError) error = NULL;
    gchar *stdout_buf = NULL;
    gchar *stderr_buf = NULL;
    
    g_subprocess_communicate_utf8_finish(subprocess, res, &stdout_buf, &stderr_buf, &error);
    
    state_set_health_in_flight(FALSE);
    
    if (launch_gen != state_get_health_generation()) {
        g_free(stdout_buf);
        g_free(stderr_buf);
        goto check_pending;
    }
    
    if (error || !g_subprocess_get_if_exited(subprocess) || g_subprocess_get_exit_status(subprocess) != 0) {
        HealthState hs = {0};
        hs.last_updated = g_get_real_time();
        state_update_health(&hs);
        g_free(stdout_buf);
        g_free(stderr_buf);
        goto check_pending;
    }
    
    g_autoptr(JsonParser) parser = json_parser_new();
    if (!json_parser_load_from_data(parser, stdout_buf, -1, &error)) {
        HealthState hs = {0};
        hs.last_updated = g_get_real_time();
        state_update_health(&hs);
        g_free(stdout_buf);
        g_free(stderr_buf);
        goto check_pending;
    }
    
    JsonNode *root = json_parser_get_root(parser);
    if (!JSON_NODE_HOLDS_OBJECT(root)) {
        HealthState hs = {0};
        hs.last_updated = g_get_real_time();
        state_update_health(&hs);
        g_free(stdout_buf);
        g_free(stderr_buf);
        goto check_pending;
    }

    JsonObject *root_obj = json_node_get_object(root);
    HealthState hs = {0};
    hs.last_updated = g_get_real_time();
    
    if (json_object_has_member(root_obj, "service")) {
        JsonObject *service_obj = json_object_get_object_member(root_obj, "service");
        if (json_object_has_member(service_obj, "loaded")) {
            hs.loaded = json_object_get_boolean_member(service_obj, "loaded");
        }
        if (json_object_has_member(service_obj, "configAudit")) {
            JsonObject *config_audit = json_object_get_object_member(service_obj, "configAudit");
            if (json_object_has_member(config_audit, "ok")) {
                hs.config_audit_ok = json_object_get_boolean_member(config_audit, "ok");
            }
            if (json_object_has_member(config_audit, "issues")) {
                JsonArray *issues = json_object_get_array_member(config_audit, "issues");
                if (issues) {
                    hs.config_issues_count = json_array_get_length(issues);
                }
            }
        }
    }
    
    if (json_object_has_member(root_obj, "rpc")) {
        JsonObject *rpc_obj = json_object_get_object_member(root_obj, "rpc");
        if (json_object_has_member(rpc_obj, "ok")) {
            hs.rpc_ok = json_object_get_boolean_member(rpc_obj, "ok");
        }
    }
    
    if (json_object_has_member(root_obj, "health")) {
        JsonObject *health_obj = json_object_get_object_member(root_obj, "health");
        if (json_object_has_member(health_obj, "healthy")) {
            hs.health_healthy = json_object_get_boolean_member(health_obj, "healthy");
        }
    }
    
    if (json_object_has_member(root_obj, "gateway")) {
        JsonObject *gateway_obj = json_object_get_object_member(root_obj, "gateway");
        if (json_object_has_member(gateway_obj, "bindHost")) {
            hs.bind_host = g_strdup(json_object_get_string_member(gateway_obj, "bindHost"));
        }
        if (json_object_has_member(gateway_obj, "port")) {
            hs.port = json_object_get_int_member(gateway_obj, "port");
        }
        if (json_object_has_member(gateway_obj, "probeUrl")) {
            hs.probe_url = g_strdup(json_object_get_string_member(gateway_obj, "probeUrl"));
        }
    }
    
    state_update_health(&hs);
    
    g_free(hs.bind_host);
    g_free(hs.probe_url);
    g_free(stdout_buf);
    g_free(stderr_buf);

check_pending:
    if (pending_health_probe) {
        pending_health_probe = FALSE;
        internal_health_probe_gateway(TRUE);
    }
}

static void internal_health_probe_gateway(gboolean is_eager) {
    if (state_get_health()->in_flight) {
        if (is_eager) {
            pending_health_probe = TRUE;
        }
        return;
    }
    pending_health_probe = FALSE;
    
    // Gate periodic probes on an installed supported user service.
    // Stopped services should not keep spawning periodic CLI probes because they are already known offline.
    AppState st = state_get_current();
    if (st == STATE_NOT_INSTALLED || st == STATE_SYSTEM_UNSUPPORTED || st == STATE_STOPPED) {
        return;
    }
    
    g_autoptr(GError) error = NULL;
    
    GSubprocess *subprocess = spawn_gateway_subprocess("status", &error);
    
    if (!subprocess) {
        g_warning("Failed to spawn health probe: %s", error->message);
        HealthState hs = {0};
        hs.last_updated = g_get_real_time();
        state_update_health(&hs);
        return;
    }
    
    guint64 *launch_gen = g_new(guint64, 1);
    *launch_gen = state_get_health_generation();
    
    state_set_health_in_flight(TRUE);
    g_subprocess_communicate_utf8_async(subprocess, NULL, NULL, on_health_probe_finished, launch_gen);
    g_object_unref(subprocess);
}

void health_probe_gateway(void) {
    internal_health_probe_gateway(FALSE);
}

void health_probe_gateway_eager(void) {
    internal_health_probe_gateway(TRUE);
}

static void on_deep_probe_finished(GObject *source_object, GAsyncResult *res, gpointer user_data) {
    guint64 launch_gen = 0;
    if (user_data) {
        launch_gen = *(guint64 *)user_data;
        g_free(user_data);
    }
    
    GSubprocess *subprocess = G_SUBPROCESS(source_object);
    g_autoptr(GError) error = NULL;
    gchar *stdout_buf = NULL;
    gchar *stderr_buf = NULL;
    
    g_subprocess_communicate_utf8_finish(subprocess, res, &stdout_buf, &stderr_buf, &error);
    
    state_set_probe_in_flight(FALSE);
    
    if (launch_gen != state_get_health_generation()) {
        g_free(stdout_buf);
        g_free(stderr_buf);
        goto check_pending;
    }
    
    ProbeState ps = {0};
    ps.ran = TRUE;
    ps.last_updated = g_get_real_time();
    
    if (error) {
        ps.summary = g_strdup_printf("Probe failed to execute: %s", error->message);
        state_update_probe(&ps);
        g_free(ps.summary);
        g_free(stdout_buf);
        g_free(stderr_buf);
        goto check_pending;
    }
    
    if (stdout_buf) {
        // Plaintext parsing is intentionally conservative/simple because
        // probe output is human-oriented, so parsing is heuristic but bounded.
        if (strstr(stdout_buf, "Reachable: yes")) {
            ps.reachable = TRUE;
        }
        if (strstr(stdout_buf, "Connect: ok")) {
            ps.connect_ok = TRUE;
        }
        if (strstr(stdout_buf, "RPC: ok")) {
            ps.rpc_ok = TRUE;
        }
        if (strstr(stdout_buf, "timeout") || strstr(stdout_buf, "timed out")) {
            ps.timed_out = TRUE;
        }
        
        // Synthesize summary strings based on the combination of connectivity booleans
        if (ps.reachable && ps.rpc_ok) {
            ps.summary = g_strdup("Fully reachable");
        } else if (ps.connect_ok && ps.timed_out) {
            ps.summary = g_strdup("Connect OK, but RPC timed out");
        } else if (!ps.reachable) {
            ps.summary = g_strdup("Not reachable");
        } else {
            ps.summary = g_strdup("Unknown or mixed probe result");
        }
    } else {
        ps.summary = g_strdup("No output from probe");
    }
    
    state_update_probe(&ps);
    
    g_free(ps.summary);
    g_free(stdout_buf);
    g_free(stderr_buf);

check_pending:
    if (pending_deep_probe) {
        pending_deep_probe = FALSE;
        internal_health_run_deep_probe(TRUE);
    }
}

static void internal_health_run_deep_probe(gboolean is_eager) {
    if (state_get_probe()->in_flight) {
        if (is_eager) {
            pending_deep_probe = TRUE;
        }
        return;
    }
    pending_deep_probe = FALSE;

    // Gate periodic probes on an installed supported user service.
    // Stopped services should not keep spawning periodic CLI probes because they are already known offline.
    AppState st = state_get_current();
    if (st == STATE_NOT_INSTALLED || st == STATE_SYSTEM_UNSUPPORTED || st == STATE_STOPPED) {
        return;
    }

    g_autoptr(GError) error = NULL;
    
    GSubprocess *subprocess = spawn_gateway_subprocess("probe", &error);
    
    if (!subprocess) {
        ProbeState ps = {0};
        ps.ran = TRUE;
        ps.last_updated = g_get_real_time();
        ps.summary = g_strdup_printf("Probe failed to execute: %s", error->message);
        state_update_probe(&ps);
        g_free(ps.summary);
        return;
    }
    
    guint64 *launch_gen = g_new(guint64, 1);
    *launch_gen = state_get_health_generation();
    
    state_set_probe_in_flight(TRUE);
    g_subprocess_communicate_utf8_async(subprocess, NULL, NULL, on_deep_probe_finished, launch_gen);
    g_object_unref(subprocess);
}

void health_run_deep_probe(void) {
    internal_health_run_deep_probe(FALSE);
}

void health_run_deep_probe_eager(void) {
    internal_health_run_deep_probe(TRUE);
}
