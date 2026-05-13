/*
 * connection_mode_coordinator.c
 *
 * Orchestrates transitions between local and remote connection modes.
 * See header for the high-level contract.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "connection_mode_coordinator.h"

#include "log.h"
#include "remote_endpoint.h"
#include "remote_tunnel.h"

/* Forward declarations — provided by systemd.c. */
extern void systemd_stop_gateway(void);
extern void systemd_start_gateway(void);

typedef struct {
    ProductConnectionMode last_mode;
    RemoteTransport last_transport;
    gchar *last_ssh_signature;  /* user@host:port|identity|remote_port */
    gchar *last_direct_signature; /* host:port:tls:token:password */
    /* Credentials cached for the active SSH spec — used to refresh the
     * endpoint when the tunnel transitions READY asynchronously, since
     * the tunnel subsystem itself never sees the auth material. */
    gchar *cached_ssh_token;
    gchar *cached_ssh_password;
    gboolean initialized;
    guint tunnel_sub;
} CoordinatorState;

static CoordinatorState g_c = {
    .last_mode = PRODUCT_CONNECTION_MODE_UNSPECIFIED,
};

static void cached_ssh_credentials_clear(void) {
    if (g_c.cached_ssh_token) {
        volatile gchar *p = g_c.cached_ssh_token;
        while (*p) *p++ = '\0';
        g_clear_pointer(&g_c.cached_ssh_token, g_free);
    }
    if (g_c.cached_ssh_password) {
        volatile gchar *p = g_c.cached_ssh_password;
        while (*p) *p++ = '\0';
        g_clear_pointer(&g_c.cached_ssh_password, g_free);
    }
}

static void cached_ssh_credentials_set(const gchar *token, const gchar *password) {
    cached_ssh_credentials_clear();
    if (token && token[0] != '\0') g_c.cached_ssh_token = g_strdup(token);
    if (password && password[0] != '\0') g_c.cached_ssh_password = g_strdup(password);
}

static const RemoteTunnelState *tunnel_state_now(void) {
    return remote_tunnel_get_state();
}

static void on_tunnel_changed(gpointer user_data) {
    (void)user_data;
    /* Publish endpoint state derived from the tunnel state. */
    const RemoteTunnelState *ts = tunnel_state_now();
    if (!ts) return;

    switch (ts->kind) {
    case REMOTE_TUNNEL_STARTING:
    case REMOTE_TUNNEL_BACKOFF:
        remote_endpoint_set_connecting(
            ts->kind == REMOTE_TUNNEL_BACKOFF
                ? "Reconnecting SSH tunnel…"
                : "Starting SSH tunnel…");
        break;
    case REMOTE_TUNNEL_READY:
        /* Re-publish READY with the credentials cached for the active SSH
         * spec. The tunnel subsystem never sees auth material; the
         * coordinator owns it. */
        remote_endpoint_set_remote_ssh_ready(ts->local_port,
                                             g_c.cached_ssh_token,
                                             g_c.cached_ssh_password);
        break;
    case REMOTE_TUNNEL_FAILED:
        remote_endpoint_set_unavailable(
            ts->last_error ? ts->last_error : "SSH tunnel failed");
        break;
    case REMOTE_TUNNEL_STOPPING:
        remote_endpoint_set_connecting("Stopping SSH tunnel…");
        break;
    case REMOTE_TUNNEL_IDLE:
    default:
        /* IDLE while we are in remote+ssh means stop was requested externally;
         * the coordinator's apply() re-checks this on the next pass. */
        break;
    }
}

void connection_mode_coordinator_init(void) {
    if (g_c.initialized) return;
    g_c.initialized = TRUE;
    remote_endpoint_init();
    remote_tunnel_init();
    g_c.tunnel_sub = remote_tunnel_subscribe(on_tunnel_changed, NULL);
}

void connection_mode_coordinator_shutdown(void) {
    if (!g_c.initialized) return;
    if (g_c.tunnel_sub) {
        remote_tunnel_unsubscribe(g_c.tunnel_sub);
        g_c.tunnel_sub = 0;
    }
    remote_tunnel_stop();
    remote_endpoint_set_local();
    cached_ssh_credentials_clear();
    g_clear_pointer(&g_c.last_ssh_signature, g_free);
    g_clear_pointer(&g_c.last_direct_signature, g_free);
    g_c.last_mode = PRODUCT_CONNECTION_MODE_UNSPECIFIED;
    g_c.initialized = FALSE;
}

/*
 * Effective credential precedence used by the coordinator when the
 * *effective* mode is REMOTE (as resolved by connection_mode_resolver,
 * which may infer REMOTE from gateway.remote.url or from persisted
 * product state even when gateway.mode is absent).
 *
 * The gateway_config_remote_effective_{token,password}() helpers apply
 * the overlay only when config->mode == "remote", which is deliberately
 * narrower: those helpers are used by raw-config inspection paths. The
 * coordinator must instead trust the resolver's effective_mode and
 * prefer remote credentials whenever they are non-empty, falling back
 * to the local gateway.auth credential otherwise.
 *
 * Returning "" (never NULL) keeps the signature+publish call sites
 * simple — empty strings encode "no credential" the same way the
 * remote_endpoint/snapshot schema already does.
 */
static const gchar* coordinator_remote_token(const GatewayConfig *config) {
    if (!config) return "";
    if (config->remote_token && config->remote_token[0] != '\0') {
        return config->remote_token;
    }
    return config->token ? config->token : "";
}

static const gchar* coordinator_remote_password(const GatewayConfig *config) {
    if (!config) return "";
    if (config->remote_password && config->remote_password[0] != '\0') {
        return config->remote_password;
    }
    return config->password ? config->password : "";
}

static gchar* ssh_signature(const GatewayConfig *c) {
    if (!c) return g_strdup("");
    return g_strdup_printf(
        "%s|%s|%d|%s|%d|%d",
        c->remote_ssh_target_user ? c->remote_ssh_target_user : "",
        c->remote_ssh_target_host ? c->remote_ssh_target_host : "",
        c->remote_ssh_target_port,
        c->remote_ssh_identity ? c->remote_ssh_identity : "",
        c->port,
        GATEWAY_DEFAULT_PORT);
}

static gchar* direct_signature(const GatewayConfig *c) {
    if (!c) return g_strdup("");
    /*
     * Source the direct endpoint identity from the canonical
     * gateway.remote.url-derived fields, NOT from the in-place overlay
     * onto host/port/tls. This decouples the coordinator from the
     * overlay timing in gateway_config_load and means a config that
     * fails the overlay (e.g. missing required URL) cannot accidentally
     * cause the coordinator to publish a stale local endpoint.
     */
    const gchar *eff_token = coordinator_remote_token(c);
    const gchar *eff_password = coordinator_remote_password(c);
    return g_strdup_printf(
        "%s|%d|%d|%s|%s",
        c->remote_url_host ? c->remote_url_host : "",
        c->remote_url_port,
        c->remote_url_tls ? 1 : 0,
        eff_token ? eff_token : "",
        eff_password ? eff_password : "");
}

void connection_mode_coordinator_apply(const GatewayConfig *config,
                                       ProductConnectionMode effective_mode) {
    if (!g_c.initialized) connection_mode_coordinator_init();

    OC_LOG_INFO(OPENCLAW_LOG_CAT_REMOTE,
                "connection_mode_coordinator_apply effective_mode=%d valid=%d remote_transport=%d",
                (int)effective_mode,
                config ? (int)config->valid : 0,
                config ? config->remote_transport : -1);

    if (effective_mode != PRODUCT_CONNECTION_MODE_REMOTE) {
        /* LOCAL (or UNSPECIFIED treated as local) */
        gboolean was_remote = (g_c.last_mode == PRODUCT_CONNECTION_MODE_REMOTE);
        remote_tunnel_stop();
        remote_endpoint_set_local();
        cached_ssh_credentials_clear();
        g_clear_pointer(&g_c.last_ssh_signature, g_free);
        g_clear_pointer(&g_c.last_direct_signature, g_free);
        g_c.last_mode = PRODUCT_CONNECTION_MODE_LOCAL;
        /*
         * If we are flipping back to local after a remote session, the
         * REMOTE branch below called systemd_stop_gateway() on the
         * way in, so the local unit is likely inactive. Re-ensure it
         * here so the companion reconnects to the local gateway without
         * requiring the operator to click Start in the Dashboard. The
         * systemd StartUnit call is a no-op if the unit is already
         * active, which keeps this safe for first-time local boots too.
         */
        if (was_remote) {
            OC_LOG_INFO(OPENCLAW_LOG_CAT_REMOTE,
                        "connection_mode_coordinator remote→local transition — "
                        "re-ensuring local gateway unit");
            systemd_start_gateway();
        }
        return;
    }

    /* REMOTE */
    systemd_stop_gateway();

    if (!config || !config->valid || !config->remote_present) {
        remote_endpoint_set_unavailable(
            config && config->error
                ? config->error
                : "Remote mode is enabled but gateway.remote is not configured");
        remote_tunnel_stop();
        g_c.last_mode = PRODUCT_CONNECTION_MODE_REMOTE;
        return;
    }

    RemoteTransport transport = (RemoteTransport)config->remote_transport;
    g_c.last_transport = transport;

    if (transport == REMOTE_TRANSPORT_DIRECT) {
        /* No tunnel for direct transport. */
        remote_tunnel_stop();
        cached_ssh_credentials_clear();

        /*
         * Direct endpoint identity is the gateway.remote.url-derived
         * triple: (remote_url_host, remote_url_port, remote_url_tls).
         * If the URL is missing/invalid, gateway_config_load already
         * marked the config invalid and we wouldn't reach here.
         */
        if (!config->remote_url_host || !config->remote_url_host[0] ||
            config->remote_url_port <= 0) {
            remote_endpoint_set_unavailable(
                "Direct remote URL is missing or invalid");
            g_c.last_mode = PRODUCT_CONNECTION_MODE_REMOTE;
            return;
        }

        g_autofree gchar *sig = direct_signature(config);
        if (g_strcmp0(sig, g_c.last_direct_signature) != 0 ||
            g_c.last_mode != PRODUCT_CONNECTION_MODE_REMOTE) {
            g_free(g_c.last_direct_signature);
            g_c.last_direct_signature = g_strdup(sig);
            g_clear_pointer(&g_c.last_ssh_signature, g_free);
        }
        remote_endpoint_set_remote_direct_ready(
            config->remote_url_host,
            config->remote_url_port,
            config->remote_url_tls,
            coordinator_remote_token(config),
            coordinator_remote_password(config));
        g_c.last_mode = PRODUCT_CONNECTION_MODE_REMOTE;
        return;
    }

    /* REMOTE_TRANSPORT_SSH */
    if (!config->remote_ssh_target_host) {
        remote_endpoint_set_unavailable("SSH target missing");
        g_c.last_mode = PRODUCT_CONNECTION_MODE_REMOTE;
        return;
    }

    g_autofree gchar *sig = ssh_signature(config);
    gboolean spec_changed = g_strcmp0(sig, g_c.last_ssh_signature) != 0;
    if (spec_changed) {
        g_free(g_c.last_ssh_signature);
        g_c.last_ssh_signature = g_strdup(sig);
        g_clear_pointer(&g_c.last_direct_signature, g_free);
    }

    /*
     * Always refresh the cached credentials on the active spec — the
     * operator may rotate the gateway token while the SSH target stays
     * the same. The tunnel subscriber will fold these into the next
     * REMOTE_TUNNEL_READY republish.
     */
    cached_ssh_credentials_set(coordinator_remote_token(config),
                               coordinator_remote_password(config));

    /*
     * Push a CONNECTING state eagerly so the UI can reflect the transition
     * even before the tunnel has started its spawn callback. The tunnel
     * subscriber will refine this to READY / UNAVAILABLE as events arrive.
     */
    remote_endpoint_set_connecting("Starting SSH tunnel…");

    /* Local port is config->port; remote port is the gateway's configured
     * port on the remote host (same value unless the operator overrides). */
    const gint local_port = config->port;
    const gint remote_port = config->port;

    remote_tunnel_ensure(config->remote_ssh_target_user,
                         config->remote_ssh_target_host,
                         config->remote_ssh_target_port,
                         config->remote_ssh_identity,
                         local_port,
                         remote_port);

    /* If tunnel reported READY synchronously (cached state), publish the
     * endpoint immediately with the current credentials. */
    const RemoteTunnelState *ts = remote_tunnel_get_state();
    if (ts && ts->kind == REMOTE_TUNNEL_READY) {
        remote_endpoint_set_remote_ssh_ready(
            ts->local_port,
            coordinator_remote_token(config),
            coordinator_remote_password(config));
    }

    g_c.last_mode = PRODUCT_CONNECTION_MODE_REMOTE;
}
