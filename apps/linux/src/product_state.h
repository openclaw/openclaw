#pragma once

#include <glib.h>

typedef enum {
    PRODUCT_CONNECTION_MODE_UNSPECIFIED = 0,
    PRODUCT_CONNECTION_MODE_LOCAL = 1,
    PRODUCT_CONNECTION_MODE_REMOTE = 2,
} ProductConnectionMode;

typedef struct {
    ProductConnectionMode connection_mode;
    guint onboarding_seen_version;
    gboolean heartbeats_enabled;
} ProductStateSnapshot;

void product_state_init(void);
void product_state_get_snapshot(ProductStateSnapshot *out);
ProductConnectionMode product_state_get_connection_mode(void);
ProductConnectionMode product_state_get_effective_connection_mode(void);
gboolean product_state_set_connection_mode(ProductConnectionMode mode);
guint product_state_get_onboarding_seen_version(void);
gboolean product_state_set_onboarding_seen_version(guint version);
gboolean product_state_reset_onboarding_seen_version(void);

/*
 * Persisted operator intent for whether the Linux companion asks the
 * gateway to emit heartbeats. Default on fresh installs is TRUE,
 * mirroring the macOS default (`heartbeatsEnabled` in AppState.swift).
 */
gboolean product_state_get_heartbeats_enabled(void);
gboolean product_state_set_heartbeats_enabled(gboolean enabled);

void product_state_test_set_storage_path(const gchar *path);
void product_state_test_set_legacy_marker_path(const gchar *path);
void product_state_test_reset(void);
