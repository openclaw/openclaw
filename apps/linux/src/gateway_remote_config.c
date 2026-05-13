/*
 * gateway_remote_config.c
 *
 * Implementation of the `gateway.remote` config subtree parser.
 * See gateway_remote_config.h for the contract description.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_remote_config.h"

#include <string.h>

#define GATEWAY_WS_DEFAULT_PORT 18789
#define GATEWAY_WSS_DEFAULT_PORT 443
#define SSH_DEFAULT_PORT 22

static gchar* trim_dup(const gchar *raw) {
    if (!raw) return NULL;
    gchar *copy = g_strdup(raw);
    g_strstrip(copy);
    if (copy[0] == '\0') {
        g_free(copy);
        return NULL;
    }
    return copy;
}

static void secure_clear_free(gchar *s) {
    if (!s) return;
    volatile gchar *p = s;
    while (*p) *p++ = '\0';
    g_free(s);
}

const gchar* gateway_remote_config_transport_to_string(RemoteTransport transport) {
    switch (transport) {
    case REMOTE_TRANSPORT_DIRECT:
        return "direct";
    case REMOTE_TRANSPORT_SSH:
    default:
        return "ssh";
    }
}

RemoteTransport gateway_remote_config_transport_from_string(const gchar *raw) {
    RemoteTransport out;
    if (gateway_remote_config_transport_parse(raw, &out)) return out;
    return REMOTE_TRANSPORT_SSH;
}

gboolean gateway_remote_config_transport_parse(const gchar *raw,
                                               RemoteTransport *out) {
    if (!out) return FALSE;
    if (!raw) {
        *out = REMOTE_TRANSPORT_SSH;
        return TRUE;
    }
    g_autofree gchar *trimmed = g_ascii_strdown(raw, -1);
    g_strstrip(trimmed);
    if (g_strcmp0(trimmed, "ssh") == 0) {
        *out = REMOTE_TRANSPORT_SSH;
        return TRUE;
    }
    if (g_strcmp0(trimmed, "direct") == 0) {
        *out = REMOTE_TRANSPORT_DIRECT;
        return TRUE;
    }
    return FALSE;
}

gboolean gateway_remote_config_host_is_loopback(const gchar *host) {
    if (!host || host[0] == '\0') return FALSE;
    g_autofree gchar *lower = g_ascii_strdown(host, -1);
    g_strstrip(lower);
    if (g_strcmp0(lower, "127.0.0.1") == 0) return TRUE;
    if (g_strcmp0(lower, "::1") == 0) return TRUE;
    if (g_strcmp0(lower, "[::1]") == 0) return TRUE;
    if (g_strcmp0(lower, "localhost") == 0) return TRUE;
    if (g_str_has_suffix(lower, ".localhost")) return TRUE;
    return FALSE;
}

gchar* gateway_remote_config_normalize_url(const gchar *raw,
                                           gchar **out_host,
                                           gint *out_port,
                                           gboolean *out_tls) {
    if (out_host) *out_host = NULL;
    if (out_port) *out_port = 0;
    if (out_tls) *out_tls = FALSE;
    if (!raw) return NULL;

    g_autofree gchar *trimmed = g_strdup(raw);
    g_strstrip(trimmed);
    if (trimmed[0] == '\0') return NULL;

    g_autoptr(GUri) uri = g_uri_parse(trimmed, G_URI_FLAGS_NONE, NULL);
    if (!uri) return NULL;

    const gchar *scheme = g_uri_get_scheme(uri);
    if (!scheme) return NULL;
    g_autofree gchar *scheme_lower = g_ascii_strdown(scheme, -1);

    gboolean tls;
    if (g_strcmp0(scheme_lower, "wss") == 0) {
        tls = TRUE;
    } else if (g_strcmp0(scheme_lower, "ws") == 0) {
        tls = FALSE;
    } else {
        return NULL;
    }

    const gchar *host = g_uri_get_host(uri);
    if (!host || host[0] == '\0') return NULL;

    /* ws:// is limited to loopback hosts */
    if (!tls && !gateway_remote_config_host_is_loopback(host)) return NULL;

    gint port = g_uri_get_port(uri);
    if (port <= 0) {
        port = tls ? GATEWAY_WSS_DEFAULT_PORT : GATEWAY_WS_DEFAULT_PORT;
    }

    if (out_host) *out_host = g_strdup(host);
    if (out_port) *out_port = port;
    if (out_tls) *out_tls = tls;

    return g_strdup_printf("%s://%s:%d", scheme_lower, host, port);
}

gboolean gateway_remote_config_parse_ssh_target(const gchar *raw,
                                                gchar **out_user,
                                                gchar **out_host,
                                                gint *out_port) {
    if (out_user) *out_user = NULL;
    if (out_host) *out_host = NULL;
    if (out_port) *out_port = 0;
    if (!raw) return FALSE;

    g_autofree gchar *trimmed = g_strdup(raw);
    g_strstrip(trimmed);
    if (trimmed[0] == '\0') return FALSE;
    /*
     * Reject raw input beginning with '-' outright. This would be
     * interpreted by OpenSSH as an option flag (e.g. -oProxyJump=…)
     * and the argv-smuggling vector this would create is exactly why
     * macOS CommandResolver.sshTargetValidationMessage does the same.
     */
    if (trimmed[0] == '-') return FALSE;

    /* Strip optional leading "ssh " — matches macOS parser tolerance */
    const gchar *work = trimmed;
    if (g_str_has_prefix(work, "ssh ")) {
        work += 4;
        while (*work == ' ' || *work == '\t') work++;
    }

    /*
     * argv-boundary guard, post-prefix-strip variant.
     *
     * The pre-strip check above rejects raw inputs like "-oProxyJump=…",
     * but an attacker can hide the dash behind the optional "ssh "
     * prefix (e.g. "ssh -oProxyCommand=evil@host" or
     * "ssh    -oProxyJump=evil@host"). After we have peeled the prefix
     * and skipped any leading whitespace, the *functional* head of the
     * target must not begin with '-' either — otherwise the
     * subsequently-parsed user/host components could smuggle option
     * flags through to OpenSSH's argv. Reject such inputs outright.
     */
    if (work[0] == '-') return FALSE;

    /* No internal whitespace or control characters allowed */
    for (const gchar *p = work; *p; p++) {
        if (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || (guchar)*p < 0x20) {
            return FALSE;
        }
    }

    gchar *user = NULL;
    const gchar *host_start = work;
    const gchar *at = strchr(work, '@');
    if (at) {
        if (at == work) return FALSE; /* empty user */
        user = g_strndup(work, (gsize)(at - work));
        host_start = at + 1;
    }

    if (host_start[0] == '\0') {
        g_free(user);
        return FALSE;
    }
    if (host_start[0] == '-') {
        g_free(user);
        return FALSE;
    }

    /* Last ':' separates host from port */
    gchar *host = NULL;
    gint port = SSH_DEFAULT_PORT;
    const gchar *colon = strrchr(host_start, ':');
    if (colon && colon != host_start) {
        const gchar *port_str = colon + 1;
        /* Empty port suffix ("host:") is invalid. */
        if (*port_str == '\0') {
            g_free(user);
            return FALSE;
        }
        /* Require fully numeric port — g_ascii_strtoll happily accepts
         * "22abc" and returns 22, which would silently ignore corrupted
         * config. */
        for (const gchar *p = port_str; *p; p++) {
            if (!g_ascii_isdigit(*p)) {
                g_free(user);
                return FALSE;
            }
        }
        host = g_strndup(host_start, (gsize)(colon - host_start));
        gchar *end = NULL;
        gint64 parsed = g_ascii_strtoll(port_str, &end, 10);
        if (!end || *end != '\0' || parsed <= 0 || parsed > 65535) {
            g_free(host);
            g_free(user);
            return FALSE;
        }
        port = (gint)parsed;
    } else {
        host = g_strdup(host_start);
    }

    if (!host || host[0] == '\0') {
        g_free(host);
        g_free(user);
        return FALSE;
    }

    if (out_user) {
        *out_user = user;
    } else {
        g_free(user);
    }
    if (out_host) {
        *out_host = host;
    } else {
        g_free(host);
    }
    if (out_port) *out_port = port;
    return TRUE;
}

void gateway_remote_config_clear(GatewayRemoteConfig *out) {
    if (!out) return;
    g_free(out->url);
    g_free(out->url_host);
    g_free(out->ssh_target);
    g_free(out->ssh_target_host);
    g_free(out->ssh_target_user);
    g_free(out->ssh_identity);
    secure_clear_free(out->token);
    secure_clear_free(out->password);
    g_free(out->error);
    memset(out, 0, sizeof(*out));
}

gboolean gateway_remote_config_parse(JsonObject *gateway_obj, GatewayRemoteConfig *out) {
    if (!out) return FALSE;
    memset(out, 0, sizeof(*out));
    out->transport = REMOTE_TRANSPORT_SSH;
    out->error_code = REMOTE_CFG_OK;
    out->ssh_target_port = SSH_DEFAULT_PORT;

    if (!gateway_obj) return TRUE;
    if (!json_object_has_member(gateway_obj, "remote")) return TRUE;

    JsonNode *remote_node = json_object_get_member(gateway_obj, "remote");
    if (!JSON_NODE_HOLDS_OBJECT(remote_node)) {
        out->error_code = REMOTE_CFG_ERR_REMOTE_NOT_OBJECT;
        out->error = g_strdup("gateway.remote exists but is not a JSON object");
        return FALSE;
    }

    JsonObject *remote_obj = json_node_get_object(remote_node);
    out->present = TRUE;

    /* transport */
    if (json_object_has_member(remote_obj, "transport")) {
        JsonNode *t_node = json_object_get_member(remote_obj, "transport");
        if (!JSON_NODE_HOLDS_VALUE(t_node) ||
            json_node_get_value_type(t_node) != G_TYPE_STRING) {
            out->error_code = REMOTE_CFG_ERR_TRANSPORT_INVALID;
            out->error = g_strdup("gateway.remote.transport exists but is not a string");
            return FALSE;
        }
        const gchar *raw = json_node_get_string(t_node);
        RemoteTransport parsed;
        if (!gateway_remote_config_transport_parse(raw, &parsed)) {
            out->error_code = REMOTE_CFG_ERR_TRANSPORT_INVALID;
            out->error = g_strdup_printf(
                "gateway.remote.transport must be \"ssh\" or \"direct\" (got \"%s\")",
                raw ? raw : "");
            return FALSE;
        }
        out->transport = parsed;
    }

    /* url — strict: present but non-string is a config error. */
    if (json_object_has_member(remote_obj, "url")) {
        JsonNode *u_node = json_object_get_member(remote_obj, "url");
        if (JSON_NODE_HOLDS_NULL(u_node)) {
            /* explicit null is treated as absent */
        } else if (!JSON_NODE_HOLDS_VALUE(u_node) ||
                   json_node_get_value_type(u_node) != G_TYPE_STRING) {
            out->error_code = REMOTE_CFG_ERR_URL_INVALID;
            out->error = g_strdup("gateway.remote.url exists but is not a string");
            return FALSE;
        } else {
            const gchar *raw = json_node_get_string(u_node);
            g_autofree gchar *trimmed = trim_dup(raw);
            if (trimmed) {
                gchar *host = NULL;
                gint port = 0;
                gboolean tls = FALSE;
                gchar *normalized = gateway_remote_config_normalize_url(trimmed,
                                                                        &host, &port, &tls);
                if (!normalized) {
                    out->error_code = REMOTE_CFG_ERR_URL_INVALID;
                    out->error = g_strdup_printf(
                        "gateway.remote.url is not a valid ws[s] URL: '%s'", trimmed);
                    return FALSE;
                }
                out->url = normalized;
                out->url_host = host;
                out->url_port = port;
                out->url_tls = tls;
            }
        }
    }

    /* sshTarget — strict: present but non-string is a config error. */
    if (json_object_has_member(remote_obj, "sshTarget")) {
        JsonNode *t_node = json_object_get_member(remote_obj, "sshTarget");
        if (JSON_NODE_HOLDS_NULL(t_node)) {
            /* explicit null is treated as absent */
        } else if (!JSON_NODE_HOLDS_VALUE(t_node) ||
                   json_node_get_value_type(t_node) != G_TYPE_STRING) {
            out->error_code = REMOTE_CFG_ERR_TARGET_INVALID;
            out->error = g_strdup("gateway.remote.sshTarget exists but is not a string");
            return FALSE;
        } else {
            const gchar *raw = json_node_get_string(t_node);
            g_autofree gchar *trimmed = trim_dup(raw);
            if (trimmed) {
                gchar *user = NULL;
                gchar *host = NULL;
                gint port = 0;
                if (!gateway_remote_config_parse_ssh_target(trimmed, &user, &host, &port)) {
                    out->error_code = REMOTE_CFG_ERR_TARGET_INVALID;
                    out->error = g_strdup_printf(
                        "gateway.remote.sshTarget is not a valid user@host[:port]: '%s'", trimmed);
                    return FALSE;
                }
                out->ssh_target_user = user;
                out->ssh_target_host = host;
                out->ssh_target_port = port;
                if (user) {
                    out->ssh_target = g_strdup_printf("%s@%s:%d", user, host, port);
                } else {
                    out->ssh_target = g_strdup_printf("%s:%d", host, port);
                }
            }
        }
    }

    /* sshIdentity */
    if (json_object_has_member(remote_obj, "sshIdentity")) {
        JsonNode *i_node = json_object_get_member(remote_obj, "sshIdentity");
        if (JSON_NODE_HOLDS_VALUE(i_node) &&
            json_node_get_value_type(i_node) == G_TYPE_STRING) {
            out->ssh_identity = trim_dup(json_node_get_string(i_node));
        }
    }

    /* token */
    if (json_object_has_member(remote_obj, "token")) {
        JsonNode *t_node = json_object_get_member(remote_obj, "token");
        if (JSON_NODE_HOLDS_VALUE(t_node) &&
            json_node_get_value_type(t_node) == G_TYPE_STRING) {
            out->token = trim_dup(json_node_get_string(t_node));
        } else if (JSON_NODE_HOLDS_OBJECT(t_node)) {
            out->token_unsupported_nonstring = TRUE;
        }
    }

    /* password */
    if (json_object_has_member(remote_obj, "password")) {
        JsonNode *p_node = json_object_get_member(remote_obj, "password");
        if (JSON_NODE_HOLDS_VALUE(p_node) &&
            json_node_get_value_type(p_node) == G_TYPE_STRING) {
            out->password = trim_dup(json_node_get_string(p_node));
        } else if (JSON_NODE_HOLDS_OBJECT(p_node)) {
            out->password_unsupported_nonstring = TRUE;
        }
    }

    return TRUE;
}
