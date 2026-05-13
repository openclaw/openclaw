/*
 * test_onboarding_bootstrap.c
 *
 * Headless lifecycle tests for Linux onboarding bootstrap subprocess runs.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/onboarding_bootstrap.h"
#include "../src/onboarding_bootstrap_resolver.h"

#include <glib.h>

typedef struct {
    OnboardingBootstrapEventKind kind;
    gchar *output;
    gchar *message;
} CapturedEvent;

typedef struct {
    OnboardingBootstrapTestSpawnResult result;
    gchar **last_argv;
} SpawnScript;

static CapturedEvent events[16];
static guint event_count = 0;
static gchar *fake_openclaw = NULL;

static gchar* test_find_program(const gchar *program) {
    if (g_strcmp0(program, "openclaw") == 0 && fake_openclaw) {
        return g_strdup(fake_openclaw);
    }
    return NULL;
}

static void clear_events(void) {
    for (guint i = 0; i < G_N_ELEMENTS(events); i++) {
        g_clear_pointer(&events[i].output, g_free);
        g_clear_pointer(&events[i].message, g_free);
    }
    event_count = 0;
}

static void reset_harness(void) {
    clear_events();
    g_clear_pointer(&fake_openclaw, g_free);
    fake_openclaw = g_strdup("/usr/local/bin/openclaw");
    onboarding_bootstrap_resolver_set_test_hooks(test_find_program, NULL, NULL);
    onboarding_bootstrap_set_spawner_for_test(NULL, NULL);
}

static gboolean test_spawner(const gchar * const *argv,
                             OnboardingBootstrapTestSpawnResult *out,
                             gpointer user_data) {
    SpawnScript *script = user_data;
    g_clear_pointer(&script->last_argv, g_strfreev);
    script->last_argv = g_strdupv((gchar **)argv);
    *out = script->result;
    return TRUE;
}

static void capture_event(const OnboardingBootstrapEvent *event, gpointer user_data) {
    (void)user_data;
    g_assert_cmpuint(event_count, <, G_N_ELEMENTS(events));
    events[event_count].kind = event->kind;
    events[event_count].output = g_strdup(event->output);
    events[event_count].message = g_strdup(event->message);
    event_count++;
}

static void assert_event_kind(guint index, OnboardingBootstrapEventKind kind) {
    g_assert_cmpuint(index, <, event_count);
    g_assert_cmpint(events[index].kind, ==, kind);
}

static void test_spawn_failure(void) {
    reset_harness();
    SpawnScript script = {
        .result = {
            .spawn_ok = FALSE,
            .spawn_error = "spawn failed",
        },
    };
    onboarding_bootstrap_set_spawner_for_test(test_spawner, &script);
    OnboardingBootstrapRun *run =
        onboarding_bootstrap_run_step(ONBOARDING_BOOTSTRAP_STEP_SETUP, capture_event, NULL);
    g_assert_null(run);
    g_assert_cmpuint(event_count, ==, 1);
    assert_event_kind(0, ONBOARDING_BOOTSTRAP_EVENT_ERROR);
    g_assert_cmpstr(events[0].message, ==, "spawn failed");
    g_strfreev(script.last_argv);
}

static void test_setup_happy_path(void) {
    reset_harness();
    const gchar *stdout_lines[] = { "setup line", NULL };
    SpawnScript script = {
        .result = {
            .spawn_ok = TRUE,
            .stdout_lines = stdout_lines,
            .wait_ok = TRUE,
            .exit_code = 0,
            .complete_immediately = TRUE,
        },
    };
    onboarding_bootstrap_set_spawner_for_test(test_spawner, &script);
    OnboardingBootstrapRun *run =
        onboarding_bootstrap_run_step(ONBOARDING_BOOTSTRAP_STEP_SETUP, capture_event, NULL);
    g_assert_nonnull(run);
    g_assert_cmpstr(script.last_argv[0], ==, "/usr/local/bin/openclaw");
    g_assert_cmpstr(script.last_argv[1], ==, "setup");
    g_assert_cmpuint(event_count, ==, 3);
    assert_event_kind(0, ONBOARDING_BOOTSTRAP_EVENT_STARTED);
    assert_event_kind(1, ONBOARDING_BOOTSTRAP_EVENT_OUTPUT);
    g_assert_cmpstr(events[1].output, ==, "setup line");
    assert_event_kind(2, ONBOARDING_BOOTSTRAP_EVENT_DONE);
    onboarding_bootstrap_run_free(run);
    g_strfreev(script.last_argv);
}

static void test_gateway_install_happy_path(void) {
    reset_harness();
    const gchar *stdout_lines[] = { "install line", NULL };
    SpawnScript script = {
        .result = {
            .spawn_ok = TRUE,
            .stdout_lines = stdout_lines,
            .wait_ok = TRUE,
            .exit_code = 0,
            .complete_immediately = TRUE,
        },
    };
    onboarding_bootstrap_set_spawner_for_test(test_spawner, &script);
    OnboardingBootstrapRun *run =
        onboarding_bootstrap_run_step(ONBOARDING_BOOTSTRAP_STEP_GATEWAY_INSTALL, capture_event, NULL);
    g_assert_nonnull(run);
    g_assert_cmpstr(script.last_argv[0], ==, "/usr/local/bin/openclaw");
    g_assert_cmpstr(script.last_argv[1], ==, "gateway");
    g_assert_cmpstr(script.last_argv[2], ==, "install");
    g_assert_cmpuint(event_count, ==, 3);
    assert_event_kind(2, ONBOARDING_BOOTSTRAP_EVENT_DONE);
    onboarding_bootstrap_run_free(run);
    g_strfreev(script.last_argv);
}

static void test_cancel_before_completion(void) {
    reset_harness();
    SpawnScript script = {
        .result = {
            .spawn_ok = TRUE,
            .wait_ok = FALSE,
            .exit_code = -1,
        },
    };
    onboarding_bootstrap_set_spawner_for_test(test_spawner, &script);
    OnboardingBootstrapRun *run =
        onboarding_bootstrap_run_step(ONBOARDING_BOOTSTRAP_STEP_SETUP, capture_event, NULL);
    onboarding_bootstrap_run_cancel(run);
    onboarding_bootstrap_test_complete_pending();
    g_assert_cmpuint(event_count, ==, 2);
    assert_event_kind(0, ONBOARDING_BOOTSTRAP_EVENT_STARTED);
    assert_event_kind(1, ONBOARDING_BOOTSTRAP_EVENT_CANCELLED);
    onboarding_bootstrap_run_free(run);
    g_strfreev(script.last_argv);
}

static void test_free_after_cancel_suppresses_future_events(void) {
    reset_harness();
    const gchar *stdout_lines[] = { "late output", NULL };
    SpawnScript script = {
        .result = {
            .spawn_ok = TRUE,
            .stdout_lines = stdout_lines,
            .wait_ok = TRUE,
            .exit_code = 0,
        },
    };
    onboarding_bootstrap_set_spawner_for_test(test_spawner, &script);
    OnboardingBootstrapRun *run =
        onboarding_bootstrap_run_step(ONBOARDING_BOOTSTRAP_STEP_SETUP, capture_event, NULL);
    onboarding_bootstrap_run_cancel(run);
    onboarding_bootstrap_run_free(run);
    onboarding_bootstrap_test_complete_pending();
    g_assert_cmpuint(event_count, ==, 1);
    assert_event_kind(0, ONBOARDING_BOOTSTRAP_EVENT_STARTED);
    g_strfreev(script.last_argv);
}

static void test_timeout_emits_error(void) {
    reset_harness();
    SpawnScript script = {
        .result = {
            .spawn_ok = TRUE,
            .wait_ok = FALSE,
            .exit_code = -1,
        },
    };
    onboarding_bootstrap_set_spawner_for_test(test_spawner, &script);
    OnboardingBootstrapRun *run =
        onboarding_bootstrap_run_step(ONBOARDING_BOOTSTRAP_STEP_SETUP, capture_event, NULL);
    onboarding_bootstrap_test_timeout_pending();
    g_assert_true(onboarding_bootstrap_test_force_exit_was_scheduled());
    g_assert_cmpuint(event_count, ==, 2);
    assert_event_kind(0, ONBOARDING_BOOTSTRAP_EVENT_STARTED);
    assert_event_kind(1, ONBOARDING_BOOTSTRAP_EVENT_ERROR);
    g_assert_nonnull(g_strstr_len(events[1].message, -1, "timed out"));
    onboarding_bootstrap_run_free(run);
    g_strfreev(script.last_argv);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/onboarding/bootstrap/spawn_failure", test_spawn_failure);
    g_test_add_func("/onboarding/bootstrap/setup_happy_path", test_setup_happy_path);
    g_test_add_func("/onboarding/bootstrap/gateway_install_happy_path", test_gateway_install_happy_path);
    g_test_add_func("/onboarding/bootstrap/cancel_before_completion", test_cancel_before_completion);
    g_test_add_func("/onboarding/bootstrap/free_after_cancel_suppresses_future_events",
                    test_free_after_cancel_suppresses_future_events);
    g_test_add_func("/onboarding/bootstrap/timeout_emits_error", test_timeout_emits_error);
    return g_test_run();
}

