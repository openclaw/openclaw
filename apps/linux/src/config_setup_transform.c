#include "config_setup_transform.h"

#include <json-glib/json-glib.h>
#include <string.h>

static JsonObject* ensure_object_member(JsonObject *parent, const gchar *member) {
    JsonNode *node = json_object_get_member(parent, member);
    if (node && JSON_NODE_HOLDS_OBJECT(node)) {
        return json_node_get_object(node);
    }

    JsonObject *child = json_object_new();
    JsonNode *child_node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(child_node, child);
    json_object_set_member(parent, member, child_node);
    return child;
}

static gchar* transform_to_pretty_json(JsonObject *root_obj) {
    JsonNode *node = json_node_new(JSON_NODE_OBJECT);
    json_node_set_object(node, root_obj);
    gchar *updated = json_to_string(node, TRUE);
    json_node_unref(node);
    return updated;
}

static JsonObject* parse_root_object(const gchar *raw_json,
                                     GError **error,
                                     JsonParser **out_parser) {
    JsonParser *parser = json_parser_new();
    if (!json_parser_load_from_data(parser, raw_json ? raw_json : "{}", -1, error)) {
        g_object_unref(parser);
        return NULL;
    }

    JsonNode *root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
        g_set_error_literal(error,
                            g_quark_from_static_string("openclaw-config-setup"),
                            1,
                            "Config root must be a JSON object");
        g_object_unref(parser);
        return NULL;
    }

    if (out_parser) *out_parser = parser;
    return json_node_get_object(root);
}

static gboolean provider_id_is(const gchar *provider_id,
                               const gchar *expected) {
    if (!provider_id || !expected) {
        return FALSE;
    }
    return g_ascii_strcasecmp(provider_id, expected) == 0;
}

static const gchar* provider_default_base_url(const gchar *provider_id) {
    if (provider_id_is(provider_id, "ollama")) {
        return "http://127.0.0.1:11434";
    }
    if (provider_id_is(provider_id, "openai")) {
        return "https://api.openai.com/v1";
    }
    return NULL;
}

static const gchar* provider_default_api(const gchar *provider_id) {
    if (provider_id_is(provider_id, "ollama")) {
        return "ollama";
    }
    if (provider_id_is(provider_id, "openai")) {
        return "openai-responses";
    }
    return provider_id;
}

static const gchar* provider_profile_mode(const gchar *provider_id) {
    if (provider_id_is(provider_id, "ollama")) {
        return "api_key";
    }
    return "api_key";
}

static void auth_order_ensure_profile(JsonObject *order_obj,
                                      const gchar *provider_id,
                                      const gchar *profile_id) {
    JsonNode *existing = json_object_get_member(order_obj, provider_id);
    if (!existing || !JSON_NODE_HOLDS_ARRAY(existing)) {
        JsonArray *order = json_array_new();
        json_array_add_string_element(order, profile_id);
        JsonNode *order_node = json_node_new(JSON_NODE_ARRAY);
        json_node_take_array(order_node, order);
        json_object_set_member(order_obj, provider_id, order_node);
        return;
    }

    JsonArray *arr = json_node_get_array(existing);
    guint len = json_array_get_length(arr);
    for (guint i = 0; i < len; i++) {
        const gchar *candidate = json_array_get_string_element(arr, i);
        if (candidate && g_strcmp0(candidate, profile_id) == 0) {
            return;
        }
    }
    json_array_add_string_element(arr, profile_id);
}

gchar* config_setup_apply_provider(const gchar *raw_json,
                                   const gchar *provider_id,
                                   const gchar *base_url,
                                   GError **error) {
    if (!provider_id || provider_id[0] == '\0') {
        g_set_error_literal(error,
                            g_quark_from_static_string("openclaw-config-setup"),
                            2,
                            "Provider id is required");
        return NULL;
    }

    JsonParser *parser = NULL;
    JsonObject *root_obj = parse_root_object(raw_json, error, &parser);
    if (!root_obj) return NULL;

    JsonObject *models_obj = ensure_object_member(root_obj, "models");
    JsonObject *providers_obj = ensure_object_member(models_obj, "providers");
    JsonObject *provider_obj = ensure_object_member(providers_obj, provider_id);
    const gchar *effective_base_url = (base_url && base_url[0] != '\0')
        ? base_url
        : provider_default_base_url(provider_id);
    if (effective_base_url && effective_base_url[0] != '\0') {
        json_object_set_string_member(provider_obj, "baseUrl", effective_base_url);
    }

    const gchar *effective_api = provider_default_api(provider_id);
    if (!json_object_has_member(provider_obj, "api") &&
        effective_api && effective_api[0] != '\0') {
        json_object_set_string_member(provider_obj, "api", effective_api);
    }

    if (provider_id_is(provider_id, "ollama") &&
        !json_object_has_member(provider_obj, "apiKey")) {
        json_object_set_string_member(provider_obj, "apiKey", "ollama-local");
    }

    JsonObject *plugins_obj = ensure_object_member(root_obj, "plugins");
    JsonObject *entries_obj = ensure_object_member(plugins_obj, "entries");
    JsonObject *provider_entry = ensure_object_member(entries_obj, provider_id);
    json_object_set_boolean_member(provider_entry, "enabled", TRUE);

    JsonObject *auth_obj = ensure_object_member(root_obj, "auth");
    JsonObject *profiles_obj = ensure_object_member(auth_obj, "profiles");
    g_autofree gchar *profile_id = g_strdup_printf("%s:default", provider_id);
    JsonObject *profile_obj = ensure_object_member(profiles_obj, profile_id);
    json_object_set_string_member(profile_obj, "provider", provider_id);
    json_object_set_string_member(profile_obj, "mode", provider_profile_mode(provider_id));

    JsonObject *order_obj = ensure_object_member(auth_obj, "order");
    auth_order_ensure_profile(order_obj, provider_id, profile_id);

    gchar *updated = transform_to_pretty_json(root_obj);
    g_object_unref(parser);
    return updated;
}

gchar* config_setup_apply_default_model(const gchar *raw_json,
                                        const gchar *provider_id,
                                        const gchar *model_id,
                                        GError **error) {
    if (!model_id || model_id[0] == '\0') {
        g_set_error_literal(error,
                            g_quark_from_static_string("openclaw-config-setup"),
                            3,
                            "Model id is required");
        return NULL;
    }

    JsonParser *parser = NULL;
    JsonObject *root_obj = parse_root_object(raw_json, error, &parser);
    if (!root_obj) return NULL;

    JsonObject *agents_obj = ensure_object_member(root_obj, "agents");
    JsonObject *defaults_obj = ensure_object_member(agents_obj, "defaults");
    JsonObject *model_obj = ensure_object_member(defaults_obj, "model");
    json_object_set_string_member(model_obj, "primary", model_id);

    JsonObject *models_map_obj = ensure_object_member(defaults_obj, "models");
    (void)ensure_object_member(models_map_obj, model_id);

    if (provider_id && provider_id[0] != '\0') {
        json_object_set_string_member(defaults_obj, "modelProvider", provider_id);
    }

    gchar *updated = transform_to_pretty_json(root_obj);
    g_object_unref(parser);
    return updated;
}
