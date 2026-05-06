/*
 * device_pair_approval_window.c
 *
 * Adwaita alert dialog for device-pair approval on Linux.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "device_pair_approval_window.h"
#include "log.h"

#include <adwaita.h>
#include <glib.h>
#include <string.h>

typedef struct {
    OcPairRequestInfo      *info;     /* owned copy */
    OcPairDecisionCallback  callback;
    gpointer                user_data;
    /*
     * When TRUE, the response handler skips the decision callback. Set by
     * `device_pair_approval_window_dismiss_if()` so remote-resolved
     * requests close the dialog without emitting a "Later" RPC no-op or
     * re-queueing.
     */
    gboolean                silenced;
} DeviceApprovalContext;

/* Track the currently-presented dialog so remote resolve / tray raise
 * actions can reach into it without rebuilding every call site. */
static AdwMessageDialog      *s_active_dialog = NULL;
static DeviceApprovalContext *s_active_ctx    = NULL;

static void device_approval_context_free(gpointer data) {
    DeviceApprovalContext *ctx = data;
    if (!ctx) return;
    oc_pair_request_info_free(ctx->info);
    g_free(ctx);
}

/*
 * Body construction lives in `device_pair_request_info.c` as the pure
 * helper `oc_pair_approval_build_body_markup()`. All dynamic fields are
 * passed through `g_markup_escape_text()` there so hostile peer metadata
 * (e.g. `display_name = "<b>evil</b>"`) can't inject markup, spoof
 * formatting, or visually distort the approval prompt.
 */

static void on_dialog_response(AdwMessageDialog *dialog,
                               const char       *response,
                               gpointer          user_data)
{
    DeviceApprovalContext *ctx = user_data;

    /*
     * Remote-resolve path: the gateway told us another operator already
     * handled this request, so we silenced the dialog before closing it.
     * The decision callback must not fire (would trigger a spurious
     * Later RPC or re-queue) and the prompter has already advanced.
     */
    if (ctx->silenced) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "device pair approval dialog silenced (remote resolve) "
                    "request_id=%s",
                    ctx->info ? ctx->info->request_id : "(null)");
        if (s_active_dialog == dialog) {
            s_active_dialog = NULL;
            s_active_ctx    = NULL;
        }
        gtk_window_destroy(GTK_WINDOW(dialog));
        return;
    }

    OcPairDecision decision = OC_PAIR_DECISION_LATER;
    if (g_strcmp0(response, "approve") == 0) decision = OC_PAIR_DECISION_APPROVE;
    else if (g_strcmp0(response, "reject") == 0) decision = OC_PAIR_DECISION_REJECT;
    else decision = OC_PAIR_DECISION_LATER;

    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                "device pair approval dialog response=%s request_id=%s client_id=%s",
                response ? response : "(null)",
                ctx->info->request_id,
                ctx->info->client_id);

    if (s_active_dialog == dialog) {
        s_active_dialog = NULL;
        s_active_ctx    = NULL;
    }
    if (ctx->callback) {
        ctx->callback(ctx->info, decision, ctx->user_data);
    }
    gtk_window_destroy(GTK_WINDOW(dialog));
}

void device_pair_approval_window_present(GtkWindow *parent,
                                         const OcPairRequestInfo *info,
                                         OcPairDecisionCallback cb,
                                         gpointer user_data)
{
    g_return_if_fail(info != NULL);

    DeviceApprovalContext *ctx = g_new0(DeviceApprovalContext, 1);
    ctx->info = oc_pair_request_info_new(info->request_id,
                                         info->client_id,
                                         info->platform,
                                         info->display_name,
                                         info->host_address,
                                         info->requester_device_id,
                                         (const gchar * const *)info->scopes);
    ctx->callback = cb;
    ctx->user_data = user_data;

    g_autofree gchar *body = oc_pair_approval_build_body_markup(info);

    AdwMessageDialog *dialog = ADW_MESSAGE_DIALOG(adw_message_dialog_new(
        parent,
        "New device requesting to pair",
        NULL));
    adw_message_dialog_set_body_use_markup(dialog, TRUE);
    adw_message_dialog_set_body(dialog, body);

    adw_message_dialog_add_responses(dialog,
        "later",   "Later",
        "reject",  "Reject",
        "approve", "Approve",
        NULL);
    adw_message_dialog_set_response_appearance(dialog, "reject", ADW_RESPONSE_DESTRUCTIVE);
    adw_message_dialog_set_response_appearance(dialog, "approve", ADW_RESPONSE_SUGGESTED);
    adw_message_dialog_set_default_response(dialog, "approve");
    adw_message_dialog_set_close_response(dialog, "later");

    g_object_set_data_full(G_OBJECT(dialog),
                           "oc_approval_ctx",
                           ctx,
                           device_approval_context_free);
    g_signal_connect(dialog, "response", G_CALLBACK(on_dialog_response), ctx);

    /*
     * Only one pair approval dialog is ever active (queue is serialized);
     * track it so remote-resolve / tray-raise can find it without walking
     * the widget tree.
     */
    s_active_dialog = dialog;
    s_active_ctx    = ctx;

    gtk_window_present(GTK_WINDOW(dialog));
}

gboolean device_pair_approval_window_dismiss_if(const gchar *request_id) {
    if (!request_id || !s_active_dialog || !s_active_ctx || !s_active_ctx->info) {
        return FALSE;
    }
    if (g_strcmp0(s_active_ctx->info->request_id, request_id) != 0) {
        return FALSE;
    }
    AdwMessageDialog *dialog = s_active_dialog;
    s_active_ctx->silenced = TRUE;
    /* Fire the "close" response path; on_dialog_response honours `silenced`
     * and skips the decision callback before destroying the dialog. */
    adw_message_dialog_response(dialog,
                                adw_message_dialog_get_close_response(dialog));
    return TRUE;
}

void device_pair_approval_window_raise_active(void) {
    if (s_active_dialog) {
        gtk_window_present(GTK_WINDOW(s_active_dialog));
    }
}
