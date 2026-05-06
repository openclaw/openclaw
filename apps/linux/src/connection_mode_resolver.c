/*
 * connection_mode_resolver.c
 *
 * Pure-logic connection-mode resolution. See header for contract.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "connection_mode_resolver.h"

#include <string.h>

static gboolean trim_equals(const gchar *raw, const gchar *target) {
    if (!raw || !target) return FALSE;
    g_autofree gchar *copy = g_strdup(raw);
    g_strstrip(copy);
    g_autofree gchar *lower = g_ascii_strdown(copy, -1);
    return g_strcmp0(lower, target) == 0;
}

EffectiveConnectionMode connection_mode_resolve(const gchar *config_mode,
                                                gboolean config_has_remote_url,
                                                ProductConnectionMode persisted_mode,
                                                gboolean onboarding_seen) {
    EffectiveConnectionMode out;

    if (trim_equals(config_mode, "local")) {
        out.mode = PRODUCT_CONNECTION_MODE_LOCAL;
        out.source = EFFECTIVE_MODE_SRC_CONFIG_MODE;
        return out;
    }
    if (trim_equals(config_mode, "remote")) {
        out.mode = PRODUCT_CONNECTION_MODE_REMOTE;
        out.source = EFFECTIVE_MODE_SRC_CONFIG_MODE;
        return out;
    }

    if (config_has_remote_url) {
        out.mode = PRODUCT_CONNECTION_MODE_REMOTE;
        out.source = EFFECTIVE_MODE_SRC_CONFIG_REMOTE_URL;
        return out;
    }

    if (persisted_mode == PRODUCT_CONNECTION_MODE_LOCAL ||
        persisted_mode == PRODUCT_CONNECTION_MODE_REMOTE) {
        out.mode = persisted_mode;
        out.source = EFFECTIVE_MODE_SRC_PRODUCT_STATE;
        return out;
    }

    out.mode = onboarding_seen ? PRODUCT_CONNECTION_MODE_LOCAL
                               : PRODUCT_CONNECTION_MODE_LOCAL; /* unspecified → local */
    out.source = EFFECTIVE_MODE_SRC_ONBOARDING;
    return out;
}

const gchar* connection_mode_source_to_string(EffectiveModeSource source) {
    switch (source) {
    case EFFECTIVE_MODE_SRC_CONFIG_MODE:        return "config_mode";
    case EFFECTIVE_MODE_SRC_CONFIG_REMOTE_URL:  return "config_remote_url";
    case EFFECTIVE_MODE_SRC_PRODUCT_STATE:      return "product_state";
    case EFFECTIVE_MODE_SRC_ONBOARDING:         return "onboarding";
    default:                                    return "unknown";
    }
}
