/*
 * config_browser_toggle.c
 *
 * Driver for the Browser Control toggle. See config_browser_toggle.h
 * for the public contract.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "config_browser_toggle.h"

#include "config_setup_transform.h"
#include "gateway_data.h"
#include "gateway_mutations.h"
#include "log.h"

typedef struct {
    gboolean enabled;
    ConfigBrowserToggleCb cb;
    gpointer user_data;
} ToggleCtx;

static void notify(ToggleCtx *ctx,
                   ConfigBrowserToggleStatus status,
                   const gchar *error_code,
                   const gchar *error_msg) {
    if (ctx && ctx->cb) {
        ConfigBrowserToggleResult result = {
            .status = status,
            .error_code = error_code,
            .error_msg = error_msg,
        };
        ctx->cb(&result, ctx->user_data);
    }
    g_free(ctx);
}

static void on_save_done(const GatewayRpcResponse *resp, gpointer user_data) {
    ToggleCtx *ctx = (ToggleCtx *)user_data;
    if (!resp || !resp->ok) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "browser-toggle save failed code=%s msg=%s",
                    resp && resp->error_code ? resp->error_code : "(none)",
                    resp && resp->error_msg ? resp->error_msg : "(none)");
        notify(ctx,
               CONFIG_BROWSER_TOGGLE_ERR_SAVE_FAILED,
               resp ? resp->error_code : NULL,
               resp ? resp->error_msg : NULL);
        return;
    }

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_GATEWAY,
                 "browser-toggle save ok enabled=%d",
                 ctx ? (int)ctx->enabled : -1);
    notify(ctx, CONFIG_BROWSER_TOGGLE_OK, NULL, NULL);
}

static void on_get_done(const GatewayRpcResponse *resp, gpointer user_data) {
    ToggleCtx *ctx = (ToggleCtx *)user_data;
    if (!resp || !resp->ok) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "browser-toggle fetch failed code=%s msg=%s",
                    resp && resp->error_code ? resp->error_code : "(none)",
                    resp && resp->error_msg ? resp->error_msg : "(none)");
        notify(ctx,
               CONFIG_BROWSER_TOGGLE_ERR_FETCH_FAILED,
               resp ? resp->error_code : NULL,
               resp ? resp->error_msg : NULL);
        return;
    }

    GatewayConfigSnapshot *snapshot = gateway_data_parse_config_get(resp->payload);
    if (!snapshot || !snapshot->config || !snapshot->hash) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "browser-toggle fetch returned malformed snapshot");
        if (snapshot) gateway_config_snapshot_free(snapshot);
        notify(ctx,
               CONFIG_BROWSER_TOGGLE_ERR_FETCH_FAILED,
               "INVALID_SNAPSHOT",
               "config.get response missing config or hash");
        return;
    }

    /* Reuse the same pretty-printer the section_config baseline does
     * so the OCC base hash semantics match: we never want to base our
     * `config.set` on a transform of a *different* serialization than
     * what the gateway hashed. */
    JsonNode *node = json_node_new(JSON_NODE_OBJECT);
    json_node_set_object(node, snapshot->config);
    g_autofree gchar *raw = json_to_string(node, TRUE);
    json_node_unref(node);

    g_autoptr(GError) terr = NULL;
    g_autofree gchar *updated =
        config_setup_apply_browser_enabled(raw, ctx->enabled, &terr);

    if (!updated) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "browser-toggle transform failed: %s",
                    terr && terr->message ? terr->message : "(unknown)");
        gateway_config_snapshot_free(snapshot);
        notify(ctx,
               CONFIG_BROWSER_TOGGLE_ERR_TRANSFORM_FAILED,
               "TRANSFORM_FAILED",
               terr ? terr->message : NULL);
        return;
    }

    g_autofree gchar *base_hash = g_strdup(snapshot->hash);
    gateway_config_snapshot_free(snapshot);

    g_autofree gchar *rid =
        mutation_config_set(updated, base_hash, on_save_done, ctx);
    if (!rid) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "browser-toggle config.set dispatch returned NULL");
        notify(ctx,
               CONFIG_BROWSER_TOGGLE_ERR_SAVE_FAILED,
               "DISPATCH_FAILED",
               "config.set could not be dispatched");
        return;
    }
    /* `on_save_done` owns ctx from here. */
}

void config_browser_toggle_request(gboolean enabled,
                                   ConfigBrowserToggleCb cb,
                                   gpointer user_data) {
    ToggleCtx *ctx = g_new0(ToggleCtx, 1);
    ctx->enabled = enabled ? TRUE : FALSE;
    ctx->cb = cb;
    ctx->user_data = user_data;

    g_autofree gchar *rid =
        mutation_config_get(NULL, on_get_done, ctx);
    if (!rid) {
        OC_LOG_INFO(OPENCLAW_LOG_CAT_GATEWAY,
                    "browser-toggle config.get dispatch returned NULL");
        notify(ctx,
               CONFIG_BROWSER_TOGGLE_ERR_FETCH_FAILED,
               "DISPATCH_FAILED",
               "config.get could not be dispatched");
        return;
    }
    /* `on_get_done` owns ctx from here. */
}
