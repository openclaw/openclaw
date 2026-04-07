/*
 * test_chat_blocks.c
 * Description: Unit tests for chat block extraction helpers.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <json-glib/json-glib.h>

#include "../src/chat_blocks.h"

static JsonNode* parse_json(const gchar *json) {
    JsonParser *parser = json_parser_new();
    gboolean ok = json_parser_load_from_data(parser, json, -1, NULL);
    g_assert_true(ok);
    JsonNode *root = json_node_copy(json_parser_get_root(parser));
    g_object_unref(parser);
    return root;
}

static void test_empty_content(void) {
    g_autoptr(GPtrArray) blocks = chat_blocks_extract(NULL);
    g_assert_cmpint((gint)blocks->len, ==, 0);
}

static void test_legacy_plain_string(void) {
    JsonNode *n = json_node_new(JSON_NODE_VALUE);
    json_node_set_string(n, "hello");
    g_autoptr(GPtrArray) blocks = chat_blocks_extract(n);
    g_assert_cmpint((gint)blocks->len, ==, 1);

    ChatBlock *b = g_ptr_array_index(blocks, 0);
    g_assert_cmpint(b->type, ==, CHAT_BLOCK_TEXT);
    g_assert_cmpstr(b->text, ==, "hello");
    json_node_unref(n);
}

static void test_structured_blocks(void) {
    JsonNode *n = parse_json(
        "["
        "{\"type\":\"text\",\"text\":\"hi\"},"
        "{\"type\":\"thinking\",\"text\":\"plan\"},"
        "{\"type\":\"tool_use\",\"name\":\"grep\",\"input\":{\"q\":\"x\"}},"
        "{\"type\":\"tool_result\",\"content\":\"ok\"}"
        "]"
    );

    g_autoptr(GPtrArray) blocks = chat_blocks_extract(n);
    g_assert_cmpint((gint)blocks->len, ==, 4);

    ChatBlock *b0 = g_ptr_array_index(blocks, 0);
    ChatBlock *b1 = g_ptr_array_index(blocks, 1);
    ChatBlock *b2 = g_ptr_array_index(blocks, 2);
    ChatBlock *b3 = g_ptr_array_index(blocks, 3);

    g_assert_cmpint(b0->type, ==, CHAT_BLOCK_TEXT);
    g_assert_cmpint(b1->type, ==, CHAT_BLOCK_THINKING);
    g_assert_cmpint(b2->type, ==, CHAT_BLOCK_TOOL_USE);
    g_assert_cmpint(b3->type, ==, CHAT_BLOCK_TOOL_RESULT);
    json_node_unref(n);
}

static void test_plain_text_extraction(void) {
    JsonNode *n = parse_json(
        "["
        "{\"type\":\"text\",\"text\":\"hello\"},"
        "{\"type\":\"tool_result\",\"content\":[\"line1\",\"line2\"]}"
        "]"
    );

    g_autofree gchar *text = chat_blocks_extract_plain_text(n);
    g_assert_nonnull(strstr(text, "hello"));
    g_assert_nonnull(strstr(text, "line1"));
    g_assert_nonnull(strstr(text, "line2"));
    json_node_unref(n);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/chat_blocks/empty", test_empty_content);
    g_test_add_func("/chat_blocks/legacy_string", test_legacy_plain_string);
    g_test_add_func("/chat_blocks/structured", test_structured_blocks);
    g_test_add_func("/chat_blocks/plain_text", test_plain_text_extraction);

    return g_test_run();
}
