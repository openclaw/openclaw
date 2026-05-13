/*
 * onboarding_wizard.c
 *
 * Client-side model for the Gateway setup wizard RPC flow.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "onboarding_wizard.h"

#include "gateway_rpc.h"

struct _OnboardingWizardModel {
    gint ref_count;
    guint generation;
    gboolean destroyed;
    gchar *session_id;
    JsonNode *step;
    OnboardingWizardStatus status;
    gchar *error;
    gboolean busy;
    OnboardingWizardChangedCallback callback;
    gpointer user_data;
};

typedef struct {
    OnboardingWizardModel *model;
    guint generation;
} OnboardingWizardCallbackContext;

static OnboardingWizardModel* wizard_model_ref(OnboardingWizardModel *model) {
    g_atomic_int_inc(&model->ref_count);
    return model;
}

static void wizard_model_unref(OnboardingWizardModel *model) {
    if (!model || !g_atomic_int_dec_and_test(&model->ref_count)) {
        return;
    }
    g_free(model->session_id);
    g_free(model->error);
    if (model->step) {
        json_node_unref(model->step);
    }
    g_free(model);
}

static OnboardingWizardCallbackContext* wizard_callback_context_new(OnboardingWizardModel *model) {
    OnboardingWizardCallbackContext *ctx = g_new0(OnboardingWizardCallbackContext, 1);
    ctx->model = wizard_model_ref(model);
    ctx->generation = model->generation;
    return ctx;
}

static void wizard_callback_context_free(OnboardingWizardCallbackContext *ctx) {
    if (!ctx) return;
    wizard_model_unref(ctx->model);
    g_free(ctx);
}

static gboolean wizard_callback_context_is_current(const OnboardingWizardCallbackContext *ctx) {
    return ctx && ctx->model && !ctx->model->destroyed &&
           ctx->generation == ctx->model->generation;
}

static void wizard_emit_changed(OnboardingWizardModel *model) {
    if (model && !model->destroyed && model->callback) {
        model->callback(model, model->user_data);
    }
}

static void wizard_set_error(OnboardingWizardModel *model, const gchar *message) {
    if (!model || model->destroyed) return;
    model->status = ONBOARDING_WIZARD_STATUS_ERROR;
    g_free(model->error);
    model->error = g_strdup(message ? message : "Wizard request failed.");
    model->busy = FALSE;
    wizard_emit_changed(model);
}

static const gchar* json_string_member(JsonObject *obj, const gchar *name) {
    if (!obj || !json_object_has_member(obj, name)) {
        return NULL;
    }
    JsonNode *node = json_object_get_member(obj, name);
    return node && JSON_NODE_HOLDS_VALUE(node) ? json_node_get_string(node) : NULL;
}

static gboolean json_bool_member(JsonObject *obj, const gchar *name) {
    if (!obj || !json_object_has_member(obj, name)) {
        return FALSE;
    }
    JsonNode *node = json_object_get_member(obj, name);
    return node && JSON_NODE_HOLDS_VALUE(node) ? json_node_get_boolean(node) : FALSE;
}

static void wizard_apply_result(OnboardingWizardModel *model, JsonNode *payload) {
    if (!payload || !JSON_NODE_HOLDS_OBJECT(payload)) {
        wizard_set_error(model, "Wizard response was not an object.");
        return;
    }
    JsonObject *obj = json_node_get_object(payload);
    const gchar *session_id = json_string_member(obj, "sessionId");
    if (session_id && session_id[0] != '\0') {
        g_free(model->session_id);
        model->session_id = g_strdup(session_id);
    }

    const gchar *status = json_string_member(obj, "status");
    gboolean done = json_bool_member(obj, "done");
    if (g_strcmp0(status, "done") == 0 || done) {
        model->status = ONBOARDING_WIZARD_STATUS_DONE;
        g_clear_pointer(&model->session_id, g_free);
    } else if (g_strcmp0(status, "cancelled") == 0) {
        model->status = ONBOARDING_WIZARD_STATUS_CANCELLED;
        g_clear_pointer(&model->session_id, g_free);
    } else if (g_strcmp0(status, "error") == 0) {
        model->status = ONBOARDING_WIZARD_STATUS_ERROR;
    } else {
        model->status = ONBOARDING_WIZARD_STATUS_RUNNING;
    }

    g_clear_pointer(&model->error, g_free);
    const gchar *error = json_string_member(obj, "error");
    model->error = g_strdup(error);

    if (model->step) {
        json_node_unref(model->step);
        model->step = NULL;
    }
    if (!done && json_object_has_member(obj, "step")) {
        JsonNode *step = json_object_get_member(obj, "step");
        if (step && JSON_NODE_HOLDS_OBJECT(step)) {
            model->step = json_node_copy(step);
        }
    }
    model->busy = FALSE;
    wizard_emit_changed(model);
}

static void wizard_rpc_done(const GatewayRpcResponse *response, gpointer user_data) {
    OnboardingWizardCallbackContext *ctx = user_data;
    if (!wizard_callback_context_is_current(ctx)) {
        wizard_callback_context_free(ctx);
        return;
    }
    OnboardingWizardModel *model = ctx->model;
    if (!response || !response->ok) {
        wizard_set_error(model, response && response->error_msg ? response->error_msg : "Wizard RPC failed.");
        wizard_callback_context_free(ctx);
        return;
    }
    wizard_apply_result(model, response->payload);
    wizard_callback_context_free(ctx);
}

OnboardingWizardModel* onboarding_wizard_model_new(OnboardingWizardChangedCallback callback,
                                                   gpointer user_data) {
    OnboardingWizardModel *model = g_new0(OnboardingWizardModel, 1);
    model->ref_count = 1;
    model->status = ONBOARDING_WIZARD_STATUS_IDLE;
    model->callback = callback;
    model->user_data = user_data;
    return model;
}

void onboarding_wizard_model_free(OnboardingWizardModel *model) {
    if (!model) return;
    model->destroyed = TRUE;
    model->generation++;
    model->callback = NULL;
    model->user_data = NULL;
    wizard_model_unref(model);
}

void onboarding_wizard_start(OnboardingWizardModel *model, const gchar *mode) {
    if (!model || model->destroyed) return;
    JsonBuilder *builder = json_builder_new();
    json_builder_begin_object(builder);
    if (mode && mode[0] != '\0') {
        json_builder_set_member_name(builder, "mode");
        json_builder_add_string_value(builder, mode);
    }
    json_builder_end_object(builder);
    g_autoptr(JsonNode) params = json_builder_get_root(builder);
    g_object_unref(builder);

    model->busy = TRUE;
    model->status = ONBOARDING_WIZARD_STATUS_RUNNING;
    model->generation++;
    OnboardingWizardCallbackContext *ctx = wizard_callback_context_new(model);
    g_autofree gchar *request_id = gateway_rpc_request("wizard.start", params, 0, wizard_rpc_done, ctx);
    if (!request_id) {
        wizard_callback_context_free(ctx);
        wizard_set_error(model, "Gateway RPC is not ready yet.");
    } else {
        wizard_emit_changed(model);
    }
}

void onboarding_wizard_submit(OnboardingWizardModel *model, JsonNode *value) {
    if (!model || model->destroyed || !model->session_id || !model->step || !JSON_NODE_HOLDS_OBJECT(model->step)) {
        wizard_set_error(model, "Wizard step is not ready.");
        return;
    }
    JsonObject *step = json_node_get_object(model->step);
    const gchar *step_id = json_string_member(step, "id");

    JsonBuilder *builder = json_builder_new();
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "sessionId");
    json_builder_add_string_value(builder, model->session_id);
    json_builder_set_member_name(builder, "answer");
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "stepId");
    json_builder_add_string_value(builder, step_id ? step_id : "");
    if (value) {
        json_builder_set_member_name(builder, "value");
        json_builder_add_value(builder, json_node_copy(value));
    }
    json_builder_end_object(builder);
    json_builder_end_object(builder);
    g_autoptr(JsonNode) params = json_builder_get_root(builder);
    g_object_unref(builder);

    model->busy = TRUE;
    model->generation++;
    OnboardingWizardCallbackContext *ctx = wizard_callback_context_new(model);
    g_autofree gchar *request_id = gateway_rpc_request("wizard.next", params, 0, wizard_rpc_done, ctx);
    if (!request_id) {
        wizard_callback_context_free(ctx);
        wizard_set_error(model, "Gateway RPC is not ready yet.");
    } else {
        wizard_emit_changed(model);
    }
}

void onboarding_wizard_cancel(OnboardingWizardModel *model) {
    if (!model || model->destroyed || !model->session_id) return;
    JsonBuilder *builder = json_builder_new();
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "sessionId");
    json_builder_add_string_value(builder, model->session_id);
    json_builder_end_object(builder);
    g_autoptr(JsonNode) params = json_builder_get_root(builder);
    g_object_unref(builder);

    model->busy = TRUE;
    model->generation++;
    OnboardingWizardCallbackContext *ctx = wizard_callback_context_new(model);
    g_autofree gchar *request_id = gateway_rpc_request("wizard.cancel", params, 0, wizard_rpc_done, ctx);
    if (!request_id) {
        wizard_callback_context_free(ctx);
        wizard_set_error(model, "Gateway RPC is not ready yet.");
    } else {
        wizard_emit_changed(model);
    }
}

OnboardingWizardStatus onboarding_wizard_get_status(const OnboardingWizardModel *model) {
    return model ? model->status : ONBOARDING_WIZARD_STATUS_ERROR;
}

const gchar* onboarding_wizard_get_error(const OnboardingWizardModel *model) {
    return model ? model->error : NULL;
}

const gchar* onboarding_wizard_get_session_id(const OnboardingWizardModel *model) {
    return model ? model->session_id : NULL;
}

JsonObject* onboarding_wizard_get_step(const OnboardingWizardModel *model) {
    if (!model || !model->step || !JSON_NODE_HOLDS_OBJECT(model->step)) {
        return NULL;
    }
    return json_node_get_object(model->step);
}

gboolean onboarding_wizard_is_busy(const OnboardingWizardModel *model) {
    return model ? model->busy : FALSE;
}

gboolean onboarding_wizard_should_skip_for_health(gboolean has_wizard_onboard_marker) {
    return has_wizard_onboard_marker;
}

