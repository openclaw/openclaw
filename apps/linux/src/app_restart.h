/*
 * app_restart.h
 *
 * Implements the `Restart App` debug action: spawn a tiny detached
 * shell that waits 200 ms (so the current process can exit cleanly)
 * and then re-execs the companion at the same `/proc/self/exe` path,
 * then quits the current GApplication.
 *
 * The wait avoids racing the systemd / DBus session for the singleton
 * lock when a primary GApplication instance is in the middle of
 * shutting down.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_APP_RESTART_H
#define OPENCLAW_LINUX_APP_RESTART_H

#include <glib.h>

/*
 * Build the argv vector that `app_restart_request()` would pass to
 * `g_spawn_async`. Exposed as a separate function so the (deterministic,
 * hermetic) argv-builder logic can be unit tested without a fork or
 * spawn. Returns NULL when `self_exe` is NULL or empty. The returned
 * vector is suitable for `g_strfreev`.
 */
gchar** app_restart_build_argv_for_test(const gchar *self_exe);

/*
 * Resolve the current process's executable path, spawn the detached
 * relaunch shell, and request the running GApplication to quit (when
 * one is registered). Non-blocking — does not wait for the relaunched
 * child.
 *
 * Returns TRUE only when the spawn succeeded. Returns FALSE if the
 * self path could not be resolved or the spawn failed; in that case
 * the GApplication is NOT asked to quit, so the user is not stranded
 * with a closed app.
 */
gboolean app_restart_request(void);

#endif /* OPENCLAW_LINUX_APP_RESTART_H */
