/*
 * runtime_paths.h
 *
 * Canonical runtime path derivation contract for Linux companion surfaces.
 *
 * This API is the single source of truth for deriving:
 *   - effective config path
 *   - effective state directory
 *
 * Precedence contract:
 *   1) loaded gateway config path (if available)
 *   2) resolved runtime config path (gateway_config_resolve_path)
 *   3) raw runtime config path from systemd context
 *
 * State-dir contract:
 *   1) runtime state dir from systemd context
 *   2) dirname(effective config path)
 *
 * Ownership contract:
 *   - All fields in RuntimeEffectivePaths are owned by the caller.
 *   - Call runtime_effective_paths_clear() to free/reset the struct.
 */

#pragma once

#include <glib.h>
#include "gateway_config.h"

typedef struct {
    gchar *effective_config_path;
    gchar *effective_state_dir;
} RuntimeEffectivePaths;

void runtime_effective_paths_resolve(const GatewayConfig *loaded_config,
                                     const gchar *profile,
                                     const gchar *runtime_state_dir,
                                     const gchar *runtime_config_path,
                                     RuntimeEffectivePaths *out);

void runtime_effective_paths_clear(RuntimeEffectivePaths *paths);
