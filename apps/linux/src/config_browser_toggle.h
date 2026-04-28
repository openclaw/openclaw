/*
 * config_browser_toggle.h
 *
 * Orchestrates the Browser Control on/off toggle by chaining a fresh
 * `config.get` (when no recent baseline is cached), the
 * `config_setup_apply_browser_enabled` transform, and a `config.set`
 * RPC dispatch with the matching OCC base hash.
 *
 * The General section row and the tray helper share this entry point
 * so the in-app and tray surfaces resolve to the same mutation funnel.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_CONFIG_BROWSER_TOGGLE_H
#define OPENCLAW_LINUX_CONFIG_BROWSER_TOGGLE_H

#include <glib.h>

typedef enum {
    CONFIG_BROWSER_TOGGLE_OK = 0,
    /* `config.get` round-trip failed. */
    CONFIG_BROWSER_TOGGLE_ERR_FETCH_FAILED,
    /* The transform helper rejected the cached config. */
    CONFIG_BROWSER_TOGGLE_ERR_TRANSFORM_FAILED,
    /* `config.set` returned a non-OK response. The driver does NOT
     * retry — callers wishing to recover should refresh and re-issue. */
    CONFIG_BROWSER_TOGGLE_ERR_SAVE_FAILED,
} ConfigBrowserToggleStatus;

typedef struct {
    ConfigBrowserToggleStatus status;
    /* Borrowed; valid only for the duration of the callback. */
    const gchar *error_code;
    const gchar *error_msg;
} ConfigBrowserToggleResult;

typedef void (*ConfigBrowserToggleCb)(const ConfigBrowserToggleResult *result,
                                      gpointer user_data);

/*
 * Request a Browser Control toggle. Always reads the freshest config
 * from the gateway via `config.get` first so the OCC base hash matches
 * the gateway's snapshot at the time of `config.set`. The supplied
 * callback (if any) fires exactly once on completion (success or
 * failure).
 *
 * Safe to call when WS is disconnected: dispatch will fail fast and
 * the callback will fire with `CONFIG_BROWSER_TOGGLE_ERR_FETCH_FAILED`.
 */
void config_browser_toggle_request(gboolean enabled,
                                   ConfigBrowserToggleCb cb,
                                   gpointer user_data);

#endif /* OPENCLAW_LINUX_CONFIG_BROWSER_TOGGLE_H */
