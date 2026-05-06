/*
 * remote_tunnel.h
 *
 * Public API of the SSH control-tunnel supervisor. See remote_tunnel.c
 * for the engineering boundary note and the rationale for supervising
 * /usr/bin/ssh as a subprocess rather than linking libssh.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_REMOTE_TUNNEL_H
#define OPENCLAW_LINUX_REMOTE_TUNNEL_H

#include <glib.h>

typedef enum {
    REMOTE_TUNNEL_IDLE = 0,       /* not running, not requested */
    REMOTE_TUNNEL_STARTING,       /* spawn requested, awaiting grace period */
    REMOTE_TUNNEL_READY,          /* process alive after grace period       */
    REMOTE_TUNNEL_BACKOFF,        /* failed, retrying after a delay         */
    REMOTE_TUNNEL_FAILED,         /* unrecoverable (no retry policy applied) */
    REMOTE_TUNNEL_STOPPING,       /* SIGTERM issued, waiting for exit       */
} RemoteTunnelStateKind;

typedef struct {
    RemoteTunnelStateKind kind;
    gint local_port;              /* valid while STARTING/READY/STOPPING    */
    gint restart_count;           /* consecutive failed starts              */
    gint backoff_seconds;         /* current backoff value (if BACKOFF)     */
    const gchar *last_error;      /* nullable; truncated to single line     */
    gint64 ready_since_us;        /* g_get_monotonic_time() when READY      */
    gint   pid;                   /* tracked pid (diagnostics)              */
} RemoteTunnelState;

typedef void (*RemoteTunnelChangedFn)(gpointer user_data);

void remote_tunnel_init(void);
void remote_tunnel_shutdown(void);

/*
 * Configure the directory used to persist the runtime record
 * (see remote_tunnel.c for the engineering note on adoption).
 *
 * MUST be set before remote_tunnel_ensure() if adoption is desired.
 * If never set, adoption is disabled and ensure() always spawns afresh.
 */
void remote_tunnel_set_state_dir(const gchar *dir);

/*
 * Request an SSH control tunnel. Supervisor will spawn if not already
 * running with matching config, or adopt an existing run if the spec
 * is equivalent. local_port is the port to forward on 127.0.0.1;
 * remote_port is the port on the remote host (behind 127.0.0.1).
 *
 * The supervisor will emit state transitions via subscribers; callers
 * MUST NOT block waiting for a synchronous result.
 */
void remote_tunnel_ensure(const gchar *ssh_user,
                          const gchar *ssh_host,
                          gint         ssh_port,
                          const gchar *ssh_identity,
                          gint         local_port,
                          gint         remote_port);

/* Terminate the tunnel if running. Idempotent; safe to call in IDLE. */
void remote_tunnel_stop(void);

/* Force-kill without backoff bookkeeping (used by shutdown). */
void remote_tunnel_force_cleanup(void);

const RemoteTunnelState* remote_tunnel_get_state(void);

guint remote_tunnel_subscribe(RemoteTunnelChangedFn cb, gpointer user_data);
void  remote_tunnel_unsubscribe(guint subscription_id);

/* Test seams. Not meant for production call sites. */
void remote_tunnel_test_set_ssh_binary(const gchar *path);  /* NULL = reset */
void remote_tunnel_test_reset(void);

/*
 * Test-only override for the adopted-pid SIGKILL escalation grace
 * (default TUNNEL_ADOPT_KILL_GRACE_MS = 500 ms). Pass <=0 to reset.
 * The test for SIGTERM-resistant adopted ssh sets this to a small
 * value (e.g. 100 ms) so the regression test runs quickly.
 */
void remote_tunnel_test_set_adopt_kill_grace_ms(gint ms);

/*
 * Test-only: directly install an adopted pid + spec, bypassing the
 * runtime-record adoption path. Used by the SIGTERM-resistance
 * regression test to install a known long-lived child as the
 * "previous-generation" ssh process.
 */
void remote_tunnel_test_install_adopted(gint pid,
                                        const gchar *ssh_user,
                                        const gchar *ssh_host,
                                        gint ssh_port,
                                        const gchar *ssh_identity,
                                        gint local_port,
                                        gint remote_port);

const gchar* remote_tunnel_state_to_string(RemoteTunnelStateKind kind);

#endif /* OPENCLAW_LINUX_REMOTE_TUNNEL_H */
