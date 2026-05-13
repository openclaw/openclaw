/*
 * exec_approval_window.c
 *
 * AdwMessageDialog-based exec-approval prompt. See header for contract.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "exec_approval_window.h"

#include "log.h"

#include <adwaita.h>
#include <string.h>

typedef struct {
    OcExecApprovalRequest *req;
    OcExecDecisionCallback cb;
    gpointer               user_data;
    gboolean               silenced;
} ExecApprovalContext;

/* Track the currently-presented dialog for dismiss/raise. */
static AdwMessageDialog    *s_active_dialog = NULL;
static ExecApprovalContext *s_active_ctx    = NULL;

const gchar* oc_exec_decision_to_string(OcExecDecision d) {
    switch (d) {
    case OC_EXEC_DECISION_ALLOW_ONCE:   return "allow-once";
    case OC_EXEC_DECISION_ALLOW_ALWAYS: return "allow-always";
    case OC_EXEC_DECISION_DENY:
    default:                            return "deny";
    }
}

gboolean oc_exec_decision_from_string(const gchar *value, OcExecDecision *out) {
    if (!value || !out) return FALSE;
    if (g_strcmp0(value, "allow-once") == 0)   { *out = OC_EXEC_DECISION_ALLOW_ONCE;   return TRUE; }
    if (g_strcmp0(value, "allow-always") == 0) { *out = OC_EXEC_DECISION_ALLOW_ALWAYS; return TRUE; }
    if (g_strcmp0(value, "deny") == 0)         { *out = OC_EXEC_DECISION_DENY;         return TRUE; }
    return FALSE;
}

static void append_escaped(GString *out, const gchar *raw) {
    if (!raw || !raw[0]) return;
    g_autofree gchar *esc = g_markup_escape_text(raw, -1);
    if (esc) g_string_append(out, esc);
}

static void append_kv_row(GString *out, const gchar *label, const gchar *value) {
    if (!value || !value[0]) return;
    g_string_append(out, "<b>");
    append_escaped(out, label);
    g_string_append(out, ":</b> ");
    append_escaped(out, value);
    g_string_append_c(out, '\n');
}

gchar* oc_exec_approval_build_body_markup(const OcExecApprovalRequest *req) {
    GString *g = g_string_new(NULL);
    if (!req) return g_string_free(g, FALSE);

    if (req->command && req->command[0]) {
        g_string_append(g, "<b>Command</b>\n");
        g_string_append(g, "<tt>");
        append_escaped(g, req->command);
        g_string_append(g, "</tt>\n\n");
    }

    append_kv_row(g, "Working directory", req->cwd);
    append_kv_row(g, "Agent",             req->agent_id);
    append_kv_row(g, "Executable",        req->resolved_path);
    append_kv_row(g, "Host",              req->host);
    append_kv_row(g, "Security",          req->security);
    append_kv_row(g, "Ask mode",          req->ask);

    return g_string_free(g, FALSE);
}

static void exec_approval_context_free(gpointer data) {
    ExecApprovalContext *ctx = data;
    if (!ctx) return;
    oc_exec_approval_request_free(ctx->req);
    g_free(ctx);
}

static void on_dialog_response(AdwMessageDialog *dialog,
                               const char       *response,
                               gpointer          user_data) {
    ExecApprovalContext *ctx = user_data;

    /*
     * Remote-resolve path: the gateway told us another client handled
     * this request. Skip the decision callback and tear down quietly.
     * Mirrors `device_pair_approval_window.c::on_dialog_response`.
     */
    if (ctx->silenced) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "exec approval dialog silenced (remote resolve) id=%s",
                    ctx->req ? ctx->req->id : "(null)");
        if (s_active_dialog == dialog) {
            s_active_dialog = NULL;
            s_active_ctx    = NULL;
        }
        gtk_window_destroy(GTK_WINDOW(dialog));
        return;
    }

    OcExecDecision decision = OC_EXEC_DECISION_DENY;
    if (g_strcmp0(response, "allow-once") == 0)        decision = OC_EXEC_DECISION_ALLOW_ONCE;
    else if (g_strcmp0(response, "allow-always") == 0) decision = OC_EXEC_DECISION_ALLOW_ALWAYS;
    else                                               decision = OC_EXEC_DECISION_DENY;

    OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                "exec approval dialog response=%s id=%s",
                response ? response : "(null)",
                ctx->req ? ctx->req->id : "(null)");

    if (s_active_dialog == dialog) {
        s_active_dialog = NULL;
        s_active_ctx    = NULL;
    }
    if (ctx->cb) {
        ctx->cb(ctx->req, decision, ctx->user_data);
    }
    gtk_window_destroy(GTK_WINDOW(dialog));
}

void exec_approval_window_present(GtkWindow *parent,
                                  const OcExecApprovalRequest *req,
                                  OcExecDecisionCallback cb,
                                  gpointer user_data) {
    g_return_if_fail(req != NULL);

    ExecApprovalContext *ctx = g_new0(ExecApprovalContext, 1);
    ctx->req = oc_exec_approval_request_copy(req);
    ctx->cb = cb;
    ctx->user_data = user_data;

    g_autofree gchar *body = oc_exec_approval_build_body_markup(req);

    AdwMessageDialog *dialog = ADW_MESSAGE_DIALOG(adw_message_dialog_new(
        parent,
        "Allow this command?",
        NULL));
    adw_message_dialog_set_body_use_markup(dialog, TRUE);
    adw_message_dialog_set_body(dialog, body);

    gboolean allow_always_permitted =
        oc_exec_approval_request_allows_decision(req, "allow-always");

    if (allow_always_permitted) {
        adw_message_dialog_add_responses(dialog,
            "deny",         "Don't Allow",
            "allow-always", "Always Allow",
            "allow-once",   "Allow Once",
            NULL);
    } else {
        /* Hide the second button entirely — gateway will reject it.
         * Aligns with `request.allowedDecisions` contract. */
        adw_message_dialog_add_responses(dialog,
            "deny",       "Don't Allow",
            "allow-once", "Allow Once",
            NULL);
    }
    adw_message_dialog_set_response_appearance(dialog, "deny",       ADW_RESPONSE_DESTRUCTIVE);
    adw_message_dialog_set_response_appearance(dialog, "allow-once", ADW_RESPONSE_SUGGESTED);
    adw_message_dialog_set_default_response(dialog, "allow-once");
    /* Close-response = deny: dismissing the dialog (Esc, window-close, etc.)
     * must never accidentally allow a command. */
    adw_message_dialog_set_close_response(dialog, "deny");

    g_object_set_data_full(G_OBJECT(dialog),
                           "oc_exec_approval_ctx",
                           ctx,
                           exec_approval_context_free);
    g_signal_connect(dialog, "response", G_CALLBACK(on_dialog_response), ctx);

    s_active_dialog = dialog;
    s_active_ctx    = ctx;

    gtk_window_present(GTK_WINDOW(dialog));
}

gboolean exec_approval_window_dismiss_if(const gchar *request_id) {
    if (!request_id || !s_active_dialog || !s_active_ctx || !s_active_ctx->req) {
        return FALSE;
    }
    if (g_strcmp0(s_active_ctx->req->id, request_id) != 0) {
        return FALSE;
    }
    AdwMessageDialog *dialog = s_active_dialog;
    s_active_ctx->silenced = TRUE;
    /* Drive the response handler via the close response; on_dialog_response
     * honours `silenced` and skips the decision callback. */
    adw_message_dialog_response(dialog,
                                adw_message_dialog_get_close_response(dialog));
    return TRUE;
}

void exec_approval_window_raise_active(void) {
    if (s_active_dialog) {
        gtk_window_present(GTK_WINDOW(s_active_dialog));
    }
}
