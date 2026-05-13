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

/*
 * Pure policy: decide whether a chat.history message object should
 * appear in the operator-facing transcript. Currently hides
 * `role: "system"` entries (scaffolding like `[bootstrap-pending]`
 * directives from `src/agents/system-prompt.ts`) while letting every
 * other role through; role-specific further gating (e.g. tool
 * visibility) lives in the renderer.
 */
gboolean chat_message_is_renderable(JsonObject *msg_obj);
