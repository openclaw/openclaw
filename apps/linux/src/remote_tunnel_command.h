/*
 * remote_tunnel_command.h
 *
 * Pure-function builder for the /usr/bin/ssh argv that starts a
 * control-channel port-forwarding tunnel. Extracted into its own
 * translation unit so tests can exercise the argv contract without
 * spawning any process.
 *
 * The argv shape mirrors the macOS RemotePortTunnel:
 *
 *   /usr/bin/ssh
 *     -o BatchMode=yes
 *     -o ExitOnForwardFailure=yes
 *     -o ServerAliveInterval=15
 *     -o ServerAliveCountMax=3
 *     -o TCPKeepAlive=yes
 *     -o StrictHostKeyChecking=accept-new
 *     -o UpdateHostKeys=yes
 *     -N
 *     -L <local_port>:127.0.0.1:<remote_port>
 *     [-p <ssh_port>]
 *     [-i <identity_path>]
 *     [<user>@]<host>
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_REMOTE_TUNNEL_COMMAND_H
#define OPENCLAW_LINUX_REMOTE_TUNNEL_COMMAND_H

#include <glib.h>

typedef struct {
    const gchar *ssh_user;       /* nullable */
    const gchar *ssh_host;       /* required */
    gint         ssh_port;        /* 22 if not specified / <= 0 */
    const gchar *ssh_identity;   /* nullable; omitted when NULL/empty */
    gint         local_port;      /* > 0 */
    gint         remote_port;     /* > 0 */
} RemoteTunnelCommandSpec;

/* Build the argv vector, NULL-terminated. Returns a g_strv array (g_strfreev).
 * Returns NULL if the spec is invalid (missing host, invalid ports, etc.).
 */
gchar** remote_tunnel_command_build(const RemoteTunnelCommandSpec *spec);

/* Build a single string for diagnostic display (not for execution). Redacts
 * nothing — identity paths are sensitive but are already filesystem paths.
 */
gchar* remote_tunnel_command_to_string(gchar **argv);

#endif /* OPENCLAW_LINUX_REMOTE_TUNNEL_COMMAND_H */
