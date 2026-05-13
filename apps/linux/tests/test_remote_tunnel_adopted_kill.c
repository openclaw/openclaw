/*
 * test_remote_tunnel_adopted_kill.c
 *
 * Regression: when remote_tunnel_stop() runs against an *adopted* ssh
 * pid (a process from a previous companion run that try_adopt() has
 * picked up rather than spawned), a SIGTERM-resistant process must be
 * escalated to SIGKILL so a mode flip cannot wedge the loopback port.
 *
 * The test spawns a small bash child that traps SIGTERM (and only
 * SIGTERM), installs it as the adopted pid via the test seam, sets a
 * very short SIGKILL grace, calls remote_tunnel_stop(), then asserts
 * the child has actually exited within a bounded wall-clock budget.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include "../src/remote_tunnel.h"

/* Spawn a bash child that traps SIGTERM and sleeps; returns its pid.
 * Uses /bin/sh -c with a heredoc-free one-liner so we don't depend on
 * test fixtures on disk. */
static gint spawn_sigterm_trap_child(void) {
    /*
     * The child:
     *   - traps SIGTERM with a no-op (so kill(pid, SIGTERM) is ignored)
     *   - sleeps 30s; only SIGKILL or natural exit will reap it.
     * We use `exec /bin/sleep` so the trapping shell is replaced by a
     * single sleep process that inherits the trap; SIGKILL is what we
     * are testing the escalation against.
     *
     * Note: the trap only applies to the shell process. After exec the
     * shell is gone — so technically once exec runs, the kernel default
     * disposition is restored. To make the trap "stick", we keep the
     * shell alive instead of exec'ing.
     */
    /*
     * Trap SIGTERM with a no-op so the shell ignores graceful kill;
     * only SIGKILL or natural exit reaps it. Redirect the inner
     * `sleep`'s stdio to /dev/null so meson's test runner does not
     * block waiting for those pipes to close after we kill the shell
     * (the orphaned sleep would otherwise hold the test stdout/stderr
     * pipes open for its full 30s, even though the test main has long
     * since exited).
     */
    const gchar *argv[] = {
        "/bin/sh",
        "-c",
        "trap '' TERM; sleep 30 </dev/null >/dev/null 2>&1",
        NULL,
    };

    GError *err = NULL;
    GPid pid = 0;
    gboolean ok = g_spawn_async(NULL,
                                (gchar **)argv,
                                NULL,
                                G_SPAWN_DO_NOT_REAP_CHILD,
                                NULL, NULL,
                                &pid, &err);
    if (!ok) {
        g_error("spawn fake adopted ssh: %s", err ? err->message : "?");
    }
    return (gint)pid;
}

/*
 * Reap-or-still-alive probe.
 *
 * Because we spawn with G_SPAWN_DO_NOT_REAP_CHILD, a SIGKILL'd child
 * becomes a zombie until something waits for it. kill(pid, 0) returns
 * 0 for both live processes and unreaped zombies, so it is NOT a
 * reliable death-detector here. Instead we poll waitpid(WNOHANG); a
 * non-zero return means the child has exited (and is now reaped), and
 * the status tells us *how*.
 */
typedef struct {
    GMainLoop *loop;
    gint pid;
    gboolean confirmed_killed;
    int wait_status;
    gint64 started_us;
} ProbeState;

static gboolean poll_child_dead(gpointer user_data) {
    ProbeState *st = (ProbeState *)user_data;
    int status = 0;
    pid_t r = waitpid((pid_t)st->pid, &status, WNOHANG);
    if (r == (pid_t)st->pid) {
        st->confirmed_killed = TRUE;
        st->wait_status = status;
        g_main_loop_quit(st->loop);
        return G_SOURCE_REMOVE;
    }
    /* 1500 ms ceiling — well above the 100 ms grace we configure. */
    if ((g_get_monotonic_time() - st->started_us) / 1000 > 1500) {
        g_main_loop_quit(st->loop);
        return G_SOURCE_REMOVE;
    }
    return G_SOURCE_CONTINUE;
}

static void test_stop_escalates_sigterm_resistant_adopted_to_sigkill(void) {
    gint pid = spawn_sigterm_trap_child();
    g_assert_cmpint(pid, >, 1);

    /* Give the child a moment to install its TERM trap. */
    g_usleep(50 * 1000);

    /* Make the SIGKILL escalation aggressive so the test runs fast. */
    remote_tunnel_test_set_adopt_kill_grace_ms(100);

    /* Install the child as the adopted ssh, with a plausible spec. */
    remote_tunnel_test_install_adopted(pid,
                                       "alice",
                                       "fake-host",
                                       22,
                                       NULL,
                                       /* local_port */ 18789,
                                       /* remote_port */ 18789);

    /* Trigger graceful stop: SIGTERM is delivered (trapped), then the
     * grace elapses and the implementation must escalate to SIGKILL. */
    remote_tunnel_stop();

    ProbeState st = { .pid = pid,
                      .started_us = g_get_monotonic_time(),
                      .loop = g_main_loop_new(NULL, FALSE) };
    g_timeout_add(20, poll_child_dead, &st);
    g_main_loop_run(st.loop);
    g_main_loop_unref(st.loop);

    /* The child must have died (waitpid reaped it within the budget). */
    g_assert_true(st.confirmed_killed);
    /* And it must have been killed by SIGKILL — not exited naturally. */
    g_assert_true(WIFSIGNALED(st.wait_status));
    g_assert_cmpint(WTERMSIG(st.wait_status), ==, SIGKILL);

    remote_tunnel_test_set_adopt_kill_grace_ms(0);
    remote_tunnel_test_reset();
}

static void test_force_cleanup_kills_pending_adopted_pid(void) {
    /*
     * Regression: remote_tunnel_stop() schedules a SIGKILL escalation
     * via the g_adopt_kill_pid timer. If remote_tunnel_force_cleanup()
     * runs before that timer fires (the most common race during a
     * mode flip or shutdown), the timer is cancelled — so previously
     * the SIGKILL never landed and a SIGTERM-resistant adopted ssh
     * survived, holding the loopback forward port hostage on the
     * subsequent run.
     *
     * After the fix, force_cleanup must deliver the promised SIGKILL
     * before clearing the pending pid, regardless of how soon it runs
     * after stop(). We use a generous 500 ms grace here to *increase*
     * the likelihood the timer hasn't fired yet — without the fix the
     * test would fail because the cancellation wins the race.
     */
    gint pid = spawn_sigterm_trap_child();
    g_assert_cmpint(pid, >, 1);

    g_usleep(50 * 1000);

    remote_tunnel_test_set_adopt_kill_grace_ms(500);

    remote_tunnel_test_install_adopted(pid,
                                       "alice",
                                       "fake-host",
                                       22,
                                       NULL,
                                       /* local_port */ 18789,
                                       /* remote_port */ 18789);

    /* Schedule the graceful kill (SIGTERM now, SIGKILL in 500 ms)… */
    remote_tunnel_stop();
    /* …then immediately ask force_cleanup to take the hard path. The
     * fix must SIGKILL the pending pid before discarding the timer. */
    remote_tunnel_force_cleanup();

    ProbeState st = { .pid = pid,
                      .started_us = g_get_monotonic_time(),
                      .loop = g_main_loop_new(NULL, FALSE) };
    g_timeout_add(20, poll_child_dead, &st);
    g_main_loop_run(st.loop);
    g_main_loop_unref(st.loop);

    g_assert_true(st.confirmed_killed);
    g_assert_true(WIFSIGNALED(st.wait_status));
    g_assert_cmpint(WTERMSIG(st.wait_status), ==, SIGKILL);

    remote_tunnel_test_set_adopt_kill_grace_ms(0);
    remote_tunnel_test_reset();
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    /*
     * The escalation path emits OC_LOG_WARN ("escalating to SIGKILL")
     * which routes through g_warning(). g_test_init makes WARNING
     * fatal by default — but here the warning is the very thing we
     * want to confirm fired, so relax the fatal mask.
     */
    g_log_set_always_fatal((GLogLevelFlags)(G_LOG_LEVEL_ERROR |
                                            G_LOG_LEVEL_CRITICAL));
    g_log_set_fatal_mask(NULL, (GLogLevelFlags)(G_LOG_LEVEL_ERROR |
                                                G_LOG_LEVEL_CRITICAL));
    g_test_add_func("/remote_tunnel/stop_escalates_adopted_to_sigkill",
                    test_stop_escalates_sigterm_resistant_adopted_to_sigkill);
    g_test_add_func("/remote_tunnel/force_cleanup_kills_pending_adopted_pid",
                    test_force_cleanup_kills_pending_adopted_pid);
    return g_test_run();
}
