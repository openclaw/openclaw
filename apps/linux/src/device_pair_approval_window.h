/*
 * device_pair_approval_window.h
 *
 * Native Linux operator-approval surface for inbound device-pair requests,
 * mirrors the macOS `DevicePairingApprovalPrompter` (NSAlert-based flow).
 *
 * The window is presented as an Adwaita alert dialog transient to the main
 * app window. It offers three decisions:
 *   - Approve : the operator authorizes the pairing request
 *   - Reject  : the operator explicitly denies the request
 *   - Later   : the request is deferred (not decided, re-queued)
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_DEVICE_PAIR_APPROVAL_WINDOW_H
#define OPENCLAW_LINUX_DEVICE_PAIR_APPROVAL_WINDOW_H

#include <gtk/gtk.h>

typedef enum {
    OC_PAIR_DECISION_APPROVE,
    OC_PAIR_DECISION_REJECT,
    OC_PAIR_DECISION_LATER
} OcPairDecision;

typedef struct {
    gchar  *request_id;    /* server-issued pairing request id */
    gchar  *client_id;     /* e.g. openclaw-linux, openclaw-macos, openclaw-web */
    gchar  *platform;      /* "linux" | "darwin" | "web" ... */
    gchar  *display_name;  /* human-friendly device name */
    gchar  *host_address;  /* peer address string, if available */
    gchar  *requester_device_id; /* requester's deviceId (lowercase-hex sha256 of public key);
                                  * used to filter out self-originated pair requests so this
                                  * companion never tries to approve its own handshake. */
    gchar **scopes;        /* NULL-terminated list of requested scopes */
} OcPairRequestInfo;

typedef void (*OcPairDecisionCallback)(const OcPairRequestInfo *info,
                                       OcPairDecision decision,
                                       gpointer user_data);

OcPairRequestInfo* oc_pair_request_info_new(const gchar  *request_id,
                                            const gchar  *client_id,
                                            const gchar  *platform,
                                            const gchar  *display_name,
                                            const gchar  *host_address,
                                            const gchar  *requester_device_id,
                                            const gchar * const *scopes);
void oc_pair_request_info_free(OcPairRequestInfo *info);

G_DEFINE_AUTOPTR_CLEANUP_FUNC(OcPairRequestInfo, oc_pair_request_info_free)

/*
 * Present the approval dialog. The callback is invoked on the main thread
 * when the operator picks one of the three options or closes the dialog
 * (closing is treated as Later, matching the macOS "defer" semantics).
 *
 * parent may be NULL; when provided the dialog is transient for it.
 */
void device_pair_approval_window_present(GtkWindow *parent,
                                         const OcPairRequestInfo *info,
                                         OcPairDecisionCallback cb,
                                         gpointer user_data);

/*
 * If the currently-presented approval dialog is for `request_id`, silently
 * close it *without* firing the decision callback. Used when the gateway
 * signals `device.pair.resolved` for a request another operator handled.
 *
 * Returns TRUE when a dialog was dismissed, FALSE when the currently-
 * presented dialog (if any) did not match `request_id`.
 */
gboolean device_pair_approval_window_dismiss_if(const gchar *request_id);

/*
 * Raise the currently-presented approval dialog to the foreground, if any.
 * Used by the tray "Pairing…" action. No-op when no dialog is on screen.
 */
void device_pair_approval_window_raise_active(void);

/*
 * Build the Pango-markup body text shown inside the approval dialog.
 *
 * The returned string is rendered by `AdwMessageDialog` with markup
 * enabled, so every dynamic field from `info` (display_name, client_id,
 * platform, host_address, and each scope) is passed through
 * `g_markup_escape_text()` before being interpolated into the template.
 * Only the static app-authored markers (e.g. `<b>…</b>`) are raw markup.
 * This is what prevents hostile peer-supplied values from spoofing or
 * distorting the approval surface.
 *
 * Pure helper: no GTK / Adwaita dependency. Exposed here so unit tests
 * can assert the escaping contract directly.
 *
 * Returned string is g_malloc'd; free with `g_free()`.
 */
gchar* oc_pair_approval_build_body_markup(const OcPairRequestInfo *info);

#endif /* OPENCLAW_LINUX_DEVICE_PAIR_APPROVAL_WINDOW_H */
