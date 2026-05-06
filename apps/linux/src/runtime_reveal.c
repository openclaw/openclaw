/*
 * runtime_reveal.c
 *
 * Implementation of shared reveal URI builders for the Linux companion
 * app. Kept separate from `runtime_paths.c` so the pure path-resolution
 * contract remains linkable by tests that do not provide systemd /
 * gateway-client stubs.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "runtime_reveal.h"

#include "gateway_client.h"
#include "runtime_paths.h"
#include "state.h"

static gchar* reveal_build_dir_uri(const gchar *path) {
    if (!path || path[0] == '\0') {
        return NULL;
    }
    return g_filename_to_uri(path, NULL, NULL);
}

gchar* runtime_reveal_build_config_dir_uri(void) {
    g_autofree gchar *profile = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *config_path = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    GatewayConfig *cfg = gateway_client_get_config();
    RuntimeEffectivePaths effective_paths = {0};
    runtime_effective_paths_resolve(cfg, profile, state_dir, config_path, &effective_paths);

    gchar *uri = NULL;
    if (effective_paths.effective_config_path) {
        g_autofree gchar *dir = g_path_get_dirname(effective_paths.effective_config_path);
        uri = reveal_build_dir_uri(dir);
    }

    runtime_effective_paths_clear(&effective_paths);
    return uri;
}

gchar* runtime_reveal_build_state_dir_uri(void) {
    g_autofree gchar *profile = NULL;
    g_autofree gchar *state_dir = NULL;
    g_autofree gchar *config_path = NULL;
    systemd_get_runtime_context(&profile, &state_dir, &config_path);

    GatewayConfig *cfg = gateway_client_get_config();
    RuntimeEffectivePaths effective_paths = {0};
    runtime_effective_paths_resolve(cfg, profile, state_dir, config_path, &effective_paths);

    gchar *uri = reveal_build_dir_uri(effective_paths.effective_state_dir);

    runtime_effective_paths_clear(&effective_paths);
    return uri;
}
