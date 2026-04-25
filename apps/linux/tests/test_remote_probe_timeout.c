/*
 * test_remote_probe_timeout.c
 *
 * Verifies that the SSH probe enforces its timeout. We override the
 * SSH binary to a small shell script that just sleeps longer than
 * the probe timeout, then assert the probe result fires with a
 * timeout-shaped failure (and that it fires within a bounded wall
 * time, well under the script's sleep duration).
 *
 * This locks in the fix for the previously-unconditional "wait
 * forever" SSH probe that could hang the General/Onboarding test
 * actions when the remote host was silently unreachable.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <glib/gstdio.h>
#include <gio/gio.h>
#include <string.h>
#include <sys/stat.h>

#include "../src/remote_probe.h"

typedef struct {
    GMainLoop *loop;
    gboolean   fired;
    RemoteProbeResultKind kind;
    gchar     *title;
    gchar     *detail;
    gint64     fired_at_us;
} ProbeCapture;

static void on_probe_result(const RemoteProbeResult *result, gpointer user_data) {
    ProbeCapture *cap = (ProbeCapture *)user_data;
    cap->fired = TRUE;
    cap->fired_at_us = g_get_monotonic_time();
    if (result) {
        cap->kind = result->kind;
        cap->title = g_strdup(result->title ? result->title : "");
        cap->detail = g_strdup(result->detail ? result->detail : "");
    }
    g_main_loop_quit(cap->loop);
}

/* Watchdog so a regression doesn't hang the test runner. */
static gboolean watchdog_timeout(gpointer user_data) {
    GMainLoop *loop = (GMainLoop *)user_data;
    g_main_loop_quit(loop);
    return G_SOURCE_REMOVE;
}

static gchar* write_sleep_script(gint sleep_seconds) {
    g_autofree gchar *base = g_strdup_printf(
        "openclaw-probe-fake-ssh-%d-%u.sh",
        (int)g_get_real_time(), g_random_int());
    gchar *path = g_build_filename(g_get_tmp_dir(), base, NULL);

    g_autofree gchar *body = g_strdup_printf(
        "#!/bin/sh\n"
        "# Fake ssh used by test_remote_probe_timeout. Ignores all args\n"
        "# and just sleeps so the probe must enforce its own timeout.\n"
        "sleep %d\n"
        "exit 0\n",
        sleep_seconds);
    g_assert_true(g_file_set_contents(path, body, -1, NULL));
    g_assert_cmpint(g_chmod(path, 0700), ==, 0);
    return path;
}

static gchar* write_sigterm_trapping_script(gint sleep_seconds) {
    g_autofree gchar *base = g_strdup_printf(
        "openclaw-probe-fake-ssh-trapterm-%d-%u.sh",
        (int)g_get_real_time(), g_random_int());
    gchar *path = g_build_filename(g_get_tmp_dir(), base, NULL);

    /*
     * This child traps SIGTERM and does nothing with it, then sleeps.
     * The probe's SIGTERM must therefore fail to bring down the child;
     * escalation to SIGKILL is the only way the wait completes before
     * the fake sleep ends. We use a loop of short sleeps so the trap
     * actually runs between sleeps (`sleep N` in /bin/sh is uninterruptible
     * on many shells, so we split the wait).
     */
    g_autofree gchar *body = g_strdup_printf(
        "#!/bin/sh\n"
        "# Fake ssh that traps SIGTERM and sleeps until killed.\n"
        "trap '' TERM\n"
        "i=0\n"
        "while [ $i -lt %d ]; do\n"
        "  sleep 1 &\n"
        "  wait $!\n"
        "  i=$((i+1))\n"
        "done\n"
        "exit 0\n",
        sleep_seconds);
    g_assert_true(g_file_set_contents(path, body, -1, NULL));
    g_assert_cmpint(g_chmod(path, 0700), ==, 0);
    return path;
}

/*
 * Fake ssh that pretends a -L local-forward came up successfully.
 *
 * It parses the `-L 127.0.0.1:LOCAL:127.0.0.1:REMOTE` argv pair, opens
 * a real TCP listener on LOCAL, accepts incoming connections silently
 * (never responding so any HTTP request hangs), and traps SIGTERM so
 * the probe's SIGKILL escalation is forced to run.
 *
 * Used to exercise the "/health is in flight when the probe timeout
 * fires" branch of on_ssh_forward_wait, where timeout dominance must
 * deliver "SSH probe timed out" rather than a downstream /health
 * failure verdict.
 */
static gchar* write_health_hanging_script(void) {
    g_autofree gchar *base = g_strdup_printf(
        "openclaw-probe-fake-ssh-hang-health-%d-%u.py",
        (int)g_get_real_time(), g_random_int());
    gchar *path = g_build_filename(g_get_tmp_dir(), base, NULL);

    /*
     * Python is used here (not a sh one-liner) because we need a real
     * accept() loop that holds connections open without responding —
     * sh + nc would close after the first connection, and trying to
     * keep nc alive in a loop introduces visible races with libsoup's
     * connection probing. python3 is a hard dep of the existing build
     * tooling, so requiring it here is consistent with the rest of the
     * test fixtures.
     */
    const gchar *body =
        "#!/usr/bin/env python3\n"
        "# Fake ssh -L: opens a real listener on the LOCAL side of -L,\n"
        "# accepts but never responds, and traps SIGTERM so the probe\n"
        "# must escalate to SIGKILL. Argv layout is permissive — we\n"
        "# only care about the -L spec.\n"
        "import os, signal, socket, sys, threading, time\n"
        "\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "\n"
        "local_port = None\n"
        "i = 0\n"
        "while i < len(sys.argv):\n"
        "    if sys.argv[i] == '-L' and i + 1 < len(sys.argv):\n"
        "        spec = sys.argv[i + 1]\n"
        "        parts = spec.split(':')\n"
        "        if len(parts) == 4:\n"
        "            try:\n"
        "                local_port = int(parts[1])\n"
        "            except ValueError:\n"
        "                pass\n"
        "        break\n"
        "    i += 1\n"
        "\n"
        "if local_port is None:\n"
        "    sys.stderr.write('fake ssh: no -L spec found in argv\\n')\n"
        "    time.sleep(60)\n"
        "    sys.exit(1)\n"
        "\n"
        "sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n"
        "sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
        "sock.bind(('127.0.0.1', local_port))\n"
        "sock.listen(8)\n"
        "\n"
        "def serve(s):\n"
        "    try:\n"
        "        while True:\n"
        "            data = s.recv(4096)\n"
        "            if not data:\n"
        "                return\n"
        "    except OSError:\n"
        "        return\n"
        "\n"
        "while True:\n"
        "    try:\n"
        "        conn, _ = sock.accept()\n"
        "    except OSError:\n"
        "        break\n"
        "    threading.Thread(target=serve, args=(conn,), daemon=True).start()\n";

    g_assert_true(g_file_set_contents(path, body, -1, NULL));
    g_assert_cmpint(g_chmod(path, 0700), ==, 0);
    return path;
}

static void test_ssh_probe_times_out(void) {
    /*
     * The fake ssh sleeps for 30s. We set the probe timeout to 250ms
     * so the timer must fire well before the subprocess exits on its
     * own. This proves the timer-driven SIGTERM path actually runs.
     */
    g_autofree gchar *fake_ssh = write_sleep_script(30);
    remote_probe_test_set_ssh_binary(fake_ssh);
    remote_probe_test_set_ssh_timeout_ms(250);

    ProbeCapture cap = {0};
    cap.loop = g_main_loop_new(NULL, FALSE);
    gint64 started = g_get_monotonic_time();

    /* 5s safety net — generous enough for slow CI but well below the
     * 30s sleep so a regression where the timer never fires is caught. */
    guint watchdog = g_timeout_add(5000, watchdog_timeout, cap.loop);

    /* gateway_port=0 keeps the legacy echo-ok probe path so the test
     * exercises the SSH-side timeout/SIGKILL behaviour without needing
     * a fake HTTP listener. */
    remote_probe_ssh_async("alice", "fake-host", 22, NULL, 0, NULL,
                           on_probe_result, &cap);
    g_main_loop_run(cap.loop);
    if (g_main_context_find_source_by_id(NULL, watchdog)) {
        g_source_remove(watchdog);
    }

    g_assert_true(cap.fired);
    g_assert_cmpint(cap.kind, ==, REMOTE_PROBE_FAILED);
    /* The title for the timeout path is "SSH probe timed out". */
    g_assert_nonnull(strstr(cap.title, "timed out"));

    /* Bounded wall-time check: must fire well under the fake sleep. */
    gint64 elapsed_ms = (g_get_monotonic_time() - started) / 1000;
    g_assert_cmpint(elapsed_ms, <, 5000);

    /* Cleanup. */
    g_main_loop_unref(cap.loop);
    g_free(cap.title);
    g_free(cap.detail);
    remote_probe_test_set_ssh_binary(NULL);
    remote_probe_test_set_ssh_timeout_ms(0);
    g_unlink(fake_ssh);
}

static void test_ssh_probe_escalates_on_trapped_sigterm(void) {
    /*
     * Regression for: "child ignores SIGTERM and the probe hangs forever".
     * The fake ssh traps SIGTERM and keeps sleeping. With a 250 ms
     * probe timeout and a 500 ms SIGKILL grace, the probe must
     * escalate to force_exit() and still deliver the failure callback
     * well under the 30s fake-sleep and the 5s watchdog.
     */
    g_autofree gchar *fake_ssh = write_sigterm_trapping_script(30);
    remote_probe_test_set_ssh_binary(fake_ssh);
    remote_probe_test_set_ssh_timeout_ms(250);

    ProbeCapture cap = {0};
    cap.loop = g_main_loop_new(NULL, FALSE);
    gint64 started = g_get_monotonic_time();
    guint watchdog = g_timeout_add(5000, watchdog_timeout, cap.loop);

    remote_probe_ssh_async("alice", "fake-host", 22, NULL, 0, NULL,
                           on_probe_result, &cap);
    g_main_loop_run(cap.loop);
    if (g_main_context_find_source_by_id(NULL, watchdog)) {
        g_source_remove(watchdog);
    }

    g_assert_true(cap.fired);
    g_assert_cmpint(cap.kind, ==, REMOTE_PROBE_FAILED);
    g_assert_nonnull(strstr(cap.title, "timed out"));

    /* Even with SIGTERM trapped, escalation must bound the wait. We
     * allow generous slack for slow CI but stay well below 5s. */
    gint64 elapsed_ms = (g_get_monotonic_time() - started) / 1000;
    g_assert_cmpint(elapsed_ms, <, 4500);

    g_main_loop_unref(cap.loop);
    g_free(cap.title);
    g_free(cap.detail);
    remote_probe_test_set_ssh_binary(NULL);
    remote_probe_test_set_ssh_timeout_ms(0);
    g_unlink(fake_ssh);
}

static void test_direct_probe_health_failure_path(void) {
    /*
     * Regression: the direct probe now goes through
     * gateway_http_check_health (HTTP GET /health), not raw TCP. This
     * test asserts the failure-side semantics of that change end-to-end:
     *
     *   - point the probe at a normalized ws:// URL targeting a port
     *     where nothing is listening on 127.0.0.1
     *   - the callback must fire with REMOTE_PROBE_FAILED
     *   - the title must reflect the /health-probe failure (not the
     *     legacy "TCP connect" wording)
     *
     * Picking a port via remote_port_check_pick_loopback_port gives us
     * a port that the kernel just confirmed is bindable, i.e. not
     * already serving — a robust "guaranteed-closed" port for the test.
     */
    extern gint remote_port_check_pick_loopback_port(void);
    gint dead_port = remote_port_check_pick_loopback_port();
    g_assert_cmpint(dead_port, >, 0);

    g_autofree gchar *url = g_strdup_printf("ws://127.0.0.1:%d", dead_port);

    ProbeCapture cap = {0};
    cap.loop = g_main_loop_new(NULL, FALSE);
    /*
     * gateway_http internally uses HEALTH_PROBE_TIMEOUT_S (10s); allow
     * 12s here so a slow CI reaching the timeout still observes the
     * REMOTE_PROBE_FAILED callback. Connection refused on loopback is
     * usually instant (sub-millisecond) so the watchdog rarely fires.
     */
    guint watchdog = g_timeout_add(12000, watchdog_timeout, cap.loop);

    remote_probe_direct_async(url, NULL, on_probe_result, &cap);
    g_main_loop_run(cap.loop);
    if (g_main_context_find_source_by_id(NULL, watchdog)) {
        g_source_remove(watchdog);
    }

    g_assert_true(cap.fired);
    g_assert_cmpint(cap.kind, ==, REMOTE_PROBE_FAILED);
    g_assert_nonnull(cap.title);
    /*
     * The new direct probe always reports "Could not reach gateway
     * /health" on this path; the legacy "TCP connect to … succeeded"
     * wording must not appear, regardless of whether the failure is
     * connection-refused or response-timeout.
     */
    g_assert_nonnull(strstr(cap.title, "/health"));
    g_assert_null(strstr(cap.title, "TCP connect"));

    g_main_loop_unref(cap.loop);
    g_free(cap.title);
    g_free(cap.detail);
}

static void test_ssh_timeout_dominates_in_flight_health(void) {
    /*
     * Regression: when the SSH local-forward becomes ready and
     * gateway_http_check_health() is in flight, then the SSH probe
     * timeout fires, the operator-visible verdict must be
     * "SSH probe timed out" — not a downstream /health failure.
     *
     * Setup:
     *   - Fake ssh that opens a real listener on the chosen LOCAL
     *     port (parsed from -L) and accepts connections silently.
     *   - SIGTERM is trapped/ignored, so the probe's SIGKILL escalation
     *     is required to reap the process. This widens the window in
     *     which /health is in flight while ssh is still alive.
     *   - SSH probe timeout = 400 ms, well below the gateway_http
     *     internal /health timeout (~10 s) so the SSH timer always
     *     wins the race.
     *
     * Expectation:
     *   - REMOTE_PROBE_FAILED with title containing "timed out".
     *   - The title MUST NOT contain "/health" (that would mean the
     *     /health failure won the race against the SSH timeout).
     */
    g_autofree gchar *fake_ssh = write_health_hanging_script();
    remote_probe_test_set_ssh_binary(fake_ssh);
    remote_probe_test_set_ssh_timeout_ms(400);

    extern gint remote_port_check_pick_loopback_port(void);
    gint gateway_port = remote_port_check_pick_loopback_port();
    g_assert_cmpint(gateway_port, >, 0);

    ProbeCapture cap = {0};
    cap.loop = g_main_loop_new(NULL, FALSE);
    /*
     * 6s ceiling — plenty of slack above the 400 ms probe timeout
     * plus the SIGKILL grace, but well under the 10 s libsoup
     * /health timeout that would otherwise dominate this test.
     */
    guint watchdog = g_timeout_add(6000, watchdog_timeout, cap.loop);

    /* gateway_port > 0 selects the /health-via-forward probe path. */
    remote_probe_ssh_async("alice", "fake-host", 22, NULL, gateway_port, NULL,
                           on_probe_result, &cap);
    g_main_loop_run(cap.loop);
    if (g_main_context_find_source_by_id(NULL, watchdog)) {
        g_source_remove(watchdog);
    }

    g_assert_true(cap.fired);
    g_assert_cmpint(cap.kind, ==, REMOTE_PROBE_FAILED);
    g_assert_nonnull(cap.title);
    g_assert_nonnull(strstr(cap.title, "timed out"));
    /*
     * The /health verdict must NOT win — locks in the dominance fix
     * in on_ssh_forward_wait + on_forward_health.
     */
    g_assert_null(strstr(cap.title, "/health"));

    g_main_loop_unref(cap.loop);
    g_free(cap.title);
    g_free(cap.detail);
    remote_probe_test_set_ssh_binary(NULL);
    remote_probe_test_set_ssh_timeout_ms(0);
    g_unlink(fake_ssh);
}

/*
 * Deferred-quit capture: records the result like on_probe_result but
 * does NOT immediately quit the main loop. Used by tests that need
 * teardown_forward_ssh / SIGKILL escalation / on_ssh_forward_wait to
 * run AFTER result delivery (e.g. the deliver_keep + teardown forward-
 * budget path) so the test exercises the full free path and any
 * use-after-free regression would crash before we tear down.
 */
typedef struct {
    ProbeCapture cap;
    guint        defer_quit_id;
} DeferredProbeCapture;

static gboolean defer_quit_cb(gpointer user_data) {
    DeferredProbeCapture *d = (DeferredProbeCapture *)user_data;
    d->defer_quit_id = 0;
    g_main_loop_quit(d->cap.loop);
    return G_SOURCE_REMOVE;
}

static void on_probe_result_defer_quit(const RemoteProbeResult *result,
                                       gpointer user_data) {
    DeferredProbeCapture *d = (DeferredProbeCapture *)user_data;
    d->cap.fired = TRUE;
    d->cap.fired_at_us = g_get_monotonic_time();
    if (result) {
        d->cap.kind = result->kind;
        d->cap.title = g_strdup(result->title ? result->title : "");
        d->cap.detail = g_strdup(result->detail ? result->detail : "");
    }
    /*
     * Give the probe internals time to run teardown_forward_ssh,
     * SIGTERM/SIGKILL the fake ssh, and run on_ssh_forward_wait
     * (which is the sole owner that probe_ctx_free's after a
     * deliver_keep path). 1000 ms covers the default 500 ms
     * SIGKILL grace plus reap latency.
     */
    d->defer_quit_id = g_timeout_add(1000, defer_quit_cb, d);
}

static void test_ssh_forward_budget_failure_does_not_free_before_wait(void) {
    /*
     * Regression: on_forward_poll's PROBE_FORWARD_BUDGET_MS branch
     * previously called deliver(), which probe_ctx_free()'d ctx
     * BEFORE teardown_forward_ssh(ctx) and BEFORE the still-pending
     * g_subprocess_wait_async callback fired. That was a use-after-
     * free on both teardown_forward_ssh's ctx deref and on
     * on_ssh_forward_wait's user_data.
     *
     * Setup:
     *   - Fake ssh traps SIGTERM and sleeps 30s, never opening the
     *     forwarded listener.
     *   - SSH probe timeout = 10000 ms, which is ABOVE
     *     PROBE_FORWARD_BUDGET_MS (5000 ms) so the forward-budget
     *     branch fires first (not the generic ssh-timeout branch).
     *   - gateway_port > 0 selects the /health-via-forward path.
     *
     * Expectation:
     *   - REMOTE_PROBE_FAILED with title "SSH local-forward did not
     *     become ready" and detail containing "still not accepting".
     *   - No use-after-free / no abort during the deferred 1 s window
     *     while teardown + SIGKILL escalation + wait callback run.
     */
    g_autofree gchar *fake_ssh = write_sigterm_trapping_script(30);
    remote_probe_test_set_ssh_binary(fake_ssh);
    remote_probe_test_set_ssh_timeout_ms(10000);

    DeferredProbeCapture d = {0};
    d.cap.loop = g_main_loop_new(NULL, FALSE);
    /*
     * Watchdog ceiling: forward budget (~5 s) + SIGKILL grace (~500 ms)
     * + reap + deferred quit (1 s) + slack. 12 s is comfortable.
     */
    guint watchdog = g_timeout_add(12000, watchdog_timeout, d.cap.loop);

    remote_probe_ssh_async("alice", "fake-host", 22, NULL, 18789, NULL,
                           on_probe_result_defer_quit, &d);

    g_main_loop_run(d.cap.loop);

    if (g_main_context_find_source_by_id(NULL, watchdog)) {
        g_source_remove(watchdog);
    }
    if (d.defer_quit_id) {
        g_source_remove(d.defer_quit_id);
        d.defer_quit_id = 0;
    }

    g_assert_true(d.cap.fired);
    g_assert_cmpint(d.cap.kind, ==, REMOTE_PROBE_FAILED);
    g_assert_nonnull(d.cap.title);
    g_assert_nonnull(strstr(d.cap.title, "local-forward did not become ready"));
    g_assert_nonnull(d.cap.detail);
    g_assert_nonnull(strstr(d.cap.detail, "still not accepting"));

    g_main_loop_unref(d.cap.loop);
    g_free(d.cap.title);
    g_free(d.cap.detail);
    remote_probe_test_set_ssh_binary(NULL);
    remote_probe_test_set_ssh_timeout_ms(0);
    g_unlink(fake_ssh);
}

static gboolean swallow_expected_log(const gchar *log_domain,
                                     GLogLevelFlags log_level,
                                     const gchar *message,
                                     gpointer user_data) {
    (void)log_domain;
    (void)log_level;
    (void)user_data;
    /* The probe legitimately emits g_warning lines from both the
     * timeout and the SIGKILL escalation path. GTest treats g_warning
     * as fatal by default; swallow the lines we expect from this test. */
    if (message && strstr(message, "SSH probe exceeded")) return FALSE;
    if (message && strstr(message, "escalating to SIGKILL")) return FALSE;
    return TRUE;
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    /*
     * GTest installs a default always-fatal mask that promotes
     * g_warning to a process-level fatal. The probe legitimately
     * emits g_warning when the timeout fires and when it escalates,
     * so we relax the mask to ERROR/CRITICAL only and additionally
     * install a fatal-handler filter that swallows the expected lines.
     */
    g_log_set_always_fatal((GLogLevelFlags)(G_LOG_LEVEL_ERROR | G_LOG_LEVEL_CRITICAL));
    g_test_log_set_fatal_handler(swallow_expected_log, NULL);
    g_test_add_func("/remote_probe/ssh_times_out", test_ssh_probe_times_out);
    g_test_add_func("/remote_probe/ssh_escalates_on_trapped_sigterm",
                    test_ssh_probe_escalates_on_trapped_sigterm);
    g_test_add_func("/remote_probe/direct_health_failure_path",
                    test_direct_probe_health_failure_path);
    g_test_add_func("/remote_probe/ssh_timeout_dominates_in_flight_health",
                    test_ssh_timeout_dominates_in_flight_health);
    g_test_add_func("/remote_probe/ssh_forward_budget_failure_does_not_free_before_wait",
                    test_ssh_forward_budget_failure_does_not_free_before_wait);
    return g_test_run();
}
