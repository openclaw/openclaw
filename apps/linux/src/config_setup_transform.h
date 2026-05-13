#ifndef OPENCLAW_LINUX_CONFIG_SETUP_TRANSFORM_H
#define OPENCLAW_LINUX_CONFIG_SETUP_TRANSFORM_H

#include <glib.h>

gchar* config_setup_apply_provider(const gchar *raw_json,
                                   const gchar *provider_id,
                                   const gchar *base_url,
                                   GError **error);

gchar* config_setup_apply_default_model(const gchar *raw_json,
                                        const gchar *provider_id,
                                        const gchar *model_id,
                                        GError **error);

/*
 * Toggle the top-level `browser.enabled` flag in `raw_json`. When the
 * `browser` member is missing or holds a non-object value, it is
 * created/replaced with a fresh `{ "enabled": <bool> }` object so the
 * outcome is deterministic. Other members of `browser` are preserved.
 *
 * Returns a newly-allocated pretty-printed JSON string on success
 * (caller frees with g_free) or NULL on parse failure.
 */
gchar* config_setup_apply_browser_enabled(const gchar *raw_json,
                                          gboolean enabled,
                                          GError **error);

#endif
