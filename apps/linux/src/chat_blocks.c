/*
 * chat_blocks.c
 * Description: Utilities for extracting renderable chat blocks from message payloads.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "chat_blocks.h"

#include <string.h>

static const gchar* chat_blocks_string_member(JsonObject *obj, const gchar *member) {
    if (!obj || !member || !json_object_has_member(obj, member)) return NULL;
    JsonNode *node = json_object_get_member(obj, member);
    if (!node || !JSON_NODE_HOLDS_VALUE(node)) return NULL;
    if (json_node_get_value_type(node) != G_TYPE_STRING) return NULL;
    return json_node_get_string(node);
}

void chat_block_free(ChatBlock *block) {
    if (!block) return;
    g_free(block->text);
    g_free(block->tool_name);
    g_free(block->tool_input);
    g_free(block);
}

static ChatBlock* chat_block_new(ChatBlockType type, const gchar *text) {
    ChatBlock *b = g_new0(ChatBlock, 1);
    b->type = type;
    b->text = g_strdup(text ? text : "");
    return b;
}

static void append_block_from_object(GPtrArray *out, JsonObject *obj) {
    g_autofree gchar *type = NULL;
    type = g_strdup(chat_blocks_string_member(obj, "type"));

    if (!type) {
        return;
    }

    if (g_strcmp0(type, "text") == 0 || g_strcmp0(type, "output_text") == 0) {
        const gchar *text = chat_blocks_string_member(obj, "text");
        g_ptr_array_add(out, chat_block_new(CHAT_BLOCK_TEXT, text ? text : ""));
        return;
    }

    if (g_strcmp0(type, "thinking") == 0 || g_strcmp0(type, "reasoning") == 0) {
        const gchar *text = chat_blocks_string_member(obj, "text");
        if (!text) {
            text = chat_blocks_string_member(obj, "thinking");
        }
        g_ptr_array_add(out, chat_block_new(CHAT_BLOCK_THINKING, text ? text : ""));
        return;
    }

    if (g_strcmp0(type, "tool_use") == 0) {
        ChatBlock *b = chat_block_new(CHAT_BLOCK_TOOL_USE, "");
        b->tool_name = g_strdup(chat_blocks_string_member(obj, "name"));
        if (json_object_has_member(obj, "input")) {
            JsonNode *input = json_object_get_member(obj, "input");
            if (JSON_NODE_HOLDS_VALUE(input) && json_node_get_value_type(input) == G_TYPE_STRING) {
                b->tool_input = g_strdup(json_node_get_string(input));
            } else {
                b->tool_input = json_to_string(input, FALSE);
            }
        }
        if (!b->tool_name) b->tool_name = g_strdup("tool");
        g_free(b->text);
        b->text = g_strdup_printf("%s%s%s",
                                  b->tool_name,
                                  b->tool_input ? "(" : "",
                                  b->tool_input ? b->tool_input : "");
        if (b->tool_input) {
            g_autofree gchar *prev = b->text;
            b->text = g_strdup_printf("%s)", prev);
        }
        g_ptr_array_add(out, b);
        return;
    }

    if (g_strcmp0(type, "tool_result") == 0 || g_strcmp0(type, "tool_output") == 0) {
        const gchar *text = NULL;
        g_autofree gchar *rendered = NULL;
        if (json_object_has_member(obj, "content")) {
            JsonNode *content = json_object_get_member(obj, "content");
            if (JSON_NODE_HOLDS_VALUE(content) && json_node_get_value_type(content) == G_TYPE_STRING) {
                text = json_node_get_string(content);
            } else if (JSON_NODE_HOLDS_ARRAY(content)) {
                JsonArray *arr = json_node_get_array(content);
                GString *s = g_string_new(NULL);
                guint len = json_array_get_length(arr);
                for (guint i = 0; i < len; i++) {
                    JsonNode *n = json_array_get_element(arr, i);
                    if (!n) continue;
                    if (JSON_NODE_HOLDS_VALUE(n) && json_node_get_value_type(n) == G_TYPE_STRING) {
                        if (s->len > 0) g_string_append(s, "\n");
                        g_string_append(s, json_node_get_string(n));
                    } else {
                        g_autofree gchar *part = json_to_string(n, FALSE);
                        if (s->len > 0) g_string_append(s, "\n");
                        g_string_append(s, part);
                    }
                }
                rendered = g_string_free(s, FALSE);
                text = rendered;
            } else {
                rendered = json_to_string(content, FALSE);
                text = rendered;
            }
        }
        g_ptr_array_add(out, chat_block_new(CHAT_BLOCK_TOOL_RESULT, text ? text : ""));
    }
}

GPtrArray* chat_blocks_extract(JsonNode *content_node) {
    GPtrArray *out = g_ptr_array_new_with_free_func((GDestroyNotify)chat_block_free);
    if (!content_node || json_node_is_null(content_node)) {
        return out;
    }

    if (JSON_NODE_HOLDS_VALUE(content_node) && json_node_get_value_type(content_node) == G_TYPE_STRING) {
        const gchar *s = json_node_get_string(content_node);
        if (s && s[0] != '\0') {
            g_ptr_array_add(out, chat_block_new(CHAT_BLOCK_TEXT, s));
        }
        return out;
    }

    if (!JSON_NODE_HOLDS_ARRAY(content_node)) {
        return out;
    }

    JsonArray *arr = json_node_get_array(content_node);
    guint len = json_array_get_length(arr);
    for (guint i = 0; i < len; i++) {
        JsonNode *n = json_array_get_element(arr, i);
        if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
        append_block_from_object(out, json_node_get_object(n));
    }

    return out;
}

gchar* chat_blocks_extract_plain_text(JsonNode *content_node) {
    g_autoptr(GPtrArray) blocks = chat_blocks_extract(content_node);
    GString *out = g_string_new(NULL);

    for (guint i = 0; i < blocks->len; i++) {
        ChatBlock *b = g_ptr_array_index(blocks, i);
        if (!b->text || b->text[0] == '\0') continue;
        if (out->len > 0) g_string_append(out, "\n");
        g_string_append(out, b->text);
    }

    return g_string_free(out, FALSE);
}
