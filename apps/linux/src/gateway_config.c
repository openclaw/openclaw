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
#include "json_access.h"
#include "log.h"
#include <json-glib/json-glib.h>
#include <string.h>

/* E10: Helper to securely clear sensitive strings before freeing */
static void secure_clear_free(gchar *s) {
    if (s) {
        volatile gchar *p = s;
        while (*p) *p++ = '\0';
    }
    g_free(s);
}

static gboolean is_bind_mode_token(const gchar *bind) {
    return g_strcmp0(bind, "auto") == 0 ||
           g_strcmp0(bind, "lan") == 0 ||
           g_strcmp0(bind, "loopback") == 0 ||
           g_strcmp0(bind, "custom") == 0 ||
           g_strcmp0(bind, "tailnet") == 0;
}

static gboolean is_wildcard_bind_literal(const gchar *bind) {
    return g_strcmp0(bind, "0.0.0.0") == 0 ||
           g_strcmp0(bind, "::") == 0 ||
           g_strcmp0(bind, "::0") == 0;
}

static gboolean is_valid_hostname_label(const gchar *label, gsize len) {
    if (!label || len == 0 || len > 63) {
        return FALSE;
    }
    if (!g_ascii_isalnum(label[0]) || !g_ascii_isalnum(label[len - 1])) {
        return FALSE;
    }
    for (gsize i = 0; i < len; i++) {
        gchar ch = label[i];
        if (!(g_ascii_isalnum(ch) || ch == '-')) {
            return FALSE;
        }
    }
    return TRUE;
}

static gboolean is_valid_hostname_literal(const gchar *host) {
    if (!host || host[0] == '\0') {
        return FALSE;
    }
    gsize host_len = strlen(host);
    if (host_len > 253) {
        return FALSE;
    }

    const gchar *label_start = host;
    const gchar *p = host;
    while (TRUE) {
        if (*p == '.' || *p == '\0') {
            gsize label_len = (gsize)(p - label_start);
            if (!is_valid_hostname_label(label_start, label_len)) {
                return FALSE;
            }
            if (*p == '\0') {
                break;
            }
            label_start = p + 1;
        }
        p++;
    }
    return TRUE;
}

static gboolean is_valid_bind_host_literal(const gchar *value) {
    if (!value || value[0] == '\0') {
        return FALSE;
    }
    if (g_hostname_is_ip_address(value)) {
        return TRUE;
    }
    return is_valid_hostname_literal(value);
}

static gboolean resolve_effective_gateway_host(JsonObject *gateway_obj, GatewayConfig *config) {
    if (gateway_obj && json_object_has_member(gateway_obj, "host")) {
        JsonNode *host_node = json_object_get_member(gateway_obj, "host");
        if (JSON_NODE_HOLDS_VALUE(host_node) && json_node_get_value_type(host_node) == G_TYPE_STRING) {
            const gchar *host_str = json_node_get_string(host_node);
            if (host_str && host_str[0] != '\0') {
                config->host = g_strdup(host_str);
                return TRUE;
            }
        }
    }

    if (!(gateway_obj && json_object_has_member(gateway_obj, "bind"))) {
        return TRUE;
    }

    JsonNode *bind_node = json_object_get_member(gateway_obj, "bind");
    if (!JSON_NODE_HOLDS_VALUE(bind_node) || json_node_get_value_type(bind_node) != G_TYPE_STRING) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_BIND_INVALID;
        config->error = g_strdup("gateway.bind exists but is not a string");
        return FALSE;
    }

    const gchar *bind_str = json_node_get_string(bind_node);
    if (!bind_str || bind_str[0] == '\0') {
        return TRUE;
    }

    if (is_bind_mode_token(bind_str)) {
        if (g_strcmp0(bind_str, "custom") == 0) {
            if (!(json_object_has_member(gateway_obj, "customBindHost"))) {
                config->valid = FALSE;
                config->error_code = GW_CFG_ERR_BIND_INVALID;
                config->error = g_strdup("gateway.bind=custom requires gateway.customBindHost");
                return FALSE;
            }

            JsonNode *custom_node = json_object_get_member(gateway_obj, "customBindHost");
            if (!JSON_NODE_HOLDS_VALUE(custom_node) || json_node_get_value_type(custom_node) != G_TYPE_STRING) {
                config->valid = FALSE;
                config->error_code = GW_CFG_ERR_BIND_INVALID;
                config->error = g_strdup("gateway.customBindHost exists but is not a string");
                return FALSE;
            }

            const gchar *custom_host = json_node_get_string(custom_node);
            if (!custom_host || custom_host[0] == '\0') {
                config->valid = FALSE;
                config->error_code = GW_CFG_ERR_BIND_INVALID;
                config->error = g_strdup("gateway.bind=custom requires non-empty gateway.customBindHost");
                return FALSE;
            }
            if (is_bind_mode_token(custom_host) ||
                is_wildcard_bind_literal(custom_host) ||
                !is_valid_bind_host_literal(custom_host)) {
                config->valid = FALSE;
                config->error_code = GW_CFG_ERR_BIND_INVALID;
                config->error = g_strdup_printf("gateway.customBindHost is not a valid host literal: '%s'", custom_host);
                return FALSE;
            }

            config->host = g_strdup(custom_host);
            return TRUE;
        }

        config->host = g_strdup(GATEWAY_DEFAULT_HOST);
        return TRUE;
    }

    if (is_wildcard_bind_literal(bind_str)) {
        config->host = g_strdup(GATEWAY_DEFAULT_HOST);
        return TRUE;
    }

    if (!is_valid_bind_host_literal(bind_str)) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_BIND_INVALID;
        config->error = g_strdup_printf("gateway.bind is neither a recognized mode token nor a valid host literal: '%s'", bind_str);
        return FALSE;
    }

    config->host = g_strdup(bind_str);
    return TRUE;
}

static gchar* resolve_config_path(const GatewayConfigContext *ctx) {
    const gchar *override = g_getenv("OPENCLAW_CONFIG_PATH");
    if (override && override[0] != '\0') {
        return g_strdup(override);
    }

    if (ctx && ctx->explicit_config_path && ctx->explicit_config_path[0] != '\0') {
        return g_strdup(ctx->explicit_config_path);
    }

    if (ctx && ctx->effective_state_dir && ctx->effective_state_dir[0] != '\0') {
        return g_build_filename(ctx->effective_state_dir, "openclaw.json", NULL);
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

    /* Primary fallback: ~/.openclaw/openclaw.json */
    gchar *primary = g_build_filename(home, ".openclaw", "openclaw.json", NULL);
    if (g_file_test(primary, G_FILE_TEST_EXISTS)) {
        return primary;
    }
    g_free(primary);

    /* E7: Correct legacy moltbot fallback names */
    static const gchar *legacy_dirs[] = { ".clawdbot", ".moltbot", NULL };
    static const gchar *legacy_names[] = { "openclaw.json", "clawdbot.json", "moltbot.json", NULL };

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

/* E6: Validate port member is numeric */
static gboolean is_valid_port_member(JsonObject *gateway_obj) {
    if (!gateway_obj || !json_object_has_member(gateway_obj, "port")) {
        return TRUE; /* Not present is OK - will use default */
    }
    JsonNode *port_node = json_object_get_member(gateway_obj, "port");
    /* Accept int, uint, or int64; reject non-numeric */
    GType node_type = json_node_get_value_type(port_node);
    if (node_type != G_TYPE_INT64 && node_type != G_TYPE_INT && node_type != G_TYPE_UINT) {
        return FALSE;
    }
    return TRUE;
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
            const gchar *mode = oc_json_string_member(auth_obj, "mode");
            if (mode && mode[0] != '\0') {
                cfg_auth_mode = g_strdup(mode);
            }
        }
        if (json_object_has_member(auth_obj, "token")) {
            JsonNode *tok_node = json_object_get_member(auth_obj, "token");
            if (JSON_NODE_HOLDS_OBJECT(tok_node)) {
                config->token_is_secret_ref = TRUE;
            } else if (json_node_get_value_type(tok_node) == G_TYPE_STRING) {
                const gchar *tok = json_node_get_string(tok_node);
                if (tok && tok[0] != '\0') {
                    cfg_token = g_strdup(tok);
                }
            }
        }
        if (json_object_has_member(auth_obj, "password")) {
            JsonNode *pw_node = json_object_get_member(auth_obj, "password");
            if (JSON_NODE_HOLDS_OBJECT(pw_node)) {
                config->password_is_secret_ref = TRUE;
            } else if (json_node_get_value_type(pw_node) == G_TYPE_STRING) {
                const gchar *pw = json_node_get_string(pw_node);
                if (pw && pw[0] != '\0') {
                    cfg_password = g_strdup(pw);
                }
            }
        }
    }

    /* 2. Apply env overrides */
    const gchar *env_token = g_getenv("OPENCLAW_GATEWAY_TOKEN");
    if (env_token && env_token[0] != '\0') {
        g_free(cfg_token);
        cfg_token = g_strdup(env_token);
        config->token_is_secret_ref = FALSE;
    }

    const gchar *env_password = g_getenv("OPENCLAW_GATEWAY_PASSWORD");
    if (env_password && env_password[0] != '\0') {
        g_free(cfg_password);
        cfg_password = g_strdup(env_password);
        config->password_is_secret_ref = FALSE;
    }

    /* 3. Infer auth_mode if not explicitly set (matches gateway server auth.ts:256-268) */
    if (!cfg_auth_mode) {
        if (cfg_password || config->password_is_secret_ref) {
            cfg_auth_mode = g_strdup("password");
        } else if (cfg_token || config->token_is_secret_ref) {
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

    if (g_strcmp0(config->auth_mode, "token") == 0) {
        if (config->token_is_secret_ref) {
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_SECRET_REF_UNSUPPORTED;
            config->error = g_strdup("Gateway token is configured as a SecretRef object, which is not yet supported by the Linux companion.");
            return FALSE;
        }
        if (!config->token) {
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_TOKEN_MISSING;
            config->error = g_strdup(
                "Gateway auth mode is token, but no token was configured "
                "(set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)");
            return FALSE;
        }
    }

    if (g_strcmp0(config->auth_mode, "password") == 0) {
        if (config->password_is_secret_ref) {
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_SECRET_REF_UNSUPPORTED;
            config->error = g_strdup("Gateway password is configured as a SecretRef object, which is not yet supported by the Linux companion.");
            return FALSE;
        }
        if (!config->password) {
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_PASSWORD_MISSING;
            config->error = g_strdup(
                "Gateway auth mode is password, but no password was configured "
                "(set gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD)");
            return FALSE;
        }
    }

    return TRUE;
}

/*
 * Detect if the config has the baseline model/provider configuration
 * that indicates onboarding has established runtime selections.
 * Feature B: onboarding detection based on agents.default.model or
 * agents.default.modelProvider presence.
 */
static gboolean detect_has_model_config(JsonObject *root_obj) {
    if (!root_obj) return FALSE;

    /* Check agents.default object for model or modelProvider */
    if (json_object_has_member(root_obj, "agents")) {
        JsonNode *agents_node = json_object_get_member(root_obj, "agents");
        if (JSON_NODE_HOLDS_OBJECT(agents_node)) {
            JsonObject *agents_obj = json_node_get_object(agents_node);
            if (json_object_has_member(agents_obj, "default")) {
                JsonNode *default_node = json_object_get_member(agents_obj, "default");
                if (JSON_NODE_HOLDS_OBJECT(default_node)) {
                    JsonObject *default_obj = json_node_get_object(default_node);
                    /* Presence of model or modelProvider indicates onboarding completed */
                    if (json_object_has_member(default_obj, "model")) {
                        JsonNode *model_node = json_object_get_member(default_obj, "model");
                        if (json_node_get_value_type(model_node) == G_TYPE_STRING) {
                            const gchar *model = json_node_get_string(model_node);
                            if (model && model[0] != '\0') {
                                return TRUE;
                            }
                        }
                    }
                    if (json_object_has_member(default_obj, "modelProvider")) {
                        JsonNode *provider_node = json_object_get_member(default_obj, "modelProvider");
                        if (json_node_get_value_type(provider_node) == G_TYPE_STRING) {
                            const gchar *provider = json_node_get_string(provider_node);
                            if (provider && provider[0] != '\0') {
                                return TRUE;
                            }
                        }
                    }
                }
            }
        }
    }

    return FALSE;
}

GatewayConfig* gateway_config_load(const GatewayConfigContext *ctx) {
    GatewayConfig *config = g_new0(GatewayConfig, 1);
    config->host = g_strdup(GATEWAY_DEFAULT_HOST);
    config->port = GATEWAY_DEFAULT_PORT;
    config->error_code = GW_CFG_OK;
    config->config_path = resolve_config_path(ctx);

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

    /* E1: Reject malformed-present gateway node (must be object if present) */
    if (json_object_has_member(root_obj, "gateway")) {
        JsonNode *gw_node = json_object_get_member(root_obj, "gateway");
        if (!JSON_NODE_HOLDS_OBJECT(gw_node)) {
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_GATEWAY_NOT_OBJECT;
            config->error = g_strdup("gateway exists but is not a JSON object");
            return config;
        }
    }

    JsonObject *gateway_obj = NULL;
    if (json_object_has_member(root_obj, "gateway")) {
        gateway_obj = oc_json_object_member(root_obj, "gateway");
    }

    /* E2: Reject malformed-present gateway.mode (must be string if present) */
    if (gateway_obj && json_object_has_member(gateway_obj, "mode")) {
        JsonNode *mode_node = json_object_get_member(gateway_obj, "mode");
        if (!JSON_NODE_HOLDS_VALUE(mode_node) || json_node_get_value_type(mode_node) != G_TYPE_STRING) {
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_MODE_INVALID;
            config->error = g_strdup("gateway.mode exists but is not a string");
            return config;
        }
    }

    /* Resolve mode */
    if (gateway_obj && json_object_has_member(gateway_obj, "mode")) {
        const gchar *mode = oc_json_string_member(gateway_obj, "mode");
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

    /* E6: Reject malformed-present port */
    if (!is_valid_port_member(gateway_obj)) {
        config->valid = FALSE;
        config->error_code = GW_CFG_ERR_PORT_INVALID;
        config->error = g_strdup("gateway.port exists but is not a valid integer");
        return config;
    }

    /* Resolve port */
    config->port = resolve_port(gateway_obj);

    /* L6: Resolve TLS enablement from gateway.tls or gateway.security.tls */
    if (gateway_obj) {
        if (json_object_has_member(gateway_obj, "tls")) {
            JsonNode *tls_node = json_object_get_member(gateway_obj, "tls");
            if (JSON_NODE_HOLDS_VALUE(tls_node)) {
                GType tls_type = json_node_get_value_type(tls_node);
                if (tls_type == G_TYPE_BOOLEAN) {
                    config->tls_enabled = json_node_get_boolean(tls_node);
                } else if (tls_type == G_TYPE_STRING) {
                    const gchar *tls_str = json_node_get_string(tls_node);
                    config->tls_enabled = (tls_str && g_strcmp0(tls_str, "true") == 0);
                }
            } else if (JSON_NODE_HOLDS_OBJECT(tls_node)) {
                /* gateway.tls = { enabled: true } */
                JsonObject *tls_obj = json_node_get_object(tls_node);
                if (json_object_has_member(tls_obj, "enabled")) {
                    JsonNode *enabled_node = json_object_get_member(tls_obj, "enabled");
                    if (JSON_NODE_HOLDS_VALUE(enabled_node)) {
                        GType enabled_type = json_node_get_value_type(enabled_node);
                        if (enabled_type == G_TYPE_BOOLEAN) {
                            config->tls_enabled = json_node_get_boolean(enabled_node);
                        } else if (enabled_type == G_TYPE_STRING) {
                            const gchar *enabled_str = json_node_get_string(enabled_node);
                            config->tls_enabled = (enabled_str && g_strcmp0(enabled_str, "true") == 0);
                        }
                    }
                }
            }
        }
        /* Also check gateway.security.tls */
        if (!config->tls_enabled && json_object_has_member(gateway_obj, "security")) {
            JsonNode *sec_node = json_object_get_member(gateway_obj, "security");
            if (JSON_NODE_HOLDS_OBJECT(sec_node)) {
                JsonObject *sec_obj = json_node_get_object(sec_node);
                if (json_object_has_member(sec_obj, "tls")) {
                    JsonNode *tls_node = json_object_get_member(sec_obj, "tls");
                    if (JSON_NODE_HOLDS_VALUE(tls_node)) {
                        GType tls_type = json_node_get_value_type(tls_node);
                        if (tls_type == G_TYPE_BOOLEAN) {
                            config->tls_enabled = json_node_get_boolean(tls_node);
                        } else if (tls_type == G_TYPE_STRING) {
                            const gchar *tls_str = json_node_get_string(tls_node);
                            config->tls_enabled = (tls_str && g_strcmp0(tls_str, "true") == 0);
                        }
                    }
                }
            }
        }
    }

    /* L6: Resolve host from config and bind semantics */
    g_free(config->host);
    config->host = NULL;
    if (!resolve_effective_gateway_host(gateway_obj, config)) {
        return config;
    }
    /* Final fallback to default loopback */
    if (!config->host) {
        config->host = g_strdup(GATEWAY_DEFAULT_HOST);
    }

    /* E3: Reject malformed-present gateway.auth (must be object if present) */
    if (gateway_obj && json_object_has_member(gateway_obj, "auth")) {
        JsonNode *auth_node = json_object_get_member(gateway_obj, "auth");
        if (!JSON_NODE_HOLDS_OBJECT(auth_node)) {
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_AUTH_NOT_OBJECT;
            config->error = g_strdup("gateway.auth exists but is not a JSON object");
            return config;
        }
    }

    /* Resolve auth from gateway.auth.* + env overrides */
    JsonObject *auth_obj = NULL;
    if (gateway_obj && json_object_has_member(gateway_obj, "auth")) {
        auth_obj = oc_json_object_member(gateway_obj, "auth");
    }
    /* E4: Reject malformed-present gateway.auth.mode (must be string if present) */
    if (auth_obj && json_object_has_member(auth_obj, "mode")) {
        JsonNode *mode_node = json_object_get_member(auth_obj, "mode");
        if (!JSON_NODE_HOLDS_VALUE(mode_node) || json_node_get_value_type(mode_node) != G_TYPE_STRING) {
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_AUTH_MODE_INVALID;
            config->error = g_strdup("gateway.auth.mode exists but is not a string");
            return config;
        }
    }

    /* E5: Reject ambiguous auth when both token and password present with no explicit mode */
    if (auth_obj) {
        gboolean has_token = FALSE;
        gboolean has_password = FALSE;
        gboolean has_explicit_mode = json_object_has_member(auth_obj, "mode") &&
            JSON_NODE_HOLDS_VALUE(json_object_get_member(auth_obj, "mode")) &&
            json_node_get_value_type(json_object_get_member(auth_obj, "mode")) == G_TYPE_STRING;

        if (json_object_has_member(auth_obj, "token")) {
            JsonNode *tok_node = json_object_get_member(auth_obj, "token");
            if (JSON_NODE_HOLDS_OBJECT(tok_node) || json_node_get_value_type(tok_node) == G_TYPE_STRING) {
                has_token = TRUE;
            }
        }
        if (json_object_has_member(auth_obj, "password")) {
            JsonNode *pw_node = json_object_get_member(auth_obj, "password");
            if (JSON_NODE_HOLDS_OBJECT(pw_node) || json_node_get_value_type(pw_node) == G_TYPE_STRING) {
                has_password = TRUE;
            }
        }

        if (has_token && has_password && !has_explicit_mode) {
            config->valid = FALSE;
            config->error_code = GW_CFG_ERR_AUTH_AMBIGUOUS;
            config->error = g_strdup("Both token and password are configured but auth mode is not explicitly set. Set gateway.auth.mode to 'token' or 'password'");
            return config;
        }
    }

    resolve_auth(auth_obj, config);
    if (!validate_auth(config)) return config;

    /* Resolve controlUi.basePath */
    if (gateway_obj && json_object_has_member(gateway_obj, "controlUi")) {
        JsonObject *cui_obj = oc_json_object_member(gateway_obj, "controlUi");
        if (cui_obj && json_object_has_member(cui_obj, "basePath")) {
            const gchar *bp = oc_json_string_member(cui_obj, "basePath");
            if (bp && bp[0] != '\0') {
                config->control_ui_base_path = g_strdup(bp);
            }
        }
    }

    config->valid = TRUE;
    config->error_code = GW_CFG_OK;

    /* Feature B: Detect if config has model/provider (diagnostic only) */
    config->has_model_config = detect_has_model_config(root_obj);

    /* Feature B: Detect if wizard onboarding is complete */
    if (json_object_has_member(root_obj, "wizard")) {
        JsonNode *wizard_node = json_object_get_member(root_obj, "wizard");
        if (JSON_NODE_HOLDS_OBJECT(wizard_node)) {
            JsonObject *wizard_obj = json_node_get_object(wizard_node);
            
            const gchar *cmd = NULL;
            if (json_object_has_member(wizard_obj, "lastRunCommand")) {
                JsonNode *cmd_node = json_object_get_member(wizard_obj, "lastRunCommand");
                if (json_node_get_value_type(cmd_node) == G_TYPE_STRING) {
                    cmd = json_node_get_string(cmd_node);
                    config->wizard_last_run_command = g_strdup(cmd);
                }
            }
            
            const gchar *at = NULL;
            if (json_object_has_member(wizard_obj, "lastRunAt")) {
                JsonNode *at_node = json_object_get_member(wizard_obj, "lastRunAt");
                if (json_node_get_value_type(at_node) == G_TYPE_STRING) {
                    at = json_node_get_string(at_node);
                    config->wizard_last_run_at = g_strdup(at);
                }
            }
            
            if (json_object_has_member(wizard_obj, "lastRunMode")) {
                JsonNode *mode_node = json_object_get_member(wizard_obj, "lastRunMode");
                if (json_node_get_value_type(mode_node) == G_TYPE_STRING) {
                    const gchar *mode = json_node_get_string(mode_node);
                    config->wizard_last_run_mode = g_strdup(mode);
                    if (g_strcmp0(mode, "local") == 0) {
                        config->wizard_is_local = TRUE;
                    }
                }
            }
            
            if (!cmd || g_strcmp0(cmd, "onboard") != 0) {
                config->wizard_marker_fail_reason = g_strdup("lastRunCommand is not 'onboard'");
            } else if (!at || at[0] == '\0') {
                config->wizard_marker_fail_reason = g_strdup("lastRunAt missing or empty");
            } else {
                config->has_wizard_onboard_marker = TRUE;
            }
        } else {
            config->wizard_marker_fail_reason = g_strdup("wizard object missing");
        }
    } else {
        config->wizard_marker_fail_reason = g_strdup("wizard object missing");
    }

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
              "gateway_config_load valid host=%s port=%d auth_mode=%s has_token=%d has_model_config=%d has_wizard=%d basePath=%s",
              config->host, config->port, config->auth_mode, config->token != NULL,
              config->has_model_config, config->has_wizard_onboard_marker,
              config->control_ui_base_path ? config->control_ui_base_path : "(default)");
    return config;
}

void gateway_config_free(GatewayConfig *config) {
    if (!config) return;
    g_free(config->mode);
    g_free(config->host);
    g_free(config->auth_mode);
    /* E10: Zero sensitive credentials before free */
    secure_clear_free(config->token);
    secure_clear_free(config->password);
    g_free(config->control_ui_base_path);
    g_free(config->config_path);
    g_free(config->error);

    g_free(config->wizard_last_run_command);
    g_free(config->wizard_last_run_at);
    g_free(config->wizard_last_run_mode);
    g_free(config->wizard_marker_fail_reason);

    g_free(config);
}

gboolean gateway_config_is_local(const GatewayConfig *config) {
    if (!config) return TRUE;
    return (config->mode == NULL || g_strcmp0(config->mode, "local") == 0);
}

gchar* gateway_config_http_url(const GatewayConfig *config) {
    if (!config) return NULL;
    const gchar *scheme = config->tls_enabled ? "https" : "http";
    return g_strdup_printf("%s://%s:%d", scheme, config->host, config->port);
}

gchar* gateway_config_ws_url(const GatewayConfig *config) {
    if (!config) return NULL;
    const gchar *scheme = config->tls_enabled ? "wss" : "ws";
    return g_strdup_printf("%s://%s:%d", scheme, config->host, config->port);
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

    /* tls_enabled - TLS changes must trigger config reload */
    if (a->tls_enabled != b->tls_enabled) return FALSE;

    /* auth_mode */
    if (g_strcmp0(a->auth_mode, b->auth_mode) != 0) return FALSE;

    /* credentials */
    if (g_strcmp0(a->token, b->token) != 0) return FALSE;
    if (g_strcmp0(a->password, b->password) != 0) return FALSE;
    if (a->token_is_secret_ref != b->token_is_secret_ref) return FALSE;
    if (a->password_is_secret_ref != b->password_is_secret_ref) return FALSE;

    /* Derived normalized URLs (catches any normalization edge cases) */
    g_autofree gchar *a_http = gateway_config_http_url(a);
    g_autofree gchar *b_http = gateway_config_http_url(b);
    if (g_strcmp0(a_http, b_http) != 0) return FALSE;

    g_autofree gchar *a_ws = gateway_config_ws_url(a);
    g_autofree gchar *b_ws = gateway_config_ws_url(b);
    if (g_strcmp0(a_ws, b_ws) != 0) return FALSE;

    /* controlUi.basePath */
    if (g_strcmp0(a->control_ui_base_path, b->control_ui_base_path) != 0) return FALSE;

    /* Feature B: Wizard fields */
    if (a->has_model_config != b->has_model_config) return FALSE;
    if (a->has_wizard_onboard_marker != b->has_wizard_onboard_marker) return FALSE;
    if (a->wizard_is_local != b->wizard_is_local) return FALSE;
    if (g_strcmp0(a->wizard_last_run_command, b->wizard_last_run_command) != 0) return FALSE;
    if (g_strcmp0(a->wizard_last_run_at, b->wizard_last_run_at) != 0) return FALSE;
    if (g_strcmp0(a->wizard_last_run_mode, b->wizard_last_run_mode) != 0) return FALSE;
    if (g_strcmp0(a->wizard_marker_fail_reason, b->wizard_marker_fail_reason) != 0) return FALSE;

    return TRUE;
}

gchar* gateway_config_resolve_path(const GatewayConfigContext *ctx) {
    return resolve_config_path(ctx);
}

void gateway_config_free_resolved_path(gchar *path) {
    g_free(path);
}

/*
 * Build the dashboard (Control UI) URL from the configured gateway endpoint.
 *
 * Uses the configured endpoint as the source of truth — not transient
 * health-state values. The URL pattern matches the CLI (dashboard.ts)
 * and macOS (GatewayEndpointStore.dashboardURL):
 *   http://{host}:{port}{basePath}#token={token}
 *
 * Token is embedded as a URL fragment (not query param) to avoid leaking
 * via server logs. SecretRef-managed tokens are never embedded.
 */
gchar* gateway_config_dashboard_url(const GatewayConfig *config) {
    if (!config || !config->valid) return NULL;

    /* Normalize basePath: ensure leading slash, trailing slash */
    const gchar *raw_path = config->control_ui_base_path;
    g_autofree gchar *normalized = NULL;
    if (!raw_path || raw_path[0] == '\0') {
        normalized = g_strdup("/");
    } else {
        gboolean has_leading = (raw_path[0] == '/');
        gsize len = strlen(raw_path);
        gboolean has_trailing = (len > 0 && raw_path[len - 1] == '/');

        if (has_leading && has_trailing) {
            normalized = g_strdup(raw_path);
        } else if (has_leading && !has_trailing) {
            normalized = g_strdup_printf("%s/", raw_path);
        } else if (!has_leading && has_trailing) {
            normalized = g_strdup_printf("/%s", raw_path);
        } else {
            normalized = g_strdup_printf("/%s/", raw_path);
        }
    }

    /* Build base URL with correct scheme based on TLS */
    const gchar *scheme = config->tls_enabled ? "https" : "http";
    g_autofree gchar *base = g_strdup_printf("%s://%s:%d%s",
        scheme, config->host, config->port,
        g_strcmp0(normalized, "/") == 0 ? "/" : normalized);

    /* Append token fragment if available and not a SecretRef */
    if (config->token && config->token[0] != '\0' && !config->token_is_secret_ref) {
        g_autofree gchar *escaped = g_uri_escape_string(config->token, NULL, FALSE);
        return g_strdup_printf("%s#token=%s", base, escaped);
    }

    return g_strdup(base);
}

/*
 * Build a dashboard URL with a specific route inserted before the fragment.
 *
 * If base_url contains a '#' fragment marker, the route is inserted before it.
 * Otherwise, the route is appended to the base URL. Handles slash normalization.
 *
 * Returns NULL if base_url or route is NULL.
 */
gchar* gateway_config_dashboard_url_with_route(const gchar *base_url, const gchar *route) {
    if (!base_url || !route) return NULL;

    /* Find fragment marker */
    const gchar *fragment = strchr(base_url, '#');
    if (fragment) {
        /* Insert route before fragment */
        gsize base_len = fragment - base_url;
        /* Ensure base ends with / */
        gboolean needs_slash = (base_len == 0 || base_url[base_len - 1] != '/');
        return g_strdup_printf("%.*s%s%s%s",
                              (int)base_len, base_url,
                              needs_slash ? "/" : "",
                              route, fragment);
    } else {
        /* No fragment, append route normally */
        gboolean needs_slash = base_url[strlen(base_url) - 1] != '/';
        return g_strdup_printf("%s%s%s",
                              base_url,
                              needs_slash ? "/" : "",
                              route);
    }
}
