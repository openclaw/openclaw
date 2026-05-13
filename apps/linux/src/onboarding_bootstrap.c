/*
 * onboarding_bootstrap.c
 *
 * Async subprocess runner for Linux onboarding bootstrap steps.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "onboarding_bootstrap.h"

struct _OnboardingBootstrapRun {
    gint ref_count;
    GSubprocess *process;
    GCancellable *cancellable;
    GDataInputStream *stdout_stream;
    GDataInputStream *stderr_stream;
    OnboardingBootstrapCallback callback;
    gpointer user_data;
    guint timeout_id;
    guint force_exit_id;
    gboolean stdout_done;
    gboolean stderr_done;
    gboolean process_done;
    gboolean process_ok;
    gboolean cancel_requested;
    gboolean timed_out;
    gboolean suppress_events;
    gboolean completed;
    gint exit_code;
    gchar *process_error;
};

static OnboardingBootstrapRun* bootstrap_run_ref(OnboardingBootstrapRun *run) {
    g_atomic_int_inc(&run->ref_count);
    return run;
}

static void bootstrap_run_unref(OnboardingBootstrapRun *run) {
    if (!run || !g_atomic_int_dec_and_test(&run->ref_count)) {
        return;
    }
    if (run->timeout_id != 0) {
        g_source_remove(run->timeout_id);
    }
    if (run->force_exit_id != 0) {
        g_source_remove(run->force_exit_id);
    }
    g_clear_object(&run->process);
    g_clear_object(&run->cancellable);
    g_clear_object(&run->stdout_stream);
    g_clear_object(&run->stderr_stream);
    g_clear_pointer(&run->process_error, g_free);
    g_free(run);
}

static OnboardingBootstrapSpawnerForTest test_spawner = NULL;
static gpointer test_spawner_user_data = NULL;
static OnboardingBootstrapRun *test_pending_run = NULL;
static OnboardingBootstrapTestSpawnResult test_pending_result = {0};
static gboolean test_force_exit_scheduled = FALSE;

void onboarding_bootstrap_set_spawner_for_test(OnboardingBootstrapSpawnerForTest spawner,
                                               gpointer user_data) {
    if (test_pending_run) {
        bootstrap_run_unref(test_pending_run);
        test_pending_run = NULL;
    }
    memset(&test_pending_result, 0, sizeof(test_pending_result));
    test_spawner = spawner;
    test_spawner_user_data = user_data;
    test_force_exit_scheduled = FALSE;
}

static gchar* bootstrap_sanitized_path(void) {
    const gchar *home = g_get_home_dir();
    g_autofree gchar *home_local = home ? g_build_filename(home, ".local", "bin", NULL) : NULL;
    g_autofree gchar *npm_global = home ? g_build_filename(home, ".npm-global", "bin", NULL) : NULL;
    g_autofree gchar *pnpm = home ? g_build_filename(home, "Library", "pnpm", NULL) : NULL;
    return g_strjoin(":",
                     "/usr/local/sbin",
                     "/usr/local/bin",
                     "/usr/sbin",
                     "/usr/bin",
                     "/sbin",
                     "/bin",
                     home_local ? home_local : "",
                     npm_global ? npm_global : "",
                     pnpm ? pnpm : "",
                     NULL);
}

static void emit_event(OnboardingBootstrapRun *run,
                       OnboardingBootstrapEventKind kind,
                       gint exit_code,
                       const gchar *output,
                       const gchar *message) {
    if (!run || run->suppress_events || !run->callback) {
        return;
    }
    OnboardingBootstrapEvent event = {
        .kind = kind,
        .exit_code = exit_code,
        .output = output,
        .message = message,
    };
    run->callback(&event, run->user_data);
}

static gboolean bootstrap_force_exit_cb(gpointer user_data) {
    OnboardingBootstrapRun *run = user_data;
    if (!run) {
        return G_SOURCE_REMOVE;
    }
    run->force_exit_id = 0;
    if (run->process && !g_subprocess_get_if_exited(run->process)) {
        g_subprocess_force_exit(run->process);
    }
    return G_SOURCE_REMOVE;
}

static void bootstrap_schedule_force_exit(OnboardingBootstrapRun *run) {
    if (!run || !run->process || run->force_exit_id != 0) {
        if (test_spawner && run && !run->process) {
            test_force_exit_scheduled = TRUE;
        }
        return;
    }
    run->force_exit_id = g_timeout_add_seconds_full(G_PRIORITY_DEFAULT,
                                                    2,
                                                    bootstrap_force_exit_cb,
                                                    bootstrap_run_ref(run),
                                                    (GDestroyNotify)bootstrap_run_unref);
}

static gboolean bootstrap_timeout_cb(gpointer user_data) {
    OnboardingBootstrapRun *run = user_data;
    if (run) {
        run->timeout_id = 0;
        run->timed_out = TRUE;
        run->cancel_requested = TRUE;
        if (run->cancellable) {
            g_cancellable_cancel(run->cancellable);
        }
        bootstrap_schedule_force_exit(run);
    }
    return G_SOURCE_REMOVE;
}

static void bootstrap_maybe_finish(OnboardingBootstrapRun *run) {
    if (!run || run->completed || !run->process_done || !run->stdout_done || !run->stderr_done) {
        return;
    }
    run->completed = TRUE;
    if (run->timeout_id != 0) {
        g_source_remove(run->timeout_id);
        run->timeout_id = 0;
    }
    if (run->force_exit_id != 0) {
        g_source_remove(run->force_exit_id);
        run->force_exit_id = 0;
    }
    if (run->suppress_events) {
        return;
    }
    if (run->timed_out) {
        emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_ERROR, -1, NULL, "Bootstrap step timed out.");
        return;
    }
    if (run->cancel_requested || g_cancellable_is_cancelled(run->cancellable)) {
        emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_CANCELLED, -1, NULL, "Bootstrap step cancelled.");
        return;
    }
    if (!run->process_ok) {
        emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_ERROR, -1, NULL,
                   run->process_error ? run->process_error : "Bootstrap step failed.");
        return;
    }
    if (run->exit_code == 0) {
        emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_DONE, run->exit_code, NULL, "Bootstrap step completed.");
    } else {
        emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_ERROR, run->exit_code, NULL, "Bootstrap command exited with a non-zero status.");
    }
}

static void bootstrap_complete_test_run(OnboardingBootstrapRun *run,
                                        const OnboardingBootstrapTestSpawnResult *result) {
    if (!run || !result) {
        return;
    }
    if (result->stdout_lines) {
        for (const gchar * const *it = result->stdout_lines; *it; it++) {
            emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_OUTPUT, -1, *it, NULL);
        }
    }
    if (result->stderr_lines) {
        for (const gchar * const *it = result->stderr_lines; *it; it++) {
            emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_OUTPUT, -1, *it, NULL);
        }
    }
    run->stdout_done = TRUE;
    run->stderr_done = TRUE;
    run->process_done = TRUE;
    run->process_ok = result->wait_ok;
    run->exit_code = result->exit_code;
    if (!result->wait_ok && !run->process_error) {
        run->process_error = g_strdup("Test process failed.");
    }
    bootstrap_maybe_finish(run);
}

void onboarding_bootstrap_test_complete_pending(void) {
    if (!test_pending_run) {
        return;
    }
    OnboardingBootstrapRun *run = test_pending_run;
    test_pending_run = NULL;
    bootstrap_complete_test_run(run, &test_pending_result);
    bootstrap_run_unref(run);
}

void onboarding_bootstrap_test_timeout_pending(void) {
    if (!test_pending_run) {
        return;
    }
    OnboardingBootstrapRun *run = test_pending_run;
    test_pending_run = NULL;
    run->timed_out = TRUE;
    run->cancel_requested = TRUE;
    bootstrap_schedule_force_exit(run);
    run->stdout_done = TRUE;
    run->stderr_done = TRUE;
    run->process_done = TRUE;
    run->process_ok = FALSE;
    run->exit_code = -1;
    bootstrap_maybe_finish(run);
    bootstrap_run_unref(run);
}

gboolean onboarding_bootstrap_test_force_exit_was_scheduled(void) {
    return test_force_exit_scheduled;
}

static void bootstrap_stdout_line_done(GObject *source, GAsyncResult *result, gpointer user_data);
static void bootstrap_stderr_line_done(GObject *source, GAsyncResult *result, gpointer user_data);

static void bootstrap_schedule_stdout_read(OnboardingBootstrapRun *run) {
    g_data_input_stream_read_line_async(run->stdout_stream,
                                        G_PRIORITY_DEFAULT,
                                        run->cancellable,
                                        bootstrap_stdout_line_done,
                                        bootstrap_run_ref(run));
}

static void bootstrap_schedule_stderr_read(OnboardingBootstrapRun *run) {
    g_data_input_stream_read_line_async(run->stderr_stream,
                                        G_PRIORITY_DEFAULT,
                                        run->cancellable,
                                        bootstrap_stderr_line_done,
                                        bootstrap_run_ref(run));
}

static void bootstrap_handle_line_done(OnboardingBootstrapRun *run,
                                       GDataInputStream *stream,
                                       GAsyncResult *result,
                                       gboolean is_stderr) {
    gsize length = 0;
    g_autoptr(GError) error = NULL;
    g_autofree gchar *line = g_data_input_stream_read_line_finish_utf8(stream,
                                                                       result,
                                                                       &length,
                                                                       &error);
    if (line) {
        emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_OUTPUT, -1, line, NULL);
        if (is_stderr) {
            bootstrap_schedule_stderr_read(run);
        } else {
            bootstrap_schedule_stdout_read(run);
        }
        return;
    }
    if (is_stderr) {
        run->stderr_done = TRUE;
    } else {
        run->stdout_done = TRUE;
    }
    bootstrap_maybe_finish(run);
}

static void bootstrap_stdout_line_done(GObject *source, GAsyncResult *result, gpointer user_data) {
    OnboardingBootstrapRun *run = user_data;
    bootstrap_handle_line_done(run, G_DATA_INPUT_STREAM(source), result, FALSE);
    bootstrap_run_unref(run);
}

static void bootstrap_stderr_line_done(GObject *source, GAsyncResult *result, gpointer user_data) {
    OnboardingBootstrapRun *run = user_data;
    bootstrap_handle_line_done(run, G_DATA_INPUT_STREAM(source), result, TRUE);
    bootstrap_run_unref(run);
}

static void bootstrap_wait_done(GObject *source, GAsyncResult *result, gpointer user_data) {
    OnboardingBootstrapRun *run = user_data;
    g_autoptr(GError) error = NULL;
    run->process_ok = g_subprocess_wait_check_finish(G_SUBPROCESS(source), result, &error);
    run->exit_code = g_subprocess_get_exit_status(G_SUBPROCESS(source));
    if (error) {
        run->process_error = g_strdup(error->message);
    }
    run->process_done = TRUE;
    bootstrap_maybe_finish(run);
    bootstrap_run_unref(run);
}

OnboardingBootstrapRun* onboarding_bootstrap_run_step(OnboardingBootstrapStep step,
                                                      OnboardingBootstrapCallback callback,
                                                      gpointer user_data) {
    OnboardingBootstrapResolution resolution = {0};
    if (!onboarding_bootstrap_resolve_commands(&resolution)) {
        OnboardingBootstrapEvent event = {
            .kind = ONBOARDING_BOOTSTRAP_EVENT_ERROR,
            .exit_code = -1,
            .message = resolution.missing_reason ? resolution.missing_reason : "No bootstrap command is available.",
        };
        if (callback) {
            callback(&event, user_data);
        }
        onboarding_bootstrap_resolution_clear(&resolution);
        return NULL;
    }

    g_auto(GStrv) argv = onboarding_bootstrap_resolution_dup_argv(&resolution, step);
    onboarding_bootstrap_resolution_clear(&resolution);
    if (!argv || !argv[0]) {
        OnboardingBootstrapEvent event = {
            .kind = ONBOARDING_BOOTSTRAP_EVENT_ERROR,
            .exit_code = -1,
            .message = "Bootstrap command resolution returned an empty argv.",
        };
        if (callback) {
            callback(&event, user_data);
        }
        return NULL;
    }

    OnboardingBootstrapRun *run = g_new0(OnboardingBootstrapRun, 1);
    run->ref_count = 1;
    run->callback = callback;
    run->user_data = user_data;
    run->cancellable = g_cancellable_new();

    if (test_spawner) {
        OnboardingBootstrapTestSpawnResult spawn_result = {0};
        if (!test_spawner((const gchar * const *)argv, &spawn_result, test_spawner_user_data) ||
            !spawn_result.spawn_ok) {
            OnboardingBootstrapEvent event = {
                .kind = ONBOARDING_BOOTSTRAP_EVENT_ERROR,
                .exit_code = -1,
                .message = spawn_result.spawn_error ? spawn_result.spawn_error : "Failed to spawn bootstrap command.",
            };
            if (callback) {
                callback(&event, user_data);
            }
            onboarding_bootstrap_run_free(run);
            return NULL;
        }
        emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_STARTED, -1, NULL, "Bootstrap command started.");
        test_pending_result = spawn_result;
        test_pending_run = bootstrap_run_ref(run);
        if (spawn_result.complete_immediately) {
            onboarding_bootstrap_test_complete_pending();
        }
        return run;
    }

    g_autoptr(GSubprocessLauncher) launcher =
        g_subprocess_launcher_new(G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDERR_PIPE);
    g_autofree gchar *path = bootstrap_sanitized_path();
    g_subprocess_launcher_setenv(launcher, "PATH", path, TRUE);
    g_subprocess_launcher_setenv(launcher, "LANG", "C.UTF-8", TRUE);

    g_autoptr(GError) error = NULL;
    run->process = g_subprocess_launcher_spawnv(launcher, (const gchar * const *)argv, &error);
    if (!run->process) {
        OnboardingBootstrapEvent event = {
            .kind = ONBOARDING_BOOTSTRAP_EVENT_ERROR,
            .exit_code = -1,
            .message = error ? error->message : "Failed to spawn bootstrap command.",
        };
        if (callback) {
            callback(&event, user_data);
        }
        onboarding_bootstrap_run_free(run);
        return NULL;
    }

    emit_event(run, ONBOARDING_BOOTSTRAP_EVENT_STARTED, -1, NULL, "Bootstrap command started.");
    run->timeout_id = g_timeout_add_seconds_full(G_PRIORITY_DEFAULT,
                                                 90,
                                                 bootstrap_timeout_cb,
                                                 bootstrap_run_ref(run),
                                                 (GDestroyNotify)bootstrap_run_unref);
    GInputStream *stdout_pipe = g_subprocess_get_stdout_pipe(run->process);
    GInputStream *stderr_pipe = g_subprocess_get_stderr_pipe(run->process);
    run->stdout_stream = g_data_input_stream_new(stdout_pipe);
    run->stderr_stream = g_data_input_stream_new(stderr_pipe);
    bootstrap_schedule_stdout_read(run);
    bootstrap_schedule_stderr_read(run);
    g_subprocess_wait_check_async(run->process,
                                  NULL,
                                  bootstrap_wait_done,
                                  bootstrap_run_ref(run));
    return run;
}

void onboarding_bootstrap_run_cancel(OnboardingBootstrapRun *run) {
    if (!run) {
        return;
    }
    if (run->completed) {
        return;
    }
    run->cancel_requested = TRUE;
    if (run->cancellable) {
        g_cancellable_cancel(run->cancellable);
    }
    bootstrap_schedule_force_exit(run);
}

void onboarding_bootstrap_run_free(OnboardingBootstrapRun *run) {
    if (!run) {
        return;
    }
    run->suppress_events = TRUE;
    run->callback = NULL;
    run->user_data = NULL;
    onboarding_bootstrap_run_cancel(run);
    bootstrap_run_unref(run);
}

