/*
 * exec_approval_prompter.h
 *
 * Driver that subscribes to gateway `exec.approval.requested` /
 * `exec.approval.resolved` events and presents the Linux operator with a
 * single-active approval dialog, queueing concurrent inbound requests
 * and dispatching decisions back via `exec.approval.resolve` RPC.
 *
 * Architecturally parallel to `device_pair_prompter.h` — same lifecycle,
 * same parent-rebind semantics, same single-presented contract — but
 * targeting the exec-approval flow instead of device-pair approval.
 *
 * Public entry points are safe to call from the main thread only.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_EXEC_APPROVAL_PROMPTER_H
#define OPENCLAW_LINUX_EXEC_APPROVAL_PROMPTER_H

#include <gtk/gtk.h>
#include <glib.h>
#include <json-glib/json-glib.h>

#include "exec_approval_request.h"
#include "exec_approval_window.h"

/*
 * Initialize the prompter and subscribe to gateway events.
 * `parent` may be NULL; safe to call multiple times — subsequent calls
 * update the parent only.
 */
void exec_approval_prompter_init(GtkWindow *parent);

/* Unsubscribe and tear down all queued state. After this call, init may
 * be invoked again. */
void exec_approval_prompter_shutdown(void);

/* Update the parent window used for future approval dialogs. */
void exec_approval_prompter_set_parent(GtkWindow *parent);

/*
 * Number of pending exec approvals known to the prompter (queued plus
 * the currently-presented request, if any). Useful for future tray
 * badging; tray hookup itself is a later tranche.
 */
guint exec_approval_prompter_pending_count(void);

/*
 * Test seam: replace the window-present function with one that records
 * a decision immediately. Pass NULL to restore the default Adw dialog
 * presenter.
 *
 *   `req`            : ownership remains with the prompter; the test
 *                      may read it but must call `record_decision`
 *                      before returning or asynchronously.
 *   `record_decision`: invoke exactly once with the chosen decision.
 */
typedef void (*OcExecApprovalPresentHook)(const OcExecApprovalRequest *req,
                                          OcExecDecisionCallback record_decision,
                                          gpointer record_user_data,
                                          gpointer hook_user_data);

void exec_approval_prompter_test_set_present_hook(OcExecApprovalPresentHook hook,
                                                  gpointer hook_user_data);

/* Test seam: inject a synthetic `exec.approval.requested` payload as if
 * it arrived from the gateway event stream. */
void exec_approval_prompter_test_inject_event(JsonNode *payload);

/* Test seam: inject a synthetic `exec.approval.resolved` payload. */
void exec_approval_prompter_test_inject_resolved(JsonNode *payload);

/* Test seam: number of queued (not-yet-presented) requests. */
guint exec_approval_prompter_test_queue_len(void);

/* Test seam: whether a request is currently being presented. */
gboolean exec_approval_prompter_test_is_presenting(void);

/* Test seam: currently-tracked parent pointer (assertion only). */
gpointer exec_approval_prompter_test_get_parent(void);

#endif /* OPENCLAW_LINUX_EXEC_APPROVAL_PROMPTER_H */
