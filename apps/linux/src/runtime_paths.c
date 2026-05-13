/*
 * runtime_paths.c
 *
 * Canonical runtime path derivation contract for Linux companion surfaces.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "runtime_paths.h"

#include <string.h>

static gboolean non_empty(const gchar *value) {
    return value && value[0] != '\0';
}

void runtime_effective_paths_resolve(const GatewayConfig *loaded_config,
                                     const gchar *profile,
                                     const gchar *runtime_state_dir,
                                     const gchar *runtime_config_path,
                                     RuntimeEffectivePaths *out) {
    if (!out) return;
    memset(out, 0, sizeof(*out));

    GatewayConfigContext ctx = {0};
    ctx.explicit_config_path = runtime_config_path;
    ctx.effective_state_dir = runtime_state_dir;
    ctx.profile = profile;

    g_autofree gchar *resolved_config_path = gateway_config_resolve_path(&ctx);

    const gchar *effective_config_path = NULL;
    if (loaded_config && non_empty(loaded_config->config_path)) {
        effective_config_path = loaded_config->config_path;
    } else if (non_empty(resolved_config_path)) {
        effective_config_path = resolved_config_path;
    } else if (non_empty(runtime_config_path)) {
        effective_config_path = runtime_config_path;
    }

    if (effective_config_path) {
        out->effective_config_path = g_strdup(effective_config_path);
    }

    if (non_empty(runtime_state_dir)) {
        out->effective_state_dir = g_strdup(runtime_state_dir);
    } else if (non_empty(out->effective_config_path)) {
        gchar *derived = g_path_get_dirname(out->effective_config_path);
        if (non_empty(derived)) {
            out->effective_state_dir = derived;
            derived = NULL;
        }
        g_free(derived);
    }
}

void runtime_effective_paths_clear(RuntimeEffectivePaths *paths) {
    if (!paths) return;
    g_clear_pointer(&paths->effective_config_path, g_free);
    g_clear_pointer(&paths->effective_state_dir, g_free);
}
