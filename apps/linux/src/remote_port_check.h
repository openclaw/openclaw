/*
 * remote_port_check.h
 *
 * Loopback port-availability probe for the remote tunnel.
 *
 * On macOS, RemotePortTunnel.portIsFree() probes both 127.0.0.1 and
 * ::1 because ssh's `-L` needs both address families free to bind.
 * This module provides the same guarantee for Linux via raw socket
 * bind attempts.
 *
 * Pure system-call layer; no GLib main loop required.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_REMOTE_PORT_CHECK_H
#define OPENCLAW_LINUX_REMOTE_PORT_CHECK_H

#include <glib.h>

/* Returns TRUE if both 127.0.0.1:port and [::1]:port are bindable right now. */
gboolean remote_port_check_loopback_free(gint port);

/* Attempts a short-lived TCP connect to 127.0.0.1:port. Returns TRUE if a
 * listener accepts the connection within `timeout_ms`. Used to validate
 * that a tunnel adopted across restarts still has a live listener. */
gboolean remote_port_check_loopback_listening(gint port, gint timeout_ms);

/*
 * Ask the kernel for an ephemeral free loopback port by binding
 * 127.0.0.1:0 and reading back the assigned port. Returns the port on
 * success or 0 on failure. The port is released back to the OS before
 * return; callers should treat the result as a hint and recover if a
 * subsequent bind/forward fails. Used by the remote SSH /health probe
 * to pick an ad-hoc local-forward port.
 */
gint remote_port_check_pick_loopback_port(void);

#endif /* OPENCLAW_LINUX_REMOTE_PORT_CHECK_H */
