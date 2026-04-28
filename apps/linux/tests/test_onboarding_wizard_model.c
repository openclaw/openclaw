/*
 * test_onboarding_wizard_model.c
 *
 * Headless coverage for the Linux onboarding wizard RPC model.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/onboarding_wizard.h"
#include "../src/gateway_rpc.h"

#include <glib.h>

typedef struct {
    gchar *method;
    JsonNode *params;
    GatewayRpcCallback callback;
    gpointer user_data;
} CapturedRequest;

static CapturedRequest captured[8];
static guint captured_count = 0;
static gboolean rpc_return_null = FALSE;
static guint change_count = 0;

static void clear_captured(void) {
    for (guint i = 0; i < G_N_ELEMENTS(captured); i++) {
        g_clear_pointer(&captured[i].method, g_free);
        if (captured[i].params) {
            json_node_unref(captured[i].params);
            captured[i].params = NULL;
        }
        captured[i].callback = NULL;
        captured[i].user_data = NULL;
    }
    captured_count = 0;
    rpc_return_null = FALSE;
    change_count = 0;
}

gchar* gateway_rpc_request(const gchar *method,
                           JsonNode *params_json,
                           guint timeout_ms,
                           GatewayRpcCallback callback,
                           gpointer user_data) {
    (void)timeout_ms;
    if (rpc_return_null) {
        return NULL;
    }
    g_assert_cmpuint(captured_count, <, G_N_ELEMENTS(captured));
    CapturedRequest *req = &captured[captured_count++];
    req->method = g_strdup(method);
    req->params = params_json ? json_node_copy(params_json) : NULL;
    req->callback = callback;
    req->user_data = user_data;
    return g_strdup_printf("req-%u", captured_count);
}

static void on_wizard_changed(OnboardingWizardModel *model, gpointer user_data) {
    (void)model;
    (void)user_data;
    change_count++;
}

static const gchar* object_string(JsonObject *obj, const gchar *member) {
    JsonNode *node = json_object_get_member(obj, member);
    return node && JSON_NODE_HOLDS_VALUE(node) ? json_node_get_string(node) : NULL;
}

static JsonNode* wizard_result_node(const gchar *session_id,
                                    const gchar *step_id,
                                    gboolean done) {
    JsonBuilder *builder = json_builder_new();
    json_builder_begin_object(builder);
    if (session_id) {
        json_builder_set_member_name(builder, "sessionId");
        json_builder_add_string_value(builder, session_id);
    }
    json_builder_set_member_name(builder, "done");
    json_builder_add_boolean_value(builder, done);
    json_builder_set_member_name(builder, "status");
    json_builder_add_string_value(builder, done ? "done" : "running");
    if (step_id) {
        json_builder_set_member_name(builder, "step");
        json_builder_begin_object(builder);
        json_builder_set_member_name(builder, "id");
        json_builder_add_string_value(builder, step_id);
        json_builder_set_member_name(builder, "type");
        json_builder_add_string_value(builder, "text");
        json_builder_set_member_name(builder, "title");
        json_builder_add_string_value(builder, "Step");
        json_builder_end_object(builder);
    }
    json_builder_end_object(builder);
    JsonNode *node = json_builder_get_root(builder);
    g_object_unref(builder);
    return node;
}

static void deliver_success(guint index, JsonNode *payload) {
    GatewayRpcResponse response = {
        .ok = TRUE,
        .payload = payload,
    };
    captured[index].callback(&response, captured[index].user_data);
}

static void test_start_happy_path(void) {
    clear_captured();
    OnboardingWizardModel *model = onboarding_wizard_model_new(on_wizard_changed, NULL);

    onboarding_wizard_start(model, "local");
    g_assert_cmpuint(captured_count, ==, 1);
    g_assert_cmpstr(captured[0].method, ==, "wizard.start");
    JsonObject *params = json_node_get_object(captured[0].params);
    g_assert_cmpstr(object_string(params, "mode"), ==, "local");

    g_autoptr(JsonNode) result = wizard_result_node("session-1", "step-1", FALSE);
    deliver_success(0, result);
    g_assert_cmpstr(onboarding_wizard_get_session_id(model), ==, "session-1");
    JsonObject *step = onboarding_wizard_get_step(model);
    g_assert_nonnull(step);
    g_assert_cmpstr(object_string(step, "id"), ==, "step-1");
    g_assert_cmpint(onboarding_wizard_get_status(model), ==, ONBOARDING_WIZARD_STATUS_RUNNING);
    g_assert_cmpuint(change_count, ==, 2);

    onboarding_wizard_model_free(model);
    clear_captured();
}

static void test_next_happy_path(void) {
    clear_captured();
    OnboardingWizardModel *model = onboarding_wizard_model_new(on_wizard_changed, NULL);
    onboarding_wizard_start(model, "local");
    g_autoptr(JsonNode) start_result = wizard_result_node("session-1", "step-1", FALSE);
    deliver_success(0, start_result);

    g_autoptr(JsonNode) value = json_node_new(JSON_NODE_VALUE);
    json_node_set_string(value, "answer");
    onboarding_wizard_submit(model, value);

    g_assert_cmpuint(captured_count, ==, 2);
    g_assert_cmpstr(captured[1].method, ==, "wizard.next");
    JsonObject *params = json_node_get_object(captured[1].params);
    g_assert_cmpstr(object_string(params, "sessionId"), ==, "session-1");
    JsonObject *answer = json_object_get_object_member(params, "answer");
    g_assert_cmpstr(object_string(answer, "stepId"), ==, "step-1");
    g_assert_cmpstr(object_string(answer, "value"), ==, "answer");

    onboarding_wizard_model_free(model);
    clear_captured();
}

static void test_cancel_happy_path(void) {
    clear_captured();
    OnboardingWizardModel *model = onboarding_wizard_model_new(on_wizard_changed, NULL);
    onboarding_wizard_start(model, "local");
    g_autoptr(JsonNode) start_result = wizard_result_node("session-1", "step-1", FALSE);
    deliver_success(0, start_result);

    onboarding_wizard_cancel(model);
    g_assert_cmpuint(captured_count, ==, 2);
    g_assert_cmpstr(captured[1].method, ==, "wizard.cancel");
    JsonObject *params = json_node_get_object(captured[1].params);
    g_assert_cmpstr(object_string(params, "sessionId"), ==, "session-1");

    onboarding_wizard_model_free(model);
    clear_captured();
}

static void test_rpc_not_ready_sets_error(void) {
    clear_captured();
    rpc_return_null = TRUE;
    OnboardingWizardModel *model = onboarding_wizard_model_new(on_wizard_changed, NULL);
    onboarding_wizard_start(model, "local");

    g_assert_cmpint(onboarding_wizard_get_status(model), ==, ONBOARDING_WIZARD_STATUS_ERROR);
    g_assert_cmpstr(onboarding_wizard_get_error(model), ==, "Gateway RPC is not ready yet.");
    g_assert_cmpuint(change_count, ==, 1);

    onboarding_wizard_model_free(model);
    clear_captured();
}

static void test_model_free_before_callback(void) {
    clear_captured();
    OnboardingWizardModel *model = onboarding_wizard_model_new(on_wizard_changed, NULL);
    onboarding_wizard_start(model, "local");
    g_assert_cmpuint(change_count, ==, 1);
    onboarding_wizard_model_free(model);

    g_autoptr(JsonNode) result = wizard_result_node("late", "late-step", FALSE);
    deliver_success(0, result);
    g_assert_cmpuint(change_count, ==, 1);
    clear_captured();
}

static void test_stale_generation_ignored(void) {
    clear_captured();
    OnboardingWizardModel *model = onboarding_wizard_model_new(on_wizard_changed, NULL);
    onboarding_wizard_start(model, "local");
    onboarding_wizard_start(model, "local");
    g_assert_cmpuint(captured_count, ==, 2);
    g_assert_cmpuint(change_count, ==, 2);

    g_autoptr(JsonNode) stale = wizard_result_node("session-a", "step-a", FALSE);
    deliver_success(0, stale);
    g_assert_null(onboarding_wizard_get_session_id(model));
    g_assert_cmpuint(change_count, ==, 2);

    g_autoptr(JsonNode) current = wizard_result_node("session-b", "step-b", FALSE);
    deliver_success(1, current);
    g_assert_cmpstr(onboarding_wizard_get_session_id(model), ==, "session-b");
    g_assert_cmpuint(change_count, ==, 3);

    onboarding_wizard_model_free(model);
    clear_captured();
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/onboarding/wizard/start_happy_path", test_start_happy_path);
    g_test_add_func("/onboarding/wizard/next_happy_path", test_next_happy_path);
    g_test_add_func("/onboarding/wizard/cancel_happy_path", test_cancel_happy_path);
    g_test_add_func("/onboarding/wizard/rpc_not_ready", test_rpc_not_ready_sets_error);
    g_test_add_func("/onboarding/wizard/model_free_before_callback", test_model_free_before_callback);
    g_test_add_func("/onboarding/wizard/stale_generation_ignored", test_stale_generation_ignored);
    return g_test_run();
}

