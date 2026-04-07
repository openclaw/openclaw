/*
 * chat_blocks.h
 * Description: Public declarations for chat message block extraction helpers.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#pragma once

#include <glib.h>
#include <json-glib/json-glib.h>

typedef enum {
    CHAT_BLOCK_TEXT,
    CHAT_BLOCK_THINKING,
    CHAT_BLOCK_TOOL_USE,
    CHAT_BLOCK_TOOL_RESULT,
} ChatBlockType;

typedef struct {
    ChatBlockType type;
    gchar *text;
    gchar *tool_name;
    gchar *tool_input;
} ChatBlock;

void chat_block_free(ChatBlock *block);

GPtrArray* chat_blocks_extract(JsonNode *content_node);
gchar* chat_blocks_extract_plain_text(JsonNode *content_node);
