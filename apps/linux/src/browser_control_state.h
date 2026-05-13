/*
 * browser_control_state.h
 *
 * Shared, async-aware view of the gateway's `browser.enabled` flag.
 *
 * Both the General-section row and the system tray subscribe to this
 * module so the displayed Browser Control state matches the gateway
 * regardless of which surface is mounted first. The module is GTK-free
 * — UI surfaces fetch state through `browser_control_state_get` and
 * repaint when their subscriber callback fires.
 *
 * The module dispatches `config.get` and `config.set` through a small
 * function-pointer transport so production code can wire it to the real
 * RPC stack and tests can drive it with stubs without spinning up the
 * gateway.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_BROWSER_CONTROL_STATE_H
#define OPENCLAW_LINUX_BROWSER_CONTROL_STATE_H

#include <glib.h>

typedef enum {
    BROWSER_CONTROL_STATE_OK = 0,
    BROWSER_CONTROL_STATE_ERR_FETCH_FAILED,
    BROWSER_CONTROL_STATE_ERR_SAVE_FAILED,
} BrowserControlStateStatus;

typedef struct {
    BrowserControlStateStatus status;
    /* The flag the caller attempted to set; on the success path this
     * matches the new cached value, on the failure path the cached
     * value is unchanged. */
    gboolean attempted_enabled;
    /* Borrowed; only valid for the duration of the callback. */
    const gchar *error_msg;
} BrowserControlStateSetResult;

typedef void (*BrowserControlStateChangedCb)(gpointer user_data);
typedef void (*BrowserControlStateSetDoneCb)(const BrowserControlStateSetResult *result,
                                             gpointer user_data);

/* ── transport seam ─────────────────────────────────────────────── */

typedef void (*BrowserControlRefreshCb)(gboolean ok,
                                        gboolean enabled,
                                        const gchar *error_msg,
                                        gpointer ctx);

typedef void (*BrowserControlSaveCb)(gboolean ok,
                                     const gchar *error_msg,
                                     gpointer ctx);

typedef struct {
    /* Issue a `config.get`; on completion call `cb(ok, enabled, err, ctx)`. */
    void (*refresh)(BrowserControlRefreshCb cb, gpointer ctx);
    /* Issue a transformed `config.set` for `browser.enabled = enabled`;
     * on completion call `cb(ok, err, ctx)`. */
    void (*save)(gboolean enabled, BrowserControlSaveCb cb, gpointer ctx);
} BrowserControlStateTransport;

/* ── public state API ──────────────────────────────────────────── */

void browser_control_state_init(void);

/*
 * Install the transport that bridges to the real gateway RPC stack.
 * Pass NULL to detach (e.g., during shutdown). Tests install a stub.
 */
void browser_control_state_set_transport(const BrowserControlStateTransport *transport);

/*
 * Read the cached value. `*out_known` becomes TRUE iff a successful
 * `refresh` or `request_set` has populated the cache. Either pointer
 * may be NULL.
 */
void browser_control_state_get(gboolean *out_enabled, gboolean *out_known);

/* TRUE while a `config.get` round-trip is in flight. */
gboolean browser_control_state_is_refreshing(void);

/*
 * Issue a `config.get` so the cache reflects gateway truth. No-op if
 * a refresh is already in flight or no transport is installed. Safe
 * to call when WS is disconnected: the transport will fail fast and
 * subscribers will fire with `known == FALSE` preserved.
 */
void browser_control_state_refresh(void);

/*
 * Request a Browser Control toggle. The supplied callback (if any)
 * fires exactly once on completion — success means the cache has been
 * updated and subscribers have fired; failure leaves the cache
 * untouched and surfaces the error in the result.
 */
void browser_control_state_request_set(gboolean enabled,
                                       BrowserControlStateSetDoneCb cb,
                                       gpointer user_data);

/*
 * Subscribe / unsubscribe to be notified of cache changes. The
 * callback fires on every refresh and set completion regardless of
 * outcome — subscribers should re-query via `browser_control_state_get`
 * to render the latest state. Returns a non-zero subscription id; 0
 * is returned only for invalid input.
 */
guint browser_control_state_subscribe(BrowserControlStateChangedCb cb,
                                      gpointer user_data);
void  browser_control_state_unsubscribe(guint id);

/*
 * Tests-only: drop subscribers, transport, and cache so each test
 * starts from a deterministic baseline.
 */
void browser_control_state_test_reset(void);

#endif /* OPENCLAW_LINUX_BROWSER_CONTROL_STATE_H */
