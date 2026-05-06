/*
 * device_pair_prompter.h
 *
 * Driver that subscribes to gateway pairing events and presents the Linux
 * approval UX one-at-a-time. Concurrent inbound pair requests are
 * serialized, decisions are dispatched back to the gateway via RPC, and
 * the PAIRING_REQUIRED bootstrap window is shown when the Linux companion's
 * own handshake needs operator approval — with local CLI approval on this
 * machine (`openclaw devices pair approve <requestId>`) as the primary
 * path and any other authorized operator surface as an optional
 * alternate.
 *
 * (Queue semantics mirror the shared `DevicePairingApprovalPrompter`
 * contract used by the other OpenClaw clients.)
 *
 * Public entry points are safe to call from the main thread only.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_DEVICE_PAIR_PROMPTER_H
#define OPENCLAW_LINUX_DEVICE_PAIR_PROMPTER_H

#include <gtk/gtk.h>
#include <glib.h>
#include <json-glib/json-glib.h>

#include "device_pair_approval_window.h"

/*
 * Initialize the prompter and subscribe to gateway pairing events.
 * parent may be NULL; if provided, pairing windows will be transient for it.
 * Safe to call multiple times; subsequent calls update the parent only.
 */
void device_pair_prompter_init(GtkWindow *parent);

/*
 * Unsubscribe from gateway events and clear any queued pending request.
 * After shutdown, init may be called again.
 */
void device_pair_prompter_shutdown(void);

/*
 * Issue a `device.pair.list` RPC and seed the approval queue with any
 * already-pending requests. Should be called whenever the gateway WS
 * transport transitions to authenticated/CONNECTED so Linux approvers
 * don't miss requests that arrived while we were offline.
 *
 * Safe to call multiple times; the prompter dedupes against the existing
 * queue and active request so no duplicates are enqueued.
 */
void device_pair_prompter_seed_from_server(void);

/*
 * Number of pending pair approvals known to the prompter. Counts both the
 * currently-presented request (if any) and all queued-but-not-yet-presented
 * requests. Used by the tray to show an actionable badge and gate the
 * "Pairing…" menu item.
 */
guint device_pair_prompter_pending_count(void);

/*
 * Raise the most relevant pairing surface to the foreground:
 *   - if a PAIRING_REQUIRED bootstrap window is up, present it;
 *   - else if an approval dialog is being presented, raise it;
 *   - else no-op.
 *
 * Called from the tray "Pairing…" action.
 */
void device_pair_prompter_raise(void);

/*
 * Single-owner hook for "the transport finished pairing / is now
 * authenticated" transitions. Currently hides the bootstrap window
 * (which is only meaningful while the local handshake is blocked on
 * pair approval). Called from the WS status handler on CONNECTED.
 *
 * Centralises bootstrap-surface lifetime in the prompter so no other
 * module independently drives `pairing_bootstrap_window_*` APIs.
 */
void device_pair_prompter_notify_transport_authenticated(void);

/*
 * Update the parent window used for future pairing dialogs.
 * Used when the main app window is created or re-created.
 */
void device_pair_prompter_set_parent(GtkWindow *parent);

/*
 * Test seam: replace the window-present function with one that records a
 * decision immediately (for headless unit tests). Passing NULL restores the
 * default Adw dialog presenter. The function must be re-entrant; the prompter
 * will call it one request at a time.
 *
 *   info     : ownership remains with the prompter; the test may read it,
 *              must not free it, and must call `record_decision` before
 *              returning or asynchronously.
 *   record   : helper to finalize the decision; must be invoked exactly once
 *              per presented request.
 */
typedef void (*OcPairPresentHook)(const OcPairRequestInfo *info,
                                  OcPairDecisionCallback   record_decision,
                                  gpointer                 record_user_data,
                                  gpointer                 hook_user_data);

void device_pair_prompter_test_set_present_hook(OcPairPresentHook hook,
                                                gpointer          hook_user_data);

/*
 * Test seam: inject a synthetic `device.pair.requested` payload as if it had
 * arrived from the gateway event stream. The payload JsonNode is NOT retained.
 */
void device_pair_prompter_test_inject_event(JsonNode *payload);

/*
 * Test seam: inject a synthetic `device.pair.resolved` payload. Mirrors the
 * production handler: dismisses the currently-presented request when its
 * id matches and removes any matching entry from the queue.
 */
void device_pair_prompter_test_inject_resolved(JsonNode *payload);

/*
 * Test seam: seed the queue from a `device.pair.list`-shaped payload
 * (`{ "requests": [ { "requestId": ..., ... }, ... ] }`). Used by tests
 * that want to exercise the list-seeding path without a real RPC layer.
 */
void device_pair_prompter_test_seed_from_payload(JsonNode *payload);

/* Test seam: number of queued (not-yet-presented) requests. */
guint device_pair_prompter_test_queue_len(void);

/* Test seam: whether a request is currently being presented. */
gboolean device_pair_prompter_test_is_presenting(void);

/*
 * Test seam: returns the currently-tracked parent pointer (may be NULL).
 * For assertion only — the test must not dereference it.
 */
gpointer device_pair_prompter_test_get_parent(void);

/*
 * Test seam: simulate the parent window being finalized. Invokes the
 * same weak-ref callback the real GObject finalizer would, without
 * requiring a live GtkWindow. No-op if `addr` doesn't match the
 * currently-tracked parent.
 */
void device_pair_prompter_test_simulate_parent_destroyed(gpointer addr);

#endif /* OPENCLAW_LINUX_DEVICE_PAIR_PROMPTER_H */
