/*
 * app_restart.c
 *
 * Implementation of the Restart App helper. See app_restart.h.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "app_restart.h"

#include <gio/gio.h>
#include <glib.h>

/*
 * The relaunch shell snippet. Using `exec "$1"` keeps argv[0] set to
 * the original self_exe path (better for any internal lookups that
 * read /proc/self/exe). A short sleep gives the current GApplication
 * time to release its session-bus name before the relaunch.
 */
#define APP_RESTART_SHELL_SNIPPET "sleep 0.2; exec \"$1\""

gchar** app_restart_build_argv_for_test(const gchar *self_exe) {
    if (!self_exe || self_exe[0] == '\0') return NULL;

    /* argv layout (NULL-terminated, suitable for g_spawn_async +
     * G_SPAWN_SEARCH_PATH):
     *
     *   [0] /bin/sh
     *   [1] -c
     *   [2] sleep 0.2; exec "$1"
     *   [3] sh                           ← shell argv[0] / "$0"
     *   [4] <self_exe>                   ← becomes "$1"
     *   [5] NULL
     */
    gchar **argv = g_new0(gchar *, 6);
    argv[0] = g_strdup("/bin/sh");
    argv[1] = g_strdup("-c");
    argv[2] = g_strdup(APP_RESTART_SHELL_SNIPPET);
    argv[3] = g_strdup("sh");
    argv[4] = g_strdup(self_exe);
    argv[5] = NULL;
    return argv;
}

gboolean app_restart_request(void) {
    g_autofree gchar *self_exe = g_file_read_link("/proc/self/exe", NULL);
    if (!self_exe || self_exe[0] == '\0') {
        g_warning("app_restart_request: failed to resolve /proc/self/exe");
        return FALSE;
    }

    g_auto(GStrv) argv = app_restart_build_argv_for_test(self_exe);
    if (!argv) return FALSE;

    g_autoptr(GError) error = NULL;
    gboolean ok = g_spawn_async(NULL,                         /* working dir */
                                argv,
                                NULL,                         /* envp */
                                G_SPAWN_SEARCH_PATH,
                                NULL,                         /* child setup */
                                NULL,
                                NULL,                         /* child pid */
                                &error);
    if (!ok) {
        g_warning("app_restart_request: g_spawn_async failed: %s",
                  error ? error->message : "(unknown)");
        return FALSE;
    }

    GApplication *app = g_application_get_default();
    if (app && g_application_get_is_registered(app)) {
        g_application_quit(app);
    }
    return TRUE;
}
