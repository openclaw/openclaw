/*
 * gateway_remote_config.h
 *
 * Parser and normalizer for the `gateway.remote` config subtree.
 *
 * Mirrors the contract declared by the macOS companion
 * (apps/macos/Sources/OpenClaw/GatewayRemoteConfig.swift). The shared
 * schema is:
 *
 *   gateway: {
 *     mode: "local" | "remote",
 *     remote: {
 *       transport: "ssh" | "direct",      (default "ssh" when absent)
 *       url:         "wss://host[:port]", (required for direct)
 *       sshTarget:   "user@host[:port]",  (required for ssh)
 *       sshIdentity: "/path/to/key",      (optional, ssh only)
 *       token:       "…",                 (optional)
 *       password:    "…",                 (optional)
 *     }
 *   }
 *
 * This module is purely a parser/normalizer: it does not read from disk,
 * does not touch process state, does not depend on a GLib main loop, and
 * is safely callable from tests.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_REMOTE_CONFIG_H
#define OPENCLAW_LINUX_GATEWAY_REMOTE_CONFIG_H

#include <glib.h>
#include <json-glib/json-glib.h>

typedef enum {
    REMOTE_TRANSPORT_SSH = 0,    /* default when absent/unknown */
    REMOTE_TRANSPORT_DIRECT = 1,
} RemoteTransport;

typedef enum {
    REMOTE_CFG_OK = 0,
    REMOTE_CFG_ERR_REMOTE_NOT_OBJECT,     /* gateway.remote exists but isn't an object */
    REMOTE_CFG_ERR_TRANSPORT_INVALID,     /* gateway.remote.transport isn't a recognized string */
    REMOTE_CFG_ERR_URL_INVALID,           /* gateway.remote.url fails scheme/host validation */
    REMOTE_CFG_ERR_TARGET_INVALID,        /* gateway.remote.sshTarget fails user@host[:port] parse */
    REMOTE_CFG_ERR_URL_REQUIRED,          /* direct transport without a URL */
    REMOTE_CFG_ERR_TARGET_REQUIRED,       /* ssh transport without an sshTarget */
    REMOTE_CFG_ERR_TOKEN_UNSUPPORTED,     /* token provided as non-string (e.g. SecretRef) */
} RemoteConfigError;

typedef struct {
    RemoteTransport transport;
    gchar *url;              /* normalized ws[s]:// URL; NULL when absent */
    gchar *url_host;         /* host component of url (parsed)            */
    gint   url_port;          /* port component of url (defaulted)         */
    gboolean url_tls;        /* TRUE when url scheme is wss                */
    gchar *ssh_target;       /* normalized user@host[:port]; NULL absent   */
    gchar *ssh_target_host;  /* host component of sshTarget                */
    gint   ssh_target_port;   /* port component (default 22)                */
    gchar *ssh_target_user;  /* user component; NULL when not specified    */
    gchar *ssh_identity;     /* absolute/relative identity path; NULL empty*/
    gchar *token;            /* resolved token; NULL when absent           */
    gchar *password;         /* resolved password; NULL when absent        */
    gboolean token_unsupported_nonstring;   /* gateway.remote.token was an object/array */
    gboolean password_unsupported_nonstring;
    gboolean present;        /* TRUE iff the `remote` object existed       */
    RemoteConfigError error_code;
    gchar *error;            /* human-readable error message; NULL when OK */
} GatewayRemoteConfig;

/* Parse a gateway object's `remote` subtree. gateway_obj may be NULL.
 * out is fully populated (including error fields on failure) and the
 * caller must call gateway_remote_config_clear() when done.
 * Returns TRUE on success, FALSE on parse error (out->error set).
 */
gboolean gateway_remote_config_parse(JsonObject *gateway_obj, GatewayRemoteConfig *out);

/* Free all heap-owned fields of out and reset it to a zeroed state. Safe
 * to call on a zeroed struct; does NOT free out itself.
 */
void gateway_remote_config_clear(GatewayRemoteConfig *out);

/* Pure parser: normalize a raw URL string into a ws[s]:// URL, or return
 * NULL if the URL is not a valid ws[s] URL for the remote contract.
 *
 * Rules (matching macOS GatewayRemoteConfig.normalizeGatewayUrl):
 *   - scheme MUST be ws or wss (case-insensitive)
 *   - host MUST be non-empty
 *   - ws:// MUST target a loopback host (127.0.0.1, ::1, localhost, *.localhost)
 *   - ws:// with no explicit port gets port 18789
 *   - wss:// with no explicit port gets port 443 (implicit)
 *
 * Caller owns the returned string; NULL on invalid.
 * out_host/out_port/out_tls are always populated on success.
 */
gchar* gateway_remote_config_normalize_url(const gchar *raw,
                                           gchar **out_host,
                                           gint *out_port,
                                           gboolean *out_tls);

/* Pure parser: parse a user@host[:port] string.
 * Returns TRUE on success, FALSE on parse error.
 * out_user may be NULL (means no user specified). Defaults port to 22.
 * All out-params are heap-owned on success and must be freed by caller.
 */
gboolean gateway_remote_config_parse_ssh_target(const gchar *raw,
                                                gchar **out_user,
                                                gchar **out_host,
                                                gint *out_port);

/* Whether a host string is a loopback host for the ws:// validation rule. */
gboolean gateway_remote_config_host_is_loopback(const gchar *host);

/* Stringify a transport value. Stable for config persistence and logs. */
const gchar* gateway_remote_config_transport_to_string(RemoteTransport transport);

/* Parse a transport string. Unknown values map to SSH (the macOS default).
 *
 * For strict parsing where unknown strings must reject (used by the
 * gateway.remote loader), prefer gateway_remote_config_transport_parse. */
RemoteTransport gateway_remote_config_transport_from_string(const gchar *raw);

/*
 * Strict transport parser:
 *   raw == NULL                    → out=SSH, returns TRUE  (default)
 *   raw == "ssh"  / "SSH" / "  ssh"→ out=SSH, returns TRUE
 *   raw == "direct"                 → out=DIRECT, returns TRUE
 *   anything else                  → returns FALSE (out is unchanged)
 */
gboolean gateway_remote_config_transport_parse(const gchar *raw,
                                               RemoteTransport *out);

#endif /* OPENCLAW_LINUX_GATEWAY_REMOTE_CONFIG_H */
