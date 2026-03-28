/*
 * gateway_config.c
 *
 * Gateway configuration resolution for the OpenClaw Linux Companion App.
 *
 * Reads the existing OpenClaw config format (~/.openclaw/openclaw.json, JSON)
 * — the same format already used by the gateway and the macOS app.
 * Resolves only the local-mode data needed for Linux MVP:
 * mode, effective local bind/host, effective port, auth material.
 *
 * Auth is parsed from `gateway.auth.mode`, `gateway.auth.token`,
 * `gateway.auth.password` — matching the GatewayAuthConfig schema in
 * src/config/types.gateway.ts and the macOS loader in GatewayConfig.swift.
 * Environment variables OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PASSWORD
 * act as overrides, not as the primary source.
 *
 * Rejects or clearly surfaces non-local / unsupported configurations.
 * Does not introduce a Linux-only config schema.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_config.h"
#include "log.h"
#include <json-glib/json-glib.h>
#include <string.h>

static gchar* resolve_config_path(void) {
    const gchar *override = g_getenv("OPENCLAW_CONFIG_PATH");
    if (override && override[0] != '\0') {
        return g_strdup(override);
    }

    const gchar *state_dir_override = g_getenv("OPENCLAW_STATE_DIR");
    if (state_dir_override && state_dir_override[0] != '\0') {
        return g_build_filename(state_dir_override, "openclaw.json", NULL);
    }

    const gchar *home_override = g_getenv("OPENCLAW_HOME");
    const gchar *home = home_override && home_override[0] != '\0' ? home_override : g_get_home_dir();
    if (!home) {
        return NULL;
    }

    /* Primary: ~/.openclaw/openclaw.json */
    gchar *primary = g_build_filename(home, ".openclaw", "openclaw.json", NULL);
    if (g_file_test(primary, G_FILE_TEST_EXISTS)) {
        return primary;
    }
    g_free(primary);

    /* Legacy fallback candidates */
    static const gchar *legacy_dirs[] = { ".clawdbot", ".moldbot", NULL };
    static const gchar *legacy_names[] = { "openclaw.json", "clawdbot.json", "moldbot.json", NULL };

    for (gint d = 0; legacy_dirs[d]; d++) {
        for (gint n = 0; legacy_names[n]; n++) {
            gchar *candidate = g_build_filename(home, legacy_dirs[d], legacy_names[n], NULL);
            if (g_file_test(candidate, G_FILE_TEST_EXISTS)) {
                return candidate;
            }
            g_free(candidate);
        }
    }

    /* Default (may not exist yet) */
    return g_build_filename(home, ".openclaw", "openclaw.json", NULL);
}

static gint resolve_port(JsonObject *gateway_obj) {
    const gchar *env_port = g_getenv("OPENCLAW_GATEWAY_PORT");
    if (env_port && env_port[0] != '\0') {
        gint64 parsed = g_ascii_strtoll(env_port, NULL, 10);
        if (parsed > 0 && parsed <= 65535) {
            return (gint)parsed;
        }
    }

    if (gateway_obj && json_object_has_member(gateway_obj, "port")) {
        gint64 port = json_object_get_int_member(gateway_obj, "port");
        if (port > 0 && port <= 65535) {
            return (gint)port;
        }
    }

    return GATEWAY_DEFAULT_PORT;
}

/*
 * Resolve auth from gateway.auth.* config + env overrides.
 * Matches the schema in types.gateway.ts:GatewayAuthConfig and the
 * macOS loader in GatewayConfig.swift:38-41.
 *
 * Precedence for token: OPENCLAW_GATEWAY_TOKEN env > gateway.auth.token config
 * Precedence for password: OPENCLAW_GATEWAY_PASSWORD env > gateway.auth.password config
 * Auth mode: gateway.auth.mode config, inferred from available credentials if absent.
 */
static void resolve_auth(JsonObject *auth_obj, GatewayConfig *config) {
    /* 1. Read config values */
    gchar *cfg_auth_mode = NULL;
    gchar *cfg_token = NULL;
    gchar *cfg_password = NULL;

    if (auth_obj) {
        if (json_object_has_member(auth_obj, "mode")) {
            const gchar *mode = json_object_get_string_member(auth_obj, "mode");
            if (mode && mode[0] != '\0') {
                cfg_auth_mode = g_strdup(mode);
            }
        }
        if (json_object_has_member(auth_obj, "token")) {
            const gchar *tok = json_object_get_string_member(auth_obj, "token");
            if (tok && tok[0] != '\0') {
                cfg_token = g_strdup(tok);
            }
        }
        if (json_object_has_member(auth_obj, "password")) {
            const gchar *pw = json_object_get_string_member(auth_obj, "password");
            if (pw && pw[0] != '\0') {
                cfg_password = g_strdup(pw);
            }
        }
    }

    /* 2. Apply env overrides */
    const gchar *env_token = g_getenv("OPENCLAW_GATEWAY_TOKEN");
    if (env_token && env_token[0] != '\0') {
        g_free(cfg_token);
        cfg_token = g_strdup(env_token);
    }

    const gchar *env_password = g_getenv("OPENCLAW_GATEWAY_PASSWORD");
    if (env_password && env_password[0] != '\0') {
        g_free(cfg_password);
        cfg_password = g_strdup(env_password);
    }

    /* 3. Infer auth_mode if not explicitly set (matches gateway server auth.ts:256-268) */
    if (!cfg_auth_mode) {
        if (cfg_password) {
            cfg_auth_mode = g_strdup("password");
        } else if (cfg_token) {
            cfg_auth_mode = g_strdup("token");
        } else {
            cfg_auth_mode = g_strdup("token");
        }
    }

    config->auth_mode = cfg_auth_mode;
    config->token = cfg_token;
    config->password = cfg_password;
}

/*
 * Validate resolved auth: ensure required credentials are present for the mode.
 * Returns TRUE if valid, FALSE and sets error_code/error if not.
 */
static gboolean validate_auth(GatewayConfig *config) {
    /* Reject unsupported auth modes for Linux MVP */
    if (g_strcmp0(config->auth_mode, "token") != 0 &&
        g_strcmp0(config->auth_mode, "password") != 0 &&
        g_strcmp0(config->auth_mode, "none") != 0) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_AUTH_MODE_UNSUPPORTED;
        config->error = g_strdup_printf(
            "Unsupported gateway auth mode for Linux MVP: '%s' (supported: token, password, none)",
            config->auth_mode);
        return FALSE;
    }

    if (g_strcmp0(config->auth_mode, "token") == 0 && !config->token) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_TOKEN_MISSING;
        config->error = g_strdup(
            "Gateway auth mode is token, but no token was configured "
            "(set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)");
        return FALSE;
    }

    if (g_strcmp0(config->auth_mode, "password") == 0 && !config->password) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_PASSWORD_MISSING;
        config->error = g_strdup(
            "Gateway auth mode is password, but no password was configured "
            "(set gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD)");
        return FALSE;
    }

    return TRUE;
}

GatewayConfig* gateway_config_load(void) {
    GatewayConfig *config = g_new0(GatewayConfig, 1);
    config->host = g_strdup(GATEWAY_DEFAULT_HOST);
    config->port = GATEWAY_DEFAULT_PORT;
    config->error_code = GW_CFG_OK;
    config->config_path = resolve_config_path();

    if (!config->config_path) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_NO_HOME;
        config->error = g_strdup("Could not resolve config file path (no home directory)");
        return config;
    }

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "gateway_config_load path=%s", config->config_path);

    gchar *contents = NULL;
    g_autoptr(GError) read_error = NULL;
    if (!g_file_get_contents(config->config_path, &contents, NULL, &read_error)) {
        if (g_error_matches(read_error, G_FILE_ERROR, G_FILE_ERROR_NOENT)) {
            /* Config file not existing is valid — use defaults + env overrides */
            config->port = resolve_port(NULL);
            resolve_auth(NULL, config);
            if (!validate_auth(config)) return config;
            config->valid = TRUE;
            OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                      "gateway_config_load no config file, defaults port=%d auth_mode=%s",
                      config->port, config->auth_mode);
            return config;
        } else {
            /* Other read errors (permission denied, etc) are explicitly invalid */
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_READ_FAILED;
            config->error = g_strdup_printf("Failed to read config: %s", read_error->message);
            return config;
        }
    }

    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) parse_error = NULL;
    if (!json_parser_load_from_data(parser, contents, -1, &parse_error)) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_PARSE;
        config->error = g_strdup_printf("Config parse error: %s", parse_error->message);
        g_free(contents);
        return config;
    }
    g_free(contents);

    JsonNode *root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_NOT_OBJECT;
        config->error = g_strdup("Config root is not a JSON object");
        return config;
    }

    JsonObject *root_obj = json_node_get_object(root);
    JsonObject *gateway_obj = NULL;
    if (json_object_has_member(root_obj, "gateway")) {
        gateway_obj = json_object_get_object_member(root_obj, "gateway");
    }

    /* Resolve mode */
    if (gateway_obj && json_object_has_member(gateway_obj, "mode")) {
        const gchar *mode = json_object_get_string_member(gateway_obj, "mode");
        if (mode && mode[0] != '\0') {
            config->mode = g_strdup(mode);
        }
    }

    /* Reject non-local modes for Linux MVP */
    if (config->mode && g_strcmp0(config->mode, "local") != 0) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_MODE_UNSUPPORTED;
        config->error = g_strdup_printf(
            "Unsupported gateway mode for Linux MVP: '%s' (only 'local' is supported)",
            config->mode);
        return config;
    }

    /* Resolve port */
    config->port = resolve_port(gateway_obj);

    /* Resolve host (local mode always binds to loopback for MVP) */
    g_free(config->host);
    config->host = g_strdup(GATEWAY_DEFAULT_HOST);

    /* Resolve auth from gateway.auth.* + env overrides */
    JsonObject *auth_obj = NULL;
    if (gateway_obj && json_object_has_member(gateway_obj, "auth")) {
        auth_obj = json_object_get_object_member(gateway_obj, "auth");
    }
    resolve_auth(auth_obj, config);
    if (!validate_auth(config)) return config;

    config->valid = TRUE;
    config->error_code = GW_CFG_OK;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
              "gateway_config_load valid host=%s port=%d auth_mode=%s has_token=%d",
              config->host, config->port, config->auth_mode, config->token != NULL);
    return config;
}

void gateway_config_free(GatewayConfig *config) {
    if (!config) return;
    g_free(config->mode);
    g_free(config->host);
    g_free(config->auth_mode);
    g_free(config->token);
    g_free(config->password);
    g_free(config->config_path);
    g_free(config->error);
    g_free(config);
}

gboolean gateway_config_is_local(const GatewayConfig *config) {
    if (!config) return TRUE;
    return (config->mode == NULL || g_strcmp0(config->mode, "local") == 0);
}

gchar* gateway_config_http_url(const GatewayConfig *config) {
    if (!config) return NULL;
    return g_strdup_printf("http://%s:%d", config->host, config->port);
}

gchar* gateway_config_ws_url(const GatewayConfig *config) {
    if (!config) return NULL;
    return g_strdup_printf("ws://%s:%d", config->host, config->port);
}

gboolean gateway_config_equivalent(const GatewayConfig *a, const GatewayConfig *b) {
    if (a == b) return TRUE;
    if (!a || !b) return FALSE;

    /* valid flag */
    if (a->valid != b->valid) return FALSE;

    /* error_code — different invalid reasons are not equivalent */
    if (a->error_code != b->error_code) return FALSE;

    /* mode */
    if (g_strcmp0(a->mode, b->mode) != 0) return FALSE;

    /* host + port */
    if (g_strcmp0(a->host, b->host) != 0) return FALSE;
    if (a->port != b->port) return FALSE;

    /* auth_mode */
    if (g_strcmp0(a->auth_mode, b->auth_mode) != 0) return FALSE;

    /* credentials */
    if (g_strcmp0(a->token, b->token) != 0) return FALSE;
    if (g_strcmp0(a->password, b->password) != 0) return FALSE;

    /* Derived normalized URLs (catches any normalization edge cases) */
    g_autofree gchar *a_http = gateway_config_http_url(a);
    g_autofree gchar *b_http = gateway_config_http_url(b);
    if (g_strcmp0(a_http, b_http) != 0) return FALSE;

    g_autofree gchar *a_ws = gateway_config_ws_url(a);
    g_autofree gchar *b_ws = gateway_config_ws_url(b);
    if (g_strcmp0(a_ws, b_ws) != 0) return FALSE;

    return TRUE;
}
