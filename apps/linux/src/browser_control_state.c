/*
 * browser_control_state.c
 *
 * See browser_control_state.h for the public contract. The module is
 * pure-C / GTK-free so it can be unit tested headlessly via the
 * transport seam.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "browser_control_state.h"

typedef struct {
    guint id;
    BrowserControlStateChangedCb cb;
    gpointer user_data;
} Subscriber;

typedef struct {
    /* Cached value + known flag. The `enabled` field is meaningful
     * only when `known == TRUE`. */
    gboolean enabled;
    gboolean known;

    /* TRUE while a refresh is in flight; suppresses a second refresh
     * being issued in parallel. */
    gboolean refreshing;

    /* Generation counter that bumps on every state-clearing reset so
     * stale callbacks from a previous test/init are dropped. */
    guint generation;

    /* Transport seam — NULL until the host installs one. */
    BrowserControlStateTransport transport;
    gboolean transport_installed;

    /* Subscribers. We use a GSList so iteration cost is linear in the
     * (small) number of UI surfaces; subscriber removal during a
     * notification is the only tricky case and is handled via a
     * per-iteration capture. */
    GSList *subscribers;
    guint   next_subscription_id;
} BrowserControlState;

static BrowserControlState g_state;

/* ── lifecycle ─────────────────────────────────────────────────── */

void browser_control_state_init(void) {
    /* Reset to a deterministic baseline. Idempotent; safe to call
     * multiple times in the same process. */
    g_state.enabled = FALSE;
    g_state.known = FALSE;
    g_state.refreshing = FALSE;
    g_state.generation++;
    g_state.transport.refresh = NULL;
    g_state.transport.save = NULL;
    g_state.transport_installed = FALSE;
    /* Preserve any active subscribers across init() calls so the
     * General section / tray can subscribe before init runs without
     * losing their registration. */
    if (g_state.next_subscription_id == 0) {
        g_state.next_subscription_id = 1;
    }
}

void browser_control_state_test_reset(void) {
    g_slist_free_full(g_state.subscribers, g_free);
    g_state.subscribers = NULL;
    g_state.next_subscription_id = 1;
    g_state.enabled = FALSE;
    g_state.known = FALSE;
    g_state.refreshing = FALSE;
    g_state.generation++;
    g_state.transport.refresh = NULL;
    g_state.transport.save = NULL;
    g_state.transport_installed = FALSE;
}

void browser_control_state_set_transport(const BrowserControlStateTransport *transport) {
    if (!transport) {
        g_state.transport.refresh = NULL;
        g_state.transport.save = NULL;
        g_state.transport_installed = FALSE;
        return;
    }
    g_state.transport = *transport;
    g_state.transport_installed = TRUE;
}

/* ── accessors ─────────────────────────────────────────────────── */

void browser_control_state_get(gboolean *out_enabled, gboolean *out_known) {
    if (out_enabled) *out_enabled = g_state.enabled;
    if (out_known)   *out_known   = g_state.known;
}

gboolean browser_control_state_is_refreshing(void) {
    return g_state.refreshing;
}

/* ── subscribers ───────────────────────────────────────────────── */

guint browser_control_state_subscribe(BrowserControlStateChangedCb cb, gpointer user_data) {
    if (!cb) return 0;
    /* Normalize the counter BEFORE assigning so pre-init subscribers
     * (who observe a zero-initialized `g_state`) never receive the
     * invalid id 0. The public API documents 0 as invalid and
     * `browser_control_state_init` preserves subscribers across init
     * calls, so this path must stay valid. */
    if (g_state.next_subscription_id == 0) g_state.next_subscription_id = 1;
    Subscriber *s = g_new0(Subscriber, 1);
    s->id = g_state.next_subscription_id++;
    if (g_state.next_subscription_id == 0) g_state.next_subscription_id = 1; /* wrap guard */
    s->cb = cb;
    s->user_data = user_data;
    g_state.subscribers = g_slist_append(g_state.subscribers, s);
    return s->id;
}

void browser_control_state_unsubscribe(guint id) {
    if (id == 0) return;
    for (GSList *it = g_state.subscribers; it; it = it->next) {
        Subscriber *s = it->data;
        if (s && s->id == id) {
            g_state.subscribers = g_slist_remove(g_state.subscribers, s);
            g_free(s);
            return;
        }
    }
}

static void notify_subscribers(void) {
    /* Snapshot the list because subscribers may unsubscribe inside
     * their callback (e.g., during section_general teardown). */
    GSList *snapshot = g_slist_copy(g_state.subscribers);
    for (GSList *it = snapshot; it; it = it->next) {
        Subscriber *s = it->data;
        /* Ensure the subscriber still exists on the live list before
         * invoking; another callback in this loop may have removed it. */
        if (g_slist_find(g_state.subscribers, s) && s && s->cb) {
            s->cb(s->user_data);
        }
    }
    g_slist_free(snapshot);
}

/* ── refresh ───────────────────────────────────────────────────── */

typedef struct {
    guint generation;
} RefreshCtx;

static void on_refresh_complete(gboolean ok,
                                gboolean enabled,
                                const gchar *error_msg,
                                gpointer ctx) {
    (void)error_msg;
    RefreshCtx *rc = ctx;
    gboolean current = rc && rc->generation == g_state.generation;
    g_free(rc);

    if (!current) return; /* stale — module was reset since dispatch */

    g_state.refreshing = FALSE;
    if (ok) {
        g_state.enabled = enabled ? TRUE : FALSE;
        g_state.known = TRUE;
    }
    /* Failure leaves cache untouched. Subscribers are notified
     * regardless so a "Loading…" subtitle can clear. */
    notify_subscribers();
}

void browser_control_state_refresh(void) {
    if (g_state.refreshing) return; /* coalesce concurrent refreshes */
    if (!g_state.transport_installed || !g_state.transport.refresh) {
        /* No transport yet — silently no-op. The next caller (after
         * the host wires the transport) will retry. */
        return;
    }
    g_state.refreshing = TRUE;
    RefreshCtx *ctx = g_new0(RefreshCtx, 1);
    ctx->generation = g_state.generation;
    g_state.transport.refresh(on_refresh_complete, ctx);
}

/* ── request_set ───────────────────────────────────────────────── */

typedef struct {
    guint generation;
    gboolean attempted_enabled;
    BrowserControlStateSetDoneCb user_cb;
    gpointer user_data;
} SetCtx;

static void on_save_complete(gboolean ok,
                             const gchar *error_msg,
                             gpointer ctx) {
    SetCtx *sc = ctx;
    SetCtx local = sc ? *sc : (SetCtx){0};
    gboolean current = sc && sc->generation == g_state.generation;
    g_free(sc);

    if (!current) {
        /* Stale (post-reset) — invoke the user callback with a
         * "save failed" so they don't hang waiting for a result, but
         * do not touch cache or subscribers. */
        if (local.user_cb) {
            BrowserControlStateSetResult result = {
                .status = BROWSER_CONTROL_STATE_ERR_SAVE_FAILED,
                .attempted_enabled = local.attempted_enabled,
                .error_msg = "STATE_RESET",
            };
            local.user_cb(&result, local.user_data);
        }
        return;
    }

    BrowserControlStateSetResult result = {
        .status = ok ? BROWSER_CONTROL_STATE_OK
                     : BROWSER_CONTROL_STATE_ERR_SAVE_FAILED,
        .attempted_enabled = local.attempted_enabled,
        .error_msg = error_msg,
    };

    if (ok) {
        g_state.enabled = local.attempted_enabled ? TRUE : FALSE;
        g_state.known = TRUE;
    }
    /* Notify subscribers BEFORE invoking the per-call user callback
     * so subscribers (e.g., the section row) can repaint to the new
     * authoritative state, and the user_cb can rely on `_get`
     * reflecting that. */
    notify_subscribers();

    if (local.user_cb) local.user_cb(&result, local.user_data);
}

void browser_control_state_request_set(gboolean enabled,
                                       BrowserControlStateSetDoneCb cb,
                                       gpointer user_data) {
    if (!g_state.transport_installed || !g_state.transport.save) {
        /* No transport yet — synthesise a SAVE_FAILED result so the
         * caller doesn't hang. */
        if (cb) {
            BrowserControlStateSetResult result = {
                .status = BROWSER_CONTROL_STATE_ERR_SAVE_FAILED,
                .attempted_enabled = enabled ? TRUE : FALSE,
                .error_msg = "NO_TRANSPORT",
            };
            cb(&result, user_data);
        }
        return;
    }

    SetCtx *ctx = g_new0(SetCtx, 1);
    ctx->generation = g_state.generation;
    ctx->attempted_enabled = enabled ? TRUE : FALSE;
    ctx->user_cb = cb;
    ctx->user_data = user_data;
    g_state.transport.save(ctx->attempted_enabled, on_save_complete, ctx);
}
