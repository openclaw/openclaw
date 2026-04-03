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
    GW_CFG_ERR_READ_FAILED,
    GW_CFG_ERR_SECRET_REF_UNSUPPORTED,
} GatewayConfigError;

typedef struct {
    const gchar *explicit_config_path;
    const gchar *effective_state_dir;
    const gchar *profile;
} GatewayConfigContext;

typedef struct {
    gchar *mode;           /* gateway.mode: "local" or other (NULL treated as local) */
    gchar *host;           /* effective bind host (default 127.0.0.1) */
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
} GatewayConfig;

GatewayConfig* gateway_config_load(const GatewayConfigContext *ctx);
void gateway_config_free(GatewayConfig *config);
gboolean gateway_config_is_local(const GatewayConfig *config);
gchar* gateway_config_http_url(const GatewayConfig *config);
gchar* gateway_config_ws_url(const GatewayConfig *config);
gboolean gateway_config_equivalent(const GatewayConfig *a, const GatewayConfig *b);
gchar* gateway_config_dashboard_url(const GatewayConfig *config);

#endif /* OPENCLAW_LINUX_GATEWAY_CONFIG_H */
