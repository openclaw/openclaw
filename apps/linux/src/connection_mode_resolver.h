/*
 * connection_mode_resolver.h
 *
 * Resolves the effective connection mode (local/remote) from the
 * combination of loaded config + persisted product state + onboarding
 * completion flag.
 *
 * Mirrors the macOS ConnectionModeResolver precedence
 * (apps/macos/Sources/OpenClaw/ConnectionModeResolver.swift):
 *
 *   1. gateway.mode == "local"   → LOCAL  (source: config mode)
 *   2. gateway.mode == "remote"  → REMOTE (source: config mode)
 *   3. gateway.remote.url present → REMOTE (source: config remote url)
 *   4. Persisted product_state mode is explicit → that value (source: product state)
 *   5. Onboarding seen ever → LOCAL ; else UNSPECIFIED (source: onboarding)
 *
 * This module is pure-logic. It does not read from disk, does not
 * mutate global state, and is safe to call from tests.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_CONNECTION_MODE_RESOLVER_H
#define OPENCLAW_LINUX_CONNECTION_MODE_RESOLVER_H

#include <glib.h>

#include "product_state.h"

typedef enum {
    EFFECTIVE_MODE_SRC_CONFIG_MODE = 0,       /* gateway.mode = "local"/"remote" */
    EFFECTIVE_MODE_SRC_CONFIG_REMOTE_URL = 1, /* gateway.remote.url present      */
    EFFECTIVE_MODE_SRC_PRODUCT_STATE = 2,     /* product_state persisted mode    */
    EFFECTIVE_MODE_SRC_ONBOARDING = 3,        /* onboarding-seen fallback        */
} EffectiveModeSource;

typedef struct {
    ProductConnectionMode mode;  /* never UNSPECIFIED at the boundary */
    EffectiveModeSource source;
} EffectiveConnectionMode;

/*
 * Resolve the effective mode from the inputs. Inputs may be NULL/zero.
 *
 *   config_mode          — value of gateway.mode (nullable; "local"/"remote"/other)
 *   config_has_remote_url — whether gateway.remote.url is present AND non-empty
 *   persisted_mode       — from product_state_get_connection_mode()
 *   onboarding_seen      — whether product_state_get_onboarding_seen_version() > 0
 */
EffectiveConnectionMode connection_mode_resolve(const gchar *config_mode,
                                                gboolean config_has_remote_url,
                                                ProductConnectionMode persisted_mode,
                                                gboolean onboarding_seen);

const gchar* connection_mode_source_to_string(EffectiveModeSource source);

#endif /* OPENCLAW_LINUX_CONNECTION_MODE_RESOLVER_H */
