/*
 * gateway_http.c
 *
 * Native HTTP health checking for the OpenClaw Linux Companion App.
 *
 * Performs async GET /health against the local gateway endpoint using
 * libsoup-3.0, a GLib-native HTTP library appropriate for GTK/Linux.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "gateway_http.h"
#include "log.h"
#include <libsoup/soup.h>
#include <json-glib/json-glib.h>

static SoupSession *http_session = NULL;

void gateway_http_init(void) {
    if (!http_session) {
        http_session = soup_session_new();
    }
}

void gateway_http_shutdown(void) {
    g_clear_object(&http_session);
}

void gateway_health_result_clear(GatewayHealthResult *result) {
    if (!result) return;
    g_free(result->version);
    g_free(result->error);
    memset(result, 0, sizeof(GatewayHealthResult));
}

typedef struct {
    GatewayHealthCallback callback;
    gpointer user_data;
    SoupMessage *msg; /* retained for HTTP status inspection in callback */
} HealthCheckContext;

static void on_health_response(GObject *source, GAsyncResult *res, gpointer user_data) {
    HealthCheckContext *ctx = (HealthCheckContext *)user_data;
    g_autoptr(GError) error = NULL;

    GBytes *body = soup_session_send_and_read_finish(SOUP_SESSION(source), res, &error);

    GatewayHealthResult result = {0};

    if (!body) {
        result.ok = FALSE;
        result.error = g_strdup_printf("Health check failed: %s", error ? error->message : "unknown");
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "http health error: %s", result.error);
        if (ctx->callback) ctx->callback(&result, ctx->user_data);
        g_free(result.error);
        g_object_unref(ctx->msg);
        g_free(ctx);
        return;
    }

    /* Check HTTP status code — only 2xx is acceptable */
    guint status_code = soup_message_get_status(ctx->msg);
    if (status_code < 200 || status_code >= 300) {
        result.ok = FALSE;
        result.error = g_strdup_printf("Health check HTTP %u", status_code);
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "http health non-ok status: %u", status_code);
        g_bytes_unref(body);
        if (ctx->callback) ctx->callback(&result, ctx->user_data);
        g_free(result.error);
        g_object_unref(ctx->msg);
        g_free(ctx);
        return;
    }

    gsize size = 0;
    const gchar *data = g_bytes_get_data(body, &size);

    /*
     * Validate JSON response shape strictly:
     * - Must be valid JSON
     * - Must be a JSON object
     * - Must contain "ok" boolean field (gateway /health contract)
     * Without these, the port may be serving a different service.
     */
    g_autoptr(JsonParser) parser = json_parser_new();
    if (!data || size == 0 || !json_parser_load_from_data(parser, data, size, NULL)) {
        result.ok = FALSE;
        result.error = g_strdup("Health response is not valid JSON");
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "http health non-json response");
        g_bytes_unref(body);
        if (ctx->callback) ctx->callback(&result, ctx->user_data);
        g_free(result.error);
        g_object_unref(ctx->msg);
        g_free(ctx);
        return;
    }

    JsonNode *root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
        result.ok = FALSE;
        result.error = g_strdup("Health response is not a JSON object");
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "http health non-object json");
        g_bytes_unref(body);
        if (ctx->callback) ctx->callback(&result, ctx->user_data);
        g_free(result.error);
        g_object_unref(ctx->msg);
        g_free(ctx);
        return;
    }

    JsonObject *obj = json_node_get_object(root);
    JsonNode *ok_node = json_object_has_member(obj, "ok")
                      ? json_object_get_member(obj, "ok")
                      : NULL;
    if (!ok_node || json_node_get_value_type(ok_node) != G_TYPE_BOOLEAN) {
        result.ok = FALSE;
        result.error = ok_node
            ? g_strdup("Health response 'ok' field is not a boolean (wrong service?)")
            : g_strdup("Health response missing 'ok' field (wrong service?)");
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "http health 'ok' invalid: %s",
                  ok_node ? "not boolean" : "missing");
        g_bytes_unref(body);
        if (ctx->callback) ctx->callback(&result, ctx->user_data);
        g_free(result.error);
        g_object_unref(ctx->msg);
        g_free(ctx);
        return;
    }

    result.ok = TRUE;
    result.healthy = json_node_get_boolean(ok_node);

    if (json_object_has_member(obj, "version")) {
        result.version = g_strdup(json_object_get_string_member(obj, "version"));
    }

    g_bytes_unref(body);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY, "http health ok=%d healthy=%d version=%s",
              result.ok, result.healthy, result.version ? result.version : "(null)");

    if (ctx->callback) ctx->callback(&result, ctx->user_data);
    g_free(result.version);
    g_free(result.error);
    g_object_unref(ctx->msg);
    g_free(ctx);
}

void gateway_http_check_health(const gchar *base_url, GatewayHealthCallback callback, gpointer user_data) {
    if (!http_session) {
        gateway_http_init();
    }

    g_autofree gchar *url = g_strdup_printf("%s/health", base_url);
    SoupMessage *msg = soup_message_new("GET", url);

    if (!msg) {
        GatewayHealthResult result = {0};
        result.error = g_strdup_printf("Invalid health URL: %s", url);
        if (callback) callback(&result, user_data);
        g_free(result.error);
        return;
    }

    HealthCheckContext *ctx = g_new0(HealthCheckContext, 1);
    ctx->callback = callback;
    ctx->user_data = user_data;
    ctx->msg = g_object_ref(msg); /* retain for status inspection in callback */

    soup_session_send_and_read_async(http_session, msg, G_PRIORITY_DEFAULT, NULL, on_health_response, ctx);
    g_object_unref(msg);
}
