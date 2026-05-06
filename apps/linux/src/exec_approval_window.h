/*
 * exec_approval_window.h
 *
 * Native Linux operator-approval surface for inbound `exec.approval.requested`
 * events. Mirrors the macOS `ExecApprovalsPromptPresenter` (NSAlert-based
 * three-button flow) using AdwMessageDialog under libadwaita-1.
 *
 * Three decisions are offered:
 *   - Allow Once   : permit this command this time only
 *   - Always Allow : permit and remember (gateway adds to allowlist).
 *                    Hidden when the request's `allowedDecisions` excludes
 *                    "allow-always" (e.g. effective ask policy = always).
 *   - Don't Allow  : reject, treated as the close response so dismissing
 *                    the dialog never accidentally allows.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_EXEC_APPROVAL_WINDOW_H
#define OPENCLAW_LINUX_EXEC_APPROVAL_WINDOW_H

#include <gtk/gtk.h>

#include "exec_approval_request.h"

typedef enum {
    OC_EXEC_DECISION_ALLOW_ONCE = 0,
    OC_EXEC_DECISION_ALLOW_ALWAYS,
    OC_EXEC_DECISION_DENY,
} OcExecDecision;

/* Map a decision to its on-the-wire string ("allow-once" / "allow-always" /
 * "deny"), as required by `exec.approval.resolve` params. Never NULL. */
const gchar* oc_exec_decision_to_string(OcExecDecision decision);

/* Inverse of the above. Returns FALSE when `value` is unrecognised. */
gboolean oc_exec_decision_from_string(const gchar *value,
                                      OcExecDecision *out);

typedef void (*OcExecDecisionCallback)(const OcExecApprovalRequest *req,
                                       OcExecDecision decision,
                                       gpointer user_data);

/*
 * Present the approval dialog. The callback is invoked exactly once on
 * the main thread when the operator picks one of the three options or
 * dismisses the dialog (dismissal is reported as DENY).
 *
 * `parent` may be NULL.
 */
void exec_approval_window_present(GtkWindow *parent,
                                  const OcExecApprovalRequest *req,
                                  OcExecDecisionCallback cb,
                                  gpointer user_data);

/*
 * If the currently-presented approval dialog is for `request_id`, silently
 * close it WITHOUT firing the decision callback. Used when the gateway
 * signals `exec.approval.resolved` for a request another client handled.
 *
 * Returns TRUE when a dialog was dismissed.
 */
gboolean exec_approval_window_dismiss_if(const gchar *request_id);

/* Raise the active approval dialog if any. */
void exec_approval_window_raise_active(void);

/*
 * Build the Pango-markup body shown inside the dialog. All dynamic
 * fields are passed through `g_markup_escape_text()` before being
 * interpolated; only the wrapper tags (`<b>...</b>`) are raw markup.
 *
 * Pure helper: GLib-only. Exposed so tests can assert the escaping
 * contract without spinning up GTK / Adwaita.
 *
 * Caller frees with `g_free()`.
 */
gchar* oc_exec_approval_build_body_markup(const OcExecApprovalRequest *req);

#endif /* OPENCLAW_LINUX_EXEC_APPROVAL_WINDOW_H */
