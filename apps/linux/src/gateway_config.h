/*
 * gateway_config.h
 *
 * Gateway configuration resolution for the OpenClaw Linux Companion App.
 *
 * Reads the existing OpenClaw config format (~/.openclaw/openclaw.json)
 * and resolves only the local-mode data needed for Linux MVP:
 * mode, effective local bind/host, effective port, and auth material.
 *
 * Auth is read from `gateway.auth.mode`, `gateway.auth.token`,
 * `gateway.auth.password` — the same schema used by the gateway server
 * and the macOS app. Environment variables OPENCLAW_GATEWAY_TOKEN and
 * OPENCLAW_GATEWAY_PASSWORD act as overrides only.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_CONFIG_H
#define OPENCLAW_LINUX_GATEWAY_CONFIG_H

#include <glib.h>

#define GATEWAY_DEFAULT_PORT 18789
#define GATEWAY_DEFAULT_HOST "127.0.0.1"

typedef enum {
    GW_CFG_OK = 0,
    GW_CFG_ERR_NO_HOME,
    GW_CFG_ERR_PARSE,
    GW_CFG_ERR_NOT_OBJECT,
    GW_CFG_ERR_GATEWAY_NOT_OBJECT,    /* E1 */
    GW_CFG_ERR_MODE_INVALID,            /* E2 */
    GW_CFG_ERR_MODE_UNSUPPORTED,
    GW_CFG_ERR_AUTH_NOT_OBJECT,         /* E3 */
    GW_CFG_ERR_AUTH_MODE_INVALID,       /* E4 */
    GW_CFG_ERR_AUTH_AMBIGUOUS,          /* E5 */
    GW_CFG_ERR_PORT_INVALID,            /* E6 */
    GW_CFG_ERR_AUTH_MODE_UNSUPPORTED,
    GW_CFG_ERR_TOKEN_MISSING,
    GW_CFG_ERR_PASSWORD_MISSING,
    GW_CFG_ERR_BIND_INVALID,
    GW_CFG_ERR_READ_FAILED,
    GW_CFG_ERR_SECRET_REF_UNSUPPORTED,
    /* Remote-mode errors (Tranche: Remote Connection Mode) */
    GW_CFG_ERR_REMOTE_NOT_OBJECT,       /* gateway.remote is not an object         */
    GW_CFG_ERR_REMOTE_TRANSPORT_INVALID,/* gateway.remote.transport not a string   */
    GW_CFG_ERR_REMOTE_URL_INVALID,      /* gateway.remote.url fails normalization  */
    GW_CFG_ERR_REMOTE_TARGET_INVALID,   /* gateway.remote.sshTarget fails parse    */
    GW_CFG_ERR_REMOTE_URL_REQUIRED,     /* direct transport but no URL             */
    GW_CFG_ERR_REMOTE_TARGET_REQUIRED,  /* ssh transport but no sshTarget          */
} GatewayConfigError;

typedef struct {
    const gchar *explicit_config_path;
    const gchar *effective_state_dir;
    const gchar *profile;
} GatewayConfigContext;

typedef struct {
    gchar *mode;           /* gateway.mode: "local" or other (NULL treated as local) */
    gchar *host;           /* effective client endpoint host (default 127.0.0.1) */
    gint port;             /* effective port (default 18789) */
    gboolean tls_enabled;  /* L6: TLS enablement from gateway.tls or gateway.security.tls */
    gchar *auth_mode;      /* gateway.auth.mode: "token", "password", "none" */
    gchar *token;          /* resolved auth token (config + env override) */
    gchar *password;       /* resolved auth password (config + env override) */
    gboolean token_is_secret_ref;
    gboolean password_is_secret_ref;
    gchar *control_ui_base_path; /* gateway.controlUi.basePath (NULL => "/") */
    gchar *config_path;    /* resolved config file path */
    gboolean valid;        /* whether config was loaded successfully */
    GatewayConfigError error_code; /* stable error discriminator */
    gchar *error;          /* human-readable error message */
    gboolean has_model_config; /* compatibility aggregate: provider/default model present */
    gboolean has_provider_config; /* config declares at least one provider */
    gboolean has_default_model_config; /* config declares a default/primary model */
    gchar *configured_default_model_id; /* parsed default model id when present */

    /* Feature B: Wizard onboard marker fields */
    gboolean has_wizard_onboard_marker;
    gboolean wizard_is_local;
    gchar *wizard_last_run_command;
    gchar *wizard_last_run_at;
    gchar *wizard_last_run_mode;
    gchar *wizard_marker_fail_reason;

    /* Remote mode (Tranche: Remote Connection Mode).
     *
     * Populated from gateway.remote.* when the `remote` subtree is
     * present. Empty / zeroed when absent. All fields are heap-owned.
     *
     * For effective-mode=remote runs, these fields drive the endpoint
     * resolution performed by the coordinator / remote_endpoint layer.
     * See gateway_remote_config.h for field semantics.
     */
    gboolean remote_present;      /* TRUE iff gateway.remote object existed */
    gint remote_transport;        /* RemoteTransport value (0=ssh, 1=direct) */
    gchar *remote_url;            /* normalized ws[s]://host:port; NULL when absent */
    gchar *remote_url_host;
    gint remote_url_port;
    gboolean remote_url_tls;
    gchar *remote_ssh_target;     /* normalized user@host:port */
    gchar *remote_ssh_target_host;
    gint remote_ssh_target_port;
    gchar *remote_ssh_target_user; /* may be NULL */
    gchar *remote_ssh_identity;
    gchar *remote_token;          /* from gateway.remote.token (optional) */
    gchar *remote_password;       /* from gateway.remote.password (optional) */
} GatewayConfig;

GatewayConfig* gateway_config_load(const GatewayConfigContext *ctx);
void gateway_config_free(GatewayConfig *config);
gboolean gateway_config_is_local(const GatewayConfig *config);
gboolean gateway_config_is_remote(const GatewayConfig *config);
gchar* gateway_config_http_url(const GatewayConfig *config);
gchar* gateway_config_ws_url(const GatewayConfig *config);
gboolean gateway_config_equivalent(const GatewayConfig *a, const GatewayConfig *b);
gchar* gateway_config_dashboard_url(const GatewayConfig *config);
gchar* gateway_config_dashboard_url_with_route(const gchar *base_url, const gchar *route);

gchar* gateway_config_resolve_path(const GatewayConfigContext *ctx);
void gateway_config_free_resolved_path(gchar *path);

/*
 * Write/merge the gateway.remote.* subtree into the effective config
 * file. Existing top-level keys (port, tls, token, password, etc.) are
 * preserved. If `mode` is "local", "remote", or NULL, the gateway.mode
 * field is updated accordingly (NULL leaves the existing value alone).
 *
 * Inputs other than `transport` may be NULL/empty to remove the
 * corresponding remote.* member.
 *
 * Returns TRUE on success. On failure, *out_error is set (caller
 * frees) and the file is left unmodified.
 */
gboolean gateway_config_write_remote_settings(const gchar *config_path,
                                              const gchar *mode,
                                              const gchar *transport,
                                              const gchar *url,
                                              const gchar *ssh_target,
                                              const gchar *ssh_identity,
                                              const gchar *remote_token,
                                              const gchar *remote_password,
                                              gchar **out_error);

/*
 * Effective-token/password helpers.
 *
 * Document and centralize the remote-overlay precedence used by
 * gateway_config_load when gateway.mode == "remote":
 *
 *   - if config is in remote mode and gateway.remote.token is non-empty,
 *     the effective token is gateway.remote.token;
 *   - otherwise the effective token is the local gateway.auth.token.
 *
 * The same rule applies to passwords. These helpers must be safe to call
 * before validate_auth runs (i.e. for inspecting raw parser output) and
 * after gateway_config_load has applied the in-place overlay (the
 * overlay makes these helpers idempotent).
 *
 * Returns a borrowed pointer into the GatewayConfig; never NULL but may
 * be the empty string. Caller must not free.
 */
const gchar* gateway_config_remote_effective_token(const GatewayConfig *config);
const gchar* gateway_config_remote_effective_password(const GatewayConfig *config);

#endif /* OPENCLAW_LINUX_GATEWAY_CONFIG_H */
