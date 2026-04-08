/*
 * json_access.h
 *
 * Tiny typed JSON access helpers for Linux-side ingress/parsing boundaries.
 */

#ifndef OPENCLAW_JSON_ACCESS_H
#define OPENCLAW_JSON_ACCESS_H

#include <json-glib/json-glib.h>

static inline const gchar* oc_json_string_member(JsonObject *obj, const gchar *member) {
    if (!obj || !member || !json_object_has_member(obj, member)) return NULL;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || !JSON_NODE_HOLDS_VALUE(node)) return NULL;
    if (json_node_get_value_type(node) != G_TYPE_STRING) return NULL;
    return json_node_get_string(node);
}

static inline JsonObject* oc_json_object_member(JsonObject *obj, const gchar *member) {
    if (!obj || !member || !json_object_has_member(obj, member)) return NULL;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || !JSON_NODE_HOLDS_OBJECT(node)) return NULL;
    return json_node_get_object(node);
}

static inline JsonArray* oc_json_array_member(JsonObject *obj, const gchar *member) {
    if (!obj || !member || !json_object_has_member(obj, member)) return NULL;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || !JSON_NODE_HOLDS_ARRAY(node)) return NULL;
    return json_node_get_array(node);
}

static inline gboolean oc_json_bool_member(JsonObject *obj, const gchar *member, gboolean fallback) {
    if (!obj || !member || !json_object_has_member(obj, member)) return fallback;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || !JSON_NODE_HOLDS_VALUE(node)) return fallback;
    if (json_node_get_value_type(node) != G_TYPE_BOOLEAN) return fallback;
    return json_node_get_boolean(node);
}

#endif
