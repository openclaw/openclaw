/*
 * remote_tunnel_command.c
 *
 * Pure-function argv builder for the SSH control tunnel. See header.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "remote_tunnel_command.h"

static void push(GPtrArray *argv, const gchar *s) {
    g_ptr_array_add(argv, g_strdup(s));
}

gchar** remote_tunnel_command_build(const RemoteTunnelCommandSpec *spec) {
    if (!spec) return NULL;
    if (!spec->ssh_host || spec->ssh_host[0] == '\0') return NULL;
    /*
     * argv-smuggling guards. The trailing argv positional is rendered
     * as "[user@]host" and a leading '-' on either component would let
     * OpenSSH parse the destination as another option flag. We check
     * each parsed token here and re-validate the final rendered
     * destination below before pushing it to argv.
     */
    if (spec->ssh_host[0] == '-') return NULL;
    if (spec->ssh_user && spec->ssh_user[0] == '-') return NULL;
    if (spec->local_port <= 0 || spec->local_port > 65535) return NULL;
    if (spec->remote_port <= 0 || spec->remote_port > 65535) return NULL;

    GPtrArray *argv = g_ptr_array_new_with_free_func(g_free);

    push(argv, "/usr/bin/ssh");

    /* Mandatory connection options — mirror macOS RemotePortTunnel.create. */
    push(argv, "-o"); push(argv, "BatchMode=yes");
    push(argv, "-o"); push(argv, "ExitOnForwardFailure=yes");
    push(argv, "-o"); push(argv, "ServerAliveInterval=15");
    push(argv, "-o"); push(argv, "ServerAliveCountMax=3");
    push(argv, "-o"); push(argv, "TCPKeepAlive=yes");
    push(argv, "-o"); push(argv, "StrictHostKeyChecking=accept-new");
    push(argv, "-o"); push(argv, "UpdateHostKeys=yes");

    /* Forward-only, no remote command */
    push(argv, "-N");
    g_autofree gchar *forward = g_strdup_printf("%d:127.0.0.1:%d",
                                                spec->local_port, spec->remote_port);
    push(argv, "-L"); push(argv, forward);

    gint ssh_port = (spec->ssh_port > 0) ? spec->ssh_port : 22;
    if (ssh_port != 22) {
        g_autofree gchar *port_s = g_strdup_printf("%d", ssh_port);
        push(argv, "-p"); push(argv, port_s);
    }

    if (spec->ssh_identity && spec->ssh_identity[0] != '\0') {
        push(argv, "-i"); push(argv, spec->ssh_identity);
    }

    /*
     * [user@]host — always last to cap the argv.
     *
     * Final argv-boundary invariant: render the destination first, then
     * verify it does not begin with '-'. This locks the smuggling
     * invariant even if a future refactor splits the spec differently
     * or introduces another rendering path.
     */
    g_autofree gchar *destination =
        (spec->ssh_user && spec->ssh_user[0] != '\0')
            ? g_strdup_printf("%s@%s", spec->ssh_user, spec->ssh_host)
            : g_strdup(spec->ssh_host);
    if (!destination || destination[0] == '\0' || destination[0] == '-') {
        g_ptr_array_free(argv, TRUE);
        return NULL;
    }
    push(argv, destination);

    g_ptr_array_add(argv, NULL);
    return (gchar**)g_ptr_array_free(argv, FALSE);
}

gchar* remote_tunnel_command_to_string(gchar **argv) {
    if (!argv) return NULL;
    GString *out = g_string_new(NULL);
    for (gchar **p = argv; *p; p++) {
        if (out->len > 0) g_string_append_c(out, ' ');
        g_string_append(out, *p);
    }
    return g_string_free(out, FALSE);
}
