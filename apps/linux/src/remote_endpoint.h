/*
 * remote_endpoint.h
 *
 * Endpoint state machine for the OpenClaw Linux Companion App.
 *
 * Mirrors the role of macOS GatewayEndpointStore: a single source of
 * truth that answers "what URL and credentials should gateway_client
 * connect to right now?" across local and remote modes.
 *
 * State machine:
 *
 *   IDLE           — local mode; endpoint does not own the URL. gateway_client
 *                    reads from GatewayConfig directly.
 *   CONNECTING     — remote mode; tunnel is being ensured.
 *   READY          — remote mode; host/port/tls/token are valid for use.
 *   UNAVAILABLE    — remote mode; reason carries the failure detail.
 *
 * gateway_client subscribes to changes and rebuilds its transport on
 * every ready ↔ unavailable transition.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_REMOTE_ENDPOINT_H
#define OPENCLAW_LINUX_REMOTE_ENDPOINT_H

#include <glib.h>

#include "gateway_remote_config.h"
#include "product_state.h"

typedef enum {
    REMOTE_ENDPOINT_IDLE = 0,
    REMOTE_ENDPOINT_CONNECTING,
    REMOTE_ENDPOINT_READY,
    REMOTE_ENDPOINT_UNAVAILABLE,
} RemoteEndpointStateKind;

typedef struct {
    RemoteEndpointStateKind kind;
    /* READY fields (strings owned by the module). */
    const gchar *host;
    gint         port;
    gboolean     tls;
    const gchar *token;
    const gchar *password;
    /* CONNECTING / UNAVAILABLE fields. */
    const gchar *detail;
} RemoteEndpointSnapshot;

typedef void (*RemoteEndpointChangedFn)(gpointer user_data);

void remote_endpoint_init(void);
void remote_endpoint_shutdown(void);

/*
 * Publish a LOCAL (idle) state — clears all remote fields. Called by
 * the coordinator when transitioning into local mode.
 */
void remote_endpoint_set_local(void);

/*
 * Publish a REMOTE+DIRECT READY state. Synchronous and immediate —
 * direct transport has no tunnel to wait for.
 */
void remote_endpoint_set_remote_direct_ready(const gchar *host,
                                             gint         port,
                                             gboolean     tls,
                                             const gchar *token,
                                             const gchar *password);

/* Publish a CONNECTING state with operator-visible detail. */
void remote_endpoint_set_connecting(const gchar *detail);

/*
 * Publish a REMOTE+SSH READY state. Host is always 127.0.0.1 (loopback
 * of the SSH local-forward); port is the forwarded local port; tls is
 * always FALSE; token/password are the per-mode credentials.
 */
void remote_endpoint_set_remote_ssh_ready(gint         local_port,
                                          const gchar *token,
                                          const gchar *password);

/* Publish an UNAVAILABLE state with a human-readable reason. */
void remote_endpoint_set_unavailable(const gchar *reason);

const RemoteEndpointSnapshot* remote_endpoint_get(void);

guint remote_endpoint_subscribe(RemoteEndpointChangedFn cb, gpointer user_data);
void  remote_endpoint_unsubscribe(guint subscription_id);

const gchar* remote_endpoint_state_to_string(RemoteEndpointStateKind kind);

#endif /* OPENCLAW_LINUX_REMOTE_ENDPOINT_H */
