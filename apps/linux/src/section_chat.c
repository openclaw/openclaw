/*
 * section_chat.c
 * Description: Chat section controller for message streaming and session-scoped history.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_chat.h"

#include <adwaita.h>

#include "chat_blocks.h"
#include "gateway_data.h"
#include "gateway_rpc.h"
#include "gateway_ws.h"
#include "json_access.h"
#include "markdown_render.h"
#include "readiness.h"
#include "session_filter.h"
#include "state.h"
#include "ui_model_utils.h"

typedef struct {
    gchar *id;
    gchar *name;
} ChatAgentChoice;

typedef struct {
    gchar *id;
    gchar *label;
} ChatModelChoice;

typedef struct {
    gchar *session_key;
    gchar *run_id;
    gchar *text;
} ChatQueuedAssistant;

static GtkWidget *chat_status_label = NULL;
static GtkWidget *chat_messages_box = NULL;
static GtkWidget *chat_agent_dropdown = NULL;
static GtkWidget *chat_model_dropdown = NULL;
static GtkWidget *chat_session_dropdown = NULL;
static GtkStringList *chat_agent_model = NULL;
static GtkStringList *chat_model_model = NULL;
static GtkStringList *chat_session_model = NULL;
static GtkWidget *chat_show_thinking_toggle = NULL;
static GtkWidget *chat_show_tools_toggle = NULL;
static GtkWidget *chat_compose_view = NULL;
static GtkWidget *chat_send_btn = NULL;

static GPtrArray *chat_agents = NULL;
static GPtrArray *chat_models = NULL;
static GPtrArray *chat_session_choices = NULL;
static GPtrArray *chat_history_messages = NULL; /* JsonNode* objects */
static GPtrArray *chat_finalized_assistant_queue = NULL; /* ChatQueuedAssistant* */
static GatewaySessionsData *chat_sessions_cache = NULL;

static gchar *chat_selected_agent_id = NULL;
static gchar *chat_selected_model_id = NULL;
static gchar *chat_selected_session_key = NULL;
static gchar *chat_pending_run_id = NULL;
static gchar *chat_pending_session_key = NULL;
static gchar *chat_pending_assistant_text = NULL;
static gchar *chat_last_finalized_run_id = NULL;
static gchar *chat_last_finalized_session_key = NULL;

static gboolean chat_fetch_in_flight = FALSE;
static gboolean chat_sessions_in_flight = FALSE;
static gboolean chat_history_in_flight = FALSE;
static guint chat_dependencies_pending = 0;
static gint64 chat_last_fetch_us = 0;
static gboolean chat_show_thinking = FALSE;
static gboolean chat_show_tools = TRUE;
static guint chat_event_listener_id = 0;
static gboolean chat_guard_agent_change = FALSE;
static gboolean chat_guard_model_change = FALSE;
static gboolean chat_guard_session_change = FALSE;
static guint chat_generation = 1;
static ChatGateInfo chat_gate_info = {0};

typedef struct {
    guint generation;
} ChatRequestContext;

static ChatRequestContext* chat_request_context_new(void) {
    ChatRequestContext *ctx = g_new0(ChatRequestContext, 1);
    ctx->generation = chat_generation;
    return ctx;
}

static gboolean chat_request_context_is_stale(const ChatRequestContext *ctx) {
    return !ctx || ctx->generation != chat_generation;
}

static void chat_request_context_free(gpointer data) {
    g_free(data);
}

static void chat_agent_choice_free(ChatAgentChoice *a) {
    if (!a) return;
    g_free(a->id);
    g_free(a->name);
    g_free(a);
}

static void chat_queued_assistant_free(ChatQueuedAssistant *m) {
    if (!m) return;
    g_free(m->session_key);
    g_free(m->run_id);
    g_free(m->text);
    g_free(m);
}

static void chat_rebuild_model_dropdown(void);
static void chat_set_model_dropdown_error_placeholder(const gchar *label);
static void chat_clear_pending_state(void);
static void chat_rebuild_messages_ui(void);
static gboolean chat_pending_is_for_selected_session(void);

static void chat_attach_agent_dropdown_model(GtkStringList *new_model,
                                             guint selected,
                                             gboolean enabled) {
    if (!new_model) return;
    if (chat_agent_dropdown && GTK_IS_DROP_DOWN(chat_agent_dropdown)) {
        chat_guard_agent_change = TRUE;
        ui_dropdown_replace_model(chat_agent_dropdown,
                                  (gpointer *)&chat_agent_model,
                                  G_LIST_MODEL(new_model),
                                  selected,
                                  enabled);
        chat_guard_agent_change = FALSE;
    } else {
        ui_dropdown_replace_model(NULL,
                                  (gpointer *)&chat_agent_model,
                                  G_LIST_MODEL(new_model),
                                  selected,
                                  enabled);
    }
}

static void chat_attach_model_dropdown_model(GtkStringList *new_model,
                                             guint selected,
                                             gboolean enabled) {
    if (!new_model) return;
    if (chat_model_dropdown && GTK_IS_DROP_DOWN(chat_model_dropdown)) {
        chat_guard_model_change = TRUE;
        ui_dropdown_replace_model(chat_model_dropdown,
                                  (gpointer *)&chat_model_model,
                                  G_LIST_MODEL(new_model),
                                  selected,
                                  enabled);
        chat_guard_model_change = FALSE;
    } else {
        ui_dropdown_replace_model(NULL,
                                  (gpointer *)&chat_model_model,
                                  G_LIST_MODEL(new_model),
                                  selected,
                                  enabled);
    }
}

static void chat_attach_session_dropdown_model(GtkStringList *new_model,
                                               guint selected,
                                               gboolean enabled) {
    if (!new_model) return;
    if (chat_session_dropdown && GTK_IS_DROP_DOWN(chat_session_dropdown)) {
        chat_guard_session_change = TRUE;
        ui_dropdown_replace_model(chat_session_dropdown,
                                  (gpointer *)&chat_session_model,
                                  G_LIST_MODEL(new_model),
                                  selected,
                                  enabled);
        chat_guard_session_change = FALSE;
    } else {
        ui_dropdown_replace_model(NULL,
                                  (gpointer *)&chat_session_model,
                                  G_LIST_MODEL(new_model),
                                  selected,
                                  enabled);
    }
}

static void chat_set_agent_dropdown_placeholder(const gchar *label, gboolean enabled) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    gtk_string_list_append(new_model, label && label[0] != '\0' ? label : "No agents available");
    chat_attach_agent_dropdown_model(new_model, 0, enabled);
}

static void chat_set_session_dropdown_placeholder(const gchar *label, gboolean enabled) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    gtk_string_list_append(new_model, label && label[0] != '\0' ? label : "No sessions yet");
    chat_attach_session_dropdown_model(new_model, 0, enabled);
}

static void chat_render_blocked_state(const ChatGateInfo *gate) {
    const gchar *status = (gate && gate->status) ? gate->status : "Chat unavailable.";
    const gchar *next_action = (gate && gate->next_action) ? gate->next_action : "Check gateway status.";

    if (chat_status_label) {
        g_autofree gchar *line = g_strdup_printf("%s Next: %s", status, next_action);
        gtk_label_set_text(GTK_LABEL(chat_status_label), line);
    }

    chat_set_agent_dropdown_placeholder("Chat blocked", FALSE);
    if (gate && gate->reason == CHAT_BLOCK_PROVIDER_MISSING) {
        chat_set_model_dropdown_error_placeholder("No provider configured");
    } else if (gate && gate->reason == CHAT_BLOCK_DEFAULT_MODEL_MISSING) {
        chat_set_model_dropdown_error_placeholder("No model selected");
    } else if (gate && gate->reason == CHAT_BLOCK_SELECTED_MODEL_UNRESOLVED) {
        chat_set_model_dropdown_error_placeholder("Selected model unavailable");
    } else {
        chat_set_model_dropdown_error_placeholder("Model list unavailable");
    }
    chat_set_session_dropdown_placeholder("No sessions yet", FALSE);

    chat_clear_pending_state();
    chat_rebuild_messages_ui();
}

static void chat_model_choice_free(ChatModelChoice *m) {
    if (!m) return;
    g_free(m->id);
    g_free(m->label);
    g_free(m);
}

static void chat_clear_messages_ui(void) {
    if (!chat_messages_box) return;
    section_box_clear(chat_messages_box);
}

static gchar* chat_text_from_chat_event_message(JsonNode *message_node) {
    if (!message_node || !JSON_NODE_HOLDS_OBJECT(message_node)) return NULL;
    JsonObject *message = json_node_get_object(message_node);
    const gchar *text = oc_json_string_member(message, "text");
    return text ? g_strdup(text) : NULL;
}

static JsonNode* chat_message_node_from_text(const gchar *role, const gchar *text) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "role");
    json_builder_add_string_value(b, role ? role : "user");
    json_builder_set_member_name(b, "content");
    json_builder_begin_array(b);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "text");
    json_builder_set_member_name(b, "text");
    json_builder_add_string_value(b, text ? text : "");
    json_builder_end_object(b);
    json_builder_end_array(b);
    json_builder_end_object(b);
    JsonNode *node = json_builder_get_root(b);
    g_object_unref(b);
    return node;
}

static void chat_append_history_node(JsonNode *msg_node) {
    if (!chat_history_messages) {
        chat_history_messages = g_ptr_array_new_with_free_func((GDestroyNotify)json_node_unref);
    }
    g_ptr_array_add(chat_history_messages, msg_node);
}

static void chat_append_line(const gchar *text, const gchar *css_class) {
    GtkWidget *label = gtk_label_new(text ? text : "");
    gtk_label_set_xalign(GTK_LABEL(label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(label), TRUE);
    gtk_label_set_use_markup(GTK_LABEL(label), TRUE);
    if (css_class) gtk_widget_add_css_class(label, css_class);
    gtk_box_append(GTK_BOX(chat_messages_box), label);
}

static void chat_render_message_object(JsonObject *msg_obj, gboolean is_pending) {
    const gchar *role = oc_json_string_member(msg_obj, "role");
    if (!role || role[0] == '\0') {
        role = "assistant";
    }

    g_autofree gchar *role_title = g_strdup_printf("%s%s", role, is_pending ? " (streaming)" : "");
    GtkWidget *role_label = gtk_label_new(role_title);
    gtk_widget_add_css_class(role_label, g_strcmp0(role, "assistant") == 0 ? "accent" : "heading");
    gtk_label_set_xalign(GTK_LABEL(role_label), 0.0);
    gtk_widget_set_margin_top(role_label, 8);
    gtk_box_append(GTK_BOX(chat_messages_box), role_label);

    JsonNode *content = json_object_get_member(msg_obj, "content");
    g_autoptr(GPtrArray) blocks = chat_blocks_extract(content);
    if (!blocks || blocks->len == 0) {
        chat_append_line("<i>(empty)</i>", "dim-label");
        return;
    }

    for (guint i = 0; i < blocks->len; i++) {
        ChatBlock *b = g_ptr_array_index(blocks, i);
        if (b->type == CHAT_BLOCK_THINKING && !chat_show_thinking) continue;
        if ((b->type == CHAT_BLOCK_TOOL_USE || b->type == CHAT_BLOCK_TOOL_RESULT) && !chat_show_tools) continue;

        const gchar *prefix = "";
        if (b->type == CHAT_BLOCK_THINKING) prefix = "<span alpha='70%'>Thinking:</span> ";
        if (b->type == CHAT_BLOCK_TOOL_USE) prefix = "<span alpha='70%'>Tool:</span> ";
        if (b->type == CHAT_BLOCK_TOOL_RESULT) prefix = "<span alpha='70%'>Result:</span> ";

        g_autofree gchar *pango = markdown_to_pango(b->text ? b->text : "");
        g_autofree gchar *line = g_strdup_printf("%s%s", prefix, pango);
        chat_append_line(line, is_pending ? "dim-label" : NULL);
    }
}

static void chat_set_send_enabled(void) {
    if (!chat_send_btn || !chat_compose_view) return;
    gboolean connected = chat_gate_info.ready;
    gboolean has_session = (chat_selected_session_key && chat_selected_session_key[0] != '\0');
    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(chat_compose_view));
    GtkTextIter start, end;
    gtk_text_buffer_get_bounds(buf, &start, &end);
    g_autofree gchar *txt = gtk_text_buffer_get_text(buf, &start, &end, FALSE);
    gboolean has_text = txt && g_strstrip(txt)[0] != '\0';
    gtk_widget_set_sensitive(chat_send_btn, connected && has_session && has_text);
}

static void chat_rebuild_messages_ui(void) {
    chat_clear_messages_ui();

    if (!chat_gate_info.ready) {
        const gchar *status = chat_gate_info.status ? chat_gate_info.status : "Chat is not ready.";
        const gchar *next = chat_gate_info.next_action ? chat_gate_info.next_action : "Check gateway status.";
        g_autofree gchar *line = g_strdup_printf("<i>%s %s</i>", status, next);
        chat_append_line(line, "dim-label");
        return;
    }

    if (!chat_history_messages || chat_history_messages->len == 0) {
        chat_append_line("<i>No chat history in this session yet.</i>", "dim-label");
    } else {
        for (guint i = 0; i < chat_history_messages->len; i++) {
            JsonNode *node = g_ptr_array_index(chat_history_messages, i);
            if (node && JSON_NODE_HOLDS_OBJECT(node)) {
                chat_render_message_object(json_node_get_object(node), FALSE);
            }
        }
    }

    if (chat_pending_is_for_selected_session()) {
        const gchar *pending_text = (chat_pending_assistant_text && chat_pending_assistant_text[0] != '\0')
                                        ? chat_pending_assistant_text
                                        : "…";
        g_autoptr(JsonNode) pending_node = chat_message_node_from_text("assistant", pending_text);
        chat_render_message_object(json_node_get_object(pending_node), TRUE);
    }
}

static void chat_clear_pending_state(void) {
    g_clear_pointer(&chat_pending_run_id, g_free);
    g_clear_pointer(&chat_pending_session_key, g_free);
    g_clear_pointer(&chat_pending_assistant_text, g_free);
}

static gboolean chat_pending_is_for_selected_session(void) {
    return chat_pending_session_key && chat_selected_session_key &&
           g_strcmp0(chat_pending_session_key, chat_selected_session_key) == 0;
}

static gboolean chat_stream_claim_or_match_owner(const gchar *session_key,
                                                 const gchar *run_id) {
    if (!session_key || session_key[0] == '\0') return FALSE;

    if (!chat_pending_session_key || chat_pending_session_key[0] == '\0') {
        g_free(chat_pending_session_key);
        chat_pending_session_key = g_strdup(session_key);
        g_free(chat_pending_run_id);
        chat_pending_run_id =
            (run_id && run_id[0] != '\0') ? g_strdup(run_id) : NULL;
        if (!chat_pending_assistant_text) chat_pending_assistant_text = g_strdup("");
        return TRUE;
    }

    if (g_strcmp0(chat_pending_session_key, session_key) != 0) {
        return FALSE;
    }

    if (run_id && run_id[0] != '\0') {
        if (!chat_pending_run_id || chat_pending_run_id[0] == '\0') {
            g_free(chat_pending_run_id);
            chat_pending_run_id = g_strdup(run_id);
        } else if (g_strcmp0(chat_pending_run_id, run_id) != 0) {
            gboolean has_stream_text =
                chat_pending_assistant_text && chat_pending_assistant_text[0] != '\0';
            if (has_stream_text) {
                return FALSE;
            }
            g_free(chat_pending_run_id);
            chat_pending_run_id = g_strdup(run_id);
        }
    }

    if (!chat_pending_assistant_text) chat_pending_assistant_text = g_strdup("");
    return TRUE;
}

static void chat_dependency_complete(void) {
    if (chat_dependencies_pending > 0) chat_dependencies_pending--;
    if (chat_dependencies_pending == 0) chat_fetch_in_flight = FALSE;
}

static void chat_queue_finalized_assistant(const gchar *session_key,
                                           const gchar *run_id,
                                           const gchar *text) {
    if (!session_key || session_key[0] == '\0' || !text || text[0] == '\0') return;
    if (!chat_finalized_assistant_queue) {
        chat_finalized_assistant_queue =
            g_ptr_array_new_with_free_func((GDestroyNotify)chat_queued_assistant_free);
    }
    ChatQueuedAssistant *q = g_new0(ChatQueuedAssistant, 1);
    q->session_key = g_strdup(session_key);
    q->run_id = run_id && run_id[0] != '\0' ? g_strdup(run_id) : NULL;
    q->text = g_strdup(text);
    g_ptr_array_add(chat_finalized_assistant_queue, q);
}

static void chat_drain_finalized_for_selected_session(void) {
    if (!chat_selected_session_key || !chat_finalized_assistant_queue ||
        chat_finalized_assistant_queue->len == 0) {
        return;
    }

    guint i = 0;
    while (i < chat_finalized_assistant_queue->len) {
        ChatQueuedAssistant *q = g_ptr_array_index(chat_finalized_assistant_queue, i);
        if (!q || g_strcmp0(q->session_key, chat_selected_session_key) != 0) {
            i++;
            continue;
        }
        chat_append_history_node(chat_message_node_from_text("assistant", q->text));
        g_ptr_array_remove_index(chat_finalized_assistant_queue, i);
    }
}

static void chat_update_model_from_selected_session(void) {
    const gchar *model = NULL;
    if (chat_sessions_cache && chat_selected_session_key) {
        for (gint i = 0; i < chat_sessions_cache->n_sessions; i++) {
            const GatewaySession *s = &chat_sessions_cache->sessions[i];
            if (!s->key) continue;
            if (g_strcmp0(s->key, chat_selected_session_key) == 0) {
                model = s->model;
                break;
            }
        }
    }
    g_free(chat_selected_model_id);
    chat_selected_model_id = model && model[0] != '\0' ? g_strdup(model) : NULL;
    chat_rebuild_model_dropdown();
}

static void chat_finalize_pending_assistant(const gchar *status_text) {
    gboolean for_selected = chat_pending_is_for_selected_session();
    gboolean is_duplicate_final =
        chat_pending_run_id && chat_pending_session_key &&
        g_strcmp0(chat_pending_run_id, chat_last_finalized_run_id) == 0 &&
        g_strcmp0(chat_pending_session_key, chat_last_finalized_session_key) == 0;

    if (chat_pending_assistant_text && chat_pending_assistant_text[0] != '\0') {
        if (!is_duplicate_final) {
            if (for_selected) {
                chat_append_history_node(
                    chat_message_node_from_text("assistant", chat_pending_assistant_text));
            } else {
                chat_queue_finalized_assistant(chat_pending_session_key,
                                               chat_pending_run_id,
                                               chat_pending_assistant_text);
            }
        }

        g_free(chat_last_finalized_run_id);
        g_free(chat_last_finalized_session_key);
        chat_last_finalized_run_id = chat_pending_run_id ? g_strdup(chat_pending_run_id) : NULL;
        chat_last_finalized_session_key =
            chat_pending_session_key ? g_strdup(chat_pending_session_key) : NULL;
    }
    chat_clear_pending_state();
    if (for_selected && status_text && chat_status_label) {
        gtk_label_set_text(GTK_LABEL(chat_status_label), status_text);
    }
    if (for_selected) {
        chat_drain_finalized_for_selected_session();
        chat_rebuild_messages_ui();
    }
}

static void chat_request_history_for_selected(void);
static void chat_request_sessions_for_selected_agent(void);

static void chat_rebuild_agent_dropdown(void) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    guint selected_index = 0;
    for (guint i = 0; chat_agents && i < chat_agents->len; i++) {
        ChatAgentChoice *a = g_ptr_array_index(chat_agents, i);
        gtk_string_list_append(new_model, a->name ? a->name : a->id);
        if (chat_selected_agent_id && g_strcmp0(chat_selected_agent_id, a->id) == 0) {
            selected_index = i;
        }
    }
    chat_attach_agent_dropdown_model(new_model, selected_index, TRUE);
}

static void chat_rebuild_model_dropdown(void) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    gtk_string_list_append(new_model, "Session default");
    guint selected_index = 0;
    for (guint i = 0; chat_models && i < chat_models->len; i++) {
        ChatModelChoice *m = g_ptr_array_index(chat_models, i);
        gtk_string_list_append(new_model, m->label ? m->label : m->id);
        if (chat_selected_model_id && g_strcmp0(chat_selected_model_id, m->id) == 0) {
            selected_index = i + 1;
        }
    }
    chat_attach_model_dropdown_model(new_model, selected_index, TRUE);
}

static void chat_set_model_dropdown_error_placeholder(const gchar *label) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    gtk_string_list_append(new_model, label && label[0] != '\0' ? label : "Model list unavailable");

    chat_attach_model_dropdown_model(new_model, 0, FALSE);
}

static void chat_rebuild_session_dropdown(void) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    guint selected_index = 0;
    for (guint i = 0; chat_session_choices && i < chat_session_choices->len; i++) {
        SessionChoice *choice = g_ptr_array_index(chat_session_choices, i);
        gtk_string_list_append(new_model, choice->label);
        if (chat_selected_session_key && g_strcmp0(chat_selected_session_key, choice->key) == 0) selected_index = i;
    }
    chat_attach_session_dropdown_model(new_model, selected_index, TRUE);
}

static void on_chat_history_response(const GatewayRpcResponse *response, gpointer user_data) {
    ChatRequestContext *ctx = (ChatRequestContext *)user_data;
    if (chat_request_context_is_stale(ctx)) {
        chat_request_context_free(ctx);
        return;
    }
    chat_request_context_free(ctx);

    if (!chat_status_label) {
        return;
    }

    chat_history_in_flight = FALSE;

    if (chat_history_messages) g_ptr_array_set_size(chat_history_messages, 0);

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Failed to load chat.history");
        chat_rebuild_messages_ui();
        return;
    }

    JsonObject *root = json_node_get_object(response->payload);
    JsonNode *messages_node = json_object_get_member(root, "messages");
    if (messages_node && JSON_NODE_HOLDS_ARRAY(messages_node)) {
        JsonArray *arr = json_node_get_array(messages_node);
        for (guint i = 0; i < json_array_get_length(arr); i++) {
            JsonNode *node = json_array_get_element(arr, i);
            if (node && JSON_NODE_HOLDS_OBJECT(node)) {
                chat_append_history_node(json_node_copy(node));
            }
        }
    }

    if (json_object_has_member(root, "messages") && chat_history_messages->len == 0) {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "No history for selected session");
    } else {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Chat history loaded");
    }
    chat_drain_finalized_for_selected_session();
    chat_rebuild_messages_ui();
    chat_set_send_enabled();
}

static void chat_request_history_for_selected(void) {
    if (!chat_selected_session_key || !gateway_rpc_is_ready()) {
        chat_rebuild_messages_ui();
        chat_set_send_enabled();
        return;
    }

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "sessionKey");
    json_builder_add_string_value(b, chat_selected_session_key);
    json_builder_set_member_name(b, "limit");
    json_builder_add_int_value(b, 120);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    chat_history_in_flight = TRUE;
    ChatRequestContext *ctx = chat_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("chat.history", params, 0, on_chat_history_response, ctx);
    json_node_unref(params);
    if (!rid) {
        chat_request_context_free(ctx);
        chat_history_in_flight = FALSE;
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Gateway not connected");
        chat_rebuild_messages_ui();
    }
}

static void on_chat_sessions_response(const GatewayRpcResponse *response, gpointer user_data) {
    ChatRequestContext *ctx = (ChatRequestContext *)user_data;
    if (chat_request_context_is_stale(ctx)) {
        chat_request_context_free(ctx);
        return;
    }
    chat_request_context_free(ctx);

    if (!chat_status_label) {
        return;
    }

    chat_sessions_in_flight = FALSE;

    if (!response || !response->ok || !response->payload) {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Failed to load sessions.list");
        chat_set_session_dropdown_placeholder("No sessions yet", FALSE);
        return;
    }

    gchar *previous = g_strdup(chat_selected_session_key);
    gateway_sessions_data_free(chat_sessions_cache);
    chat_sessions_cache = gateway_data_parse_sessions(response->payload);
    if (!chat_sessions_cache) {
        g_free(previous);
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Invalid sessions payload");
        return;
    }

    if (chat_session_choices) g_ptr_array_unref(chat_session_choices);
    chat_session_choices = session_filter_build_choices(chat_selected_agent_id,
                                                        chat_sessions_cache->sessions,
                                                        chat_sessions_cache->n_sessions);

    gboolean kept = FALSE;
    if (previous) {
        for (guint i = 0; i < chat_session_choices->len; i++) {
            SessionChoice *c = g_ptr_array_index(chat_session_choices, i);
            if (g_strcmp0(c->key, previous) == 0) {
                g_free(chat_selected_session_key);
                chat_selected_session_key = g_strdup(previous);
                kept = TRUE;
                break;
            }
        }
    }
    if (!kept && chat_session_choices->len > 0) {
        SessionChoice *c = g_ptr_array_index(chat_session_choices, 0);
        g_free(chat_selected_session_key);
        chat_selected_session_key = g_strdup(c->key);
    } else if (chat_session_choices->len == 0) {
        g_clear_pointer(&chat_selected_session_key, g_free);
    }
    g_free(previous);

    chat_rebuild_session_dropdown();
    chat_update_model_from_selected_session();
    chat_request_history_for_selected();
    section_mark_fresh(&chat_last_fetch_us);
}

static void chat_request_sessions_for_selected_agent(void) {
    if (!chat_selected_agent_id || !gateway_rpc_is_ready()) return;

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "agentId");
    json_builder_add_string_value(b, chat_selected_agent_id);
    json_builder_set_member_name(b, "limit");
    json_builder_add_int_value(b, 50);
    json_builder_set_member_name(b, "includeLastMessage");
    json_builder_add_boolean_value(b, TRUE);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    chat_sessions_in_flight = TRUE;
    ChatRequestContext *ctx = chat_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("sessions.list", params, 0, on_chat_sessions_response, ctx);
    json_node_unref(params);
    if (!rid) {
        chat_request_context_free(ctx);
        chat_sessions_in_flight = FALSE;
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Failed to request sessions.list");
    }
}

static void on_models_response(const GatewayRpcResponse *response, gpointer user_data) {
    ChatRequestContext *ctx = (ChatRequestContext *)user_data;
    if (chat_request_context_is_stale(ctx)) {
        chat_request_context_free(ctx);
        return;
    }
    chat_request_context_free(ctx);

    g_autoptr(GPtrArray) parsed_models =
        g_ptr_array_new_with_free_func((GDestroyNotify)chat_model_choice_free);

    if (!chat_status_label) {
        chat_dependency_complete();
        return;
    }

    if (response->ok && response->payload && JSON_NODE_HOLDS_OBJECT(response->payload)) {
        JsonObject *obj = json_node_get_object(response->payload);
        JsonNode *mn = json_object_get_member(obj, "models");
        if (mn && JSON_NODE_HOLDS_ARRAY(mn)) {
            JsonArray *arr = json_node_get_array(mn);
            for (guint i = 0; i < json_array_get_length(arr); i++) {
                JsonNode *n = json_array_get_element(arr, i);
                if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
                JsonObject *mo = json_node_get_object(n);
                ChatModelChoice *m = g_new0(ChatModelChoice, 1);
                if (json_object_has_member(mo, "id")) {
                    JsonNode *idn = json_object_get_member(mo, "id");
                    if (idn && JSON_NODE_HOLDS_VALUE(idn) && json_node_get_value_type(idn) == G_TYPE_STRING) {
                        m->id = g_strdup(json_node_get_string(idn));
                    }
                }
                const gchar *provider = oc_json_string_member(mo, "provider");
                const gchar *name = oc_json_string_member(mo, "name");
                m->label = g_strdup_printf("%s (%s)",
                                           name ? name : m->id,
                                           provider ? provider : "provider");
                if (m->id) g_ptr_array_add(parsed_models, m); else chat_model_choice_free(m);
            }
        }
    } else if (chat_status_label) {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Failed to load models.list");
        chat_set_model_dropdown_error_placeholder("Model list unavailable");
        chat_dependency_complete();
        return;
    }

    if (chat_models) g_ptr_array_unref(chat_models);
    chat_models = g_steal_pointer(&parsed_models);
    chat_rebuild_model_dropdown();

    if (!chat_models || chat_models->len == 0) {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "No models available. Configure provider/model first.");
        chat_set_model_dropdown_error_placeholder("No model selected");
    }
    chat_dependency_complete();
}

static void on_agents_response(const GatewayRpcResponse *response, gpointer user_data) {
    ChatRequestContext *ctx = (ChatRequestContext *)user_data;
    if (chat_request_context_is_stale(ctx)) {
        chat_request_context_free(ctx);
        return;
    }
    chat_request_context_free(ctx);

    g_autoptr(GPtrArray) parsed_agents =
        g_ptr_array_new_with_free_func((GDestroyNotify)chat_agent_choice_free);
    const gchar *default_id = NULL;

    if (!chat_status_label) {
        chat_dependency_complete();
        return;
    }

    if (!response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        if (chat_status_label) {
            gtk_label_set_text(GTK_LABEL(chat_status_label), "Failed to load agents.list");
        }
        chat_set_agent_dropdown_placeholder("No agents available", FALSE);
        chat_dependency_complete();
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    default_id = oc_json_string_member(obj, "defaultId");
    JsonNode *an = json_object_get_member(obj, "agents");
    if (an && JSON_NODE_HOLDS_ARRAY(an)) {
        JsonArray *arr = json_node_get_array(an);
        for (guint i = 0; i < json_array_get_length(arr); i++) {
            JsonNode *n = json_array_get_element(arr, i);
            if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
            JsonObject *ao = json_node_get_object(n);
            ChatAgentChoice *a = g_new0(ChatAgentChoice, 1);
            const gchar *id = oc_json_string_member(ao, "id");
            if (!id || id[0] == '\0') {
                chat_agent_choice_free(a);
                continue;
            }
            a->id = g_strdup(id);
            const gchar *name = oc_json_string_member(ao, "name");
            if (!name && json_object_has_member(ao, "identity")) {
                JsonNode *identity_node = json_object_get_member(ao, "identity");
                if (identity_node && JSON_NODE_HOLDS_OBJECT(identity_node)) {
                    JsonObject *identity = json_node_get_object(identity_node);
                    name = oc_json_string_member(identity, "name");
                }
            }
            a->name = g_strdup(name ? name : a->id);
            g_ptr_array_add(parsed_agents, a);
        }
    }

    if (chat_agents) g_ptr_array_unref(chat_agents);
    chat_agents = g_steal_pointer(&parsed_agents);

    if (!chat_selected_agent_id || chat_selected_agent_id[0] == '\0') {
        g_free(chat_selected_agent_id);
        if (default_id && default_id[0] != '\0') {
            chat_selected_agent_id = g_strdup(default_id);
        } else if (chat_agents->len > 0) {
            ChatAgentChoice *first = g_ptr_array_index(chat_agents, 0);
            chat_selected_agent_id = g_strdup(first->id);
        }
    }

    if (!chat_agents || chat_agents->len == 0) {
        chat_set_agent_dropdown_placeholder("No agents available", FALSE);
        gtk_label_set_text(GTK_LABEL(chat_status_label), "No agents available for chat.");
        chat_dependency_complete();
        return;
    }

    chat_rebuild_agent_dropdown();
    chat_request_sessions_for_selected_agent();
    chat_dependency_complete();
}

static void on_chat_send_response(const GatewayRpcResponse *response, gpointer user_data) {
    ChatRequestContext *ctx = (ChatRequestContext *)user_data;
    if (chat_request_context_is_stale(ctx)) {
        chat_request_context_free(ctx);
        return;
    }
    chat_request_context_free(ctx);

    if (!chat_status_label) {
        return;
    }

    if (!response || !response->ok) {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "chat.send failed");
        chat_clear_pending_state();
        chat_rebuild_messages_ui();
    }
}

static void chat_send_current_message(void) {
    if (!chat_gate_info.ready || !chat_selected_session_key || !chat_compose_view) return;

    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(chat_compose_view));
    GtkTextIter start, end;
    gtk_text_buffer_get_bounds(buf, &start, &end);
    g_autofree gchar *text = gtk_text_buffer_get_text(buf, &start, &end, FALSE);
    g_strstrip(text);
    if (!text || text[0] == '\0') {
        chat_set_send_enabled();
        return;
    }

    chat_append_history_node(chat_message_node_from_text("user", text));
    chat_clear_pending_state();
    chat_pending_run_id = g_uuid_string_random();
    chat_pending_session_key = g_strdup(chat_selected_session_key);
    chat_pending_assistant_text = g_strdup("");
    chat_rebuild_messages_ui();

    gtk_text_buffer_set_text(buf, "", -1);
    chat_set_send_enabled();

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "sessionKey");
    json_builder_add_string_value(b, chat_selected_session_key);
    json_builder_set_member_name(b, "message");
    json_builder_add_string_value(b, text);
    json_builder_set_member_name(b, "idempotencyKey");
    json_builder_add_string_value(b, chat_pending_run_id);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    ChatRequestContext *ctx = chat_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("chat.send", params, 0, on_chat_send_response, ctx);
    json_node_unref(params);
    if (!rid) {
        chat_request_context_free(ctx);
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Unable to send while disconnected");
        chat_clear_pending_state();
        chat_rebuild_messages_ui();
    } else {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Sending message…");
    }
}

static gboolean on_compose_key_pressed(GtkEventControllerKey *controller,
                                       guint keyval,
                                       guint keycode,
                                       GdkModifierType state,
                                       gpointer user_data) {
    (void)controller;
    (void)keycode;
    (void)user_data;
    if (keyval == GDK_KEY_Return || keyval == GDK_KEY_KP_Enter) {
        if ((state & GDK_SHIFT_MASK) != 0) {
            return FALSE;
        }
        chat_send_current_message();
        return TRUE;
    }
    return FALSE;
}

static void on_compose_text_changed(GtkTextBuffer *buffer, gpointer user_data) {
    (void)buffer;
    (void)user_data;
    chat_set_send_enabled();
}

static void on_send_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    chat_send_current_message();
}

static void on_chat_event(const gchar *event_type, const JsonNode *payload, gpointer user_data) {
    (void)user_data;
    if (!chat_status_label || !chat_messages_box) return;

    /* Rust bridge handles both legacy chat events and unified agent stream events. */
    if (g_strcmp0(event_type, "chat") != 0 && g_strcmp0(event_type, "agent") != 0) return;
    if (!payload || json_node_get_node_type((JsonNode *)payload) != JSON_NODE_OBJECT) return;

    JsonObject *obj = json_node_get_object((JsonNode *)payload);
    const gchar *session_key = oc_json_string_member(obj, "sessionKey");
    const gchar *run_id = oc_json_string_member(obj, "runId");
    if (!session_key || session_key[0] == '\0') return;

    if (g_strcmp0(event_type, "chat") == 0) {
        if (!chat_stream_claim_or_match_owner(session_key, run_id)) return;

        const gchar *state = oc_json_string_member(obj, "state");
        JsonNode *message_node = json_object_get_member(obj, "message");
        if (g_strcmp0(state, "delta") == 0) {
            g_autofree gchar *delta = chat_text_from_chat_event_message(message_node);
            if (delta && delta[0] != '\0') {
                g_autofree gchar *next =
                    g_strconcat(chat_pending_assistant_text ? chat_pending_assistant_text : "", delta, NULL);
                g_free(chat_pending_assistant_text);
                chat_pending_assistant_text = g_strdup(next);
            }
            if (chat_pending_is_for_selected_session()) {
                gtk_label_set_text(GTK_LABEL(chat_status_label), "Assistant streaming…");
                chat_rebuild_messages_ui();
            }
            return;
        }

        if (g_strcmp0(state, "final") == 0) {
            g_autofree gchar *final_text = chat_text_from_chat_event_message(message_node);
            if (final_text && final_text[0] != '\0') {
                g_free(chat_pending_assistant_text);
                chat_pending_assistant_text = g_strdup(final_text);
            }
            chat_finalize_pending_assistant("Assistant response complete");
            return;
        }

        if (g_strcmp0(state, "error") == 0) {
            chat_finalize_pending_assistant("Assistant returned an error");
            return;
        }
        if (g_strcmp0(state, "aborted") == 0) {
            chat_finalize_pending_assistant("Assistant response aborted");
            return;
        }
        return;
    }

    const gchar *stream = oc_json_string_member(obj, "stream");
    JsonObject *data_obj = oc_json_object_member(obj, "data");
    if (!stream) return;

    if (g_strcmp0(stream, "assistant") == 0 ||
        g_strcmp0(stream, "lifecycle") == 0 ||
        g_strcmp0(stream, "error") == 0) {
        if (!chat_stream_claim_or_match_owner(session_key, run_id)) return;
    }

    if (g_strcmp0(stream, "assistant") == 0) {
        if (!data_obj) return;
        const gchar *full_text = oc_json_string_member(data_obj, "text");
        if (full_text) {
            g_free(chat_pending_assistant_text);
            chat_pending_assistant_text = g_strdup(full_text);
        } else {
            /* Rust treats data.text as canonical and data.delta as a fallback chunk. */
            JsonNode *dn = json_object_get_member(data_obj, "delta");
            if (dn && JSON_NODE_HOLDS_VALUE(dn) && json_node_get_value_type(dn) == G_TYPE_STRING) {
                const gchar *delta = json_node_get_string(dn);
                g_autofree gchar *next = g_strconcat(chat_pending_assistant_text ? chat_pending_assistant_text : "", delta ? delta : "", NULL);
                g_free(chat_pending_assistant_text);
                chat_pending_assistant_text = g_strdup(next);
            }
        }
        if (chat_pending_is_for_selected_session()) {
            gtk_label_set_text(GTK_LABEL(chat_status_label), "Assistant streaming…");
            chat_rebuild_messages_ui();
        }
        return;
    }

    if (g_strcmp0(stream, "lifecycle") == 0) {
        if (!data_obj) return;
        const gchar *phase = oc_json_string_member(data_obj, "phase");
        if (g_strcmp0(phase, "start") == 0) {
            if (chat_pending_is_for_selected_session()) {
                gtk_label_set_text(GTK_LABEL(chat_status_label), "Assistant started");
                chat_rebuild_messages_ui();
            }
            return;
        }
        if (g_strcmp0(phase, "end") == 0) {
            chat_finalize_pending_assistant("Assistant response complete");
            return;
        }
        return;
    }

    if (g_strcmp0(stream, "error") == 0) {
        chat_finalize_pending_assistant("Assistant returned an error");
    }
}

static void on_chat_agent_changed(GtkDropDown *dropdown, GParamSpec *pspec, gpointer user_data) {
    (void)pspec;
    (void)user_data;
    if (chat_guard_agent_change) return;
    guint idx = gtk_drop_down_get_selected(dropdown);
    if (!chat_agents || idx >= chat_agents->len) return;
    ChatAgentChoice *a = g_ptr_array_index(chat_agents, idx);
    if (g_strcmp0(chat_selected_agent_id, a->id) == 0) return;
    g_free(chat_selected_agent_id);
    chat_selected_agent_id = g_strdup(a->id);
    section_mark_stale(&chat_last_fetch_us);
    chat_request_sessions_for_selected_agent();
}

static void on_chat_session_changed(GtkDropDown *dropdown, GParamSpec *pspec, gpointer user_data) {
    (void)pspec;
    (void)user_data;
    if (chat_guard_session_change) return;
    guint idx = gtk_drop_down_get_selected(dropdown);
    if (!chat_session_choices || idx >= chat_session_choices->len) return;
    SessionChoice *choice = g_ptr_array_index(chat_session_choices, idx);
    if (g_strcmp0(chat_selected_session_key, choice->key) == 0) return;
    g_free(chat_selected_session_key);
    chat_selected_session_key = g_strdup(choice->key);
    chat_update_model_from_selected_session();
    chat_request_history_for_selected();
}

static void on_chat_model_patch_response(const GatewayRpcResponse *response, gpointer user_data) {
    ChatRequestContext *ctx = (ChatRequestContext *)user_data;
    if (chat_request_context_is_stale(ctx)) {
        chat_request_context_free(ctx);
        return;
    }
    chat_request_context_free(ctx);

    if (!chat_status_label) {
        return;
    }

    if (response && response->ok) {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Session model updated");
    } else {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Failed to patch session model");
    }
}

static void on_chat_model_changed(GtkDropDown *dropdown, GParamSpec *pspec, gpointer user_data) {
    (void)pspec;
    (void)user_data;
    if (chat_guard_model_change) return;
    guint idx = gtk_drop_down_get_selected(dropdown);
    const gchar *model_id = NULL;
    if (idx > 0 && chat_models && (idx - 1) < chat_models->len) {
        ChatModelChoice *m = g_ptr_array_index(chat_models, idx - 1);
        model_id = m->id;
    }

    g_free(chat_selected_model_id);
    chat_selected_model_id = model_id ? g_strdup(model_id) : NULL;

    if (!chat_selected_session_key || !chat_gate_info.ready) return;

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "key");
    json_builder_add_string_value(b, chat_selected_session_key);
    json_builder_set_member_name(b, "model");
    if (model_id) json_builder_add_string_value(b, model_id); else json_builder_add_null_value(b);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    ChatRequestContext *ctx = chat_request_context_new();
    g_autofree gchar *rid = gateway_rpc_request("sessions.patch", params, 0,
                                                on_chat_model_patch_response, ctx);
    json_node_unref(params);
    if (!rid) {
        chat_request_context_free(ctx);
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Failed to send sessions.patch");
    }
}

static void on_show_thinking_toggled(GtkCheckButton *button, gpointer user_data) {
    (void)user_data;
    chat_show_thinking = gtk_check_button_get_active(button);
    chat_rebuild_messages_ui();
}

static void on_show_tools_toggled(GtkCheckButton *button, gpointer user_data) {
    (void)user_data;
    chat_show_tools = gtk_check_button_get_active(button);
    chat_rebuild_messages_ui();
}

static GtkWidget* chat_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled), GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Chat");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    chat_status_label = gtk_label_new("Loading…");
    gtk_widget_add_css_class(chat_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(chat_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), chat_status_label);

    GtkWidget *controls = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    chat_agent_model = NULL;
    chat_model_model = NULL;
    chat_session_model = NULL;

    chat_agent_dropdown = gtk_drop_down_new(NULL, NULL);
    chat_model_dropdown = gtk_drop_down_new(NULL, NULL);
    chat_session_dropdown = gtk_drop_down_new(NULL, NULL);
    gtk_widget_set_hexpand(chat_session_dropdown, TRUE);

    chat_attach_agent_dropdown_model(gtk_string_list_new(NULL), 0, TRUE);
    chat_attach_model_dropdown_model(gtk_string_list_new(NULL), 0, TRUE);
    chat_attach_session_dropdown_model(gtk_string_list_new(NULL), 0, TRUE);

    g_signal_connect(chat_agent_dropdown, "notify::selected", G_CALLBACK(on_chat_agent_changed), NULL);
    g_signal_connect(chat_model_dropdown, "notify::selected", G_CALLBACK(on_chat_model_changed), NULL);
    g_signal_connect(chat_session_dropdown, "notify::selected", G_CALLBACK(on_chat_session_changed), NULL);

    gtk_box_append(GTK_BOX(controls), chat_agent_dropdown);
    gtk_box_append(GTK_BOX(controls), chat_model_dropdown);
    gtk_box_append(GTK_BOX(controls), chat_session_dropdown);

    chat_show_thinking_toggle = gtk_check_button_new_with_label("Show thinking");
    chat_show_tools_toggle = gtk_check_button_new_with_label("Show tools");
    gtk_check_button_set_active(GTK_CHECK_BUTTON(chat_show_tools_toggle), TRUE);
    g_signal_connect(chat_show_thinking_toggle, "toggled", G_CALLBACK(on_show_thinking_toggled), NULL);
    g_signal_connect(chat_show_tools_toggle, "toggled", G_CALLBACK(on_show_tools_toggled), NULL);
    gtk_box_append(GTK_BOX(controls), chat_show_thinking_toggle);
    gtk_box_append(GTK_BOX(controls), chat_show_tools_toggle);
    gtk_box_append(GTK_BOX(page), controls);

    chat_messages_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
    gtk_box_append(GTK_BOX(page), chat_messages_box);

    GtkWidget *compose_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    chat_compose_view = gtk_text_view_new();
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(chat_compose_view), GTK_WRAP_WORD_CHAR);
    gtk_widget_set_hexpand(chat_compose_view, TRUE);
    gtk_widget_set_size_request(chat_compose_view, -1, 96);
    GtkEventController *key_ctrl = gtk_event_controller_key_new();
    g_signal_connect(key_ctrl, "key-pressed", G_CALLBACK(on_compose_key_pressed), NULL);
    gtk_widget_add_controller(chat_compose_view, key_ctrl);
    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(chat_compose_view));
    g_signal_connect(buf, "changed", G_CALLBACK(on_compose_text_changed), NULL);
    gtk_box_append(GTK_BOX(compose_row), chat_compose_view);

    chat_send_btn = gtk_button_new_with_label("Send");
    gtk_widget_add_css_class(chat_send_btn, "suggested-action");
    g_signal_connect(chat_send_btn, "clicked", G_CALLBACK(on_send_clicked), NULL);
    gtk_box_append(GTK_BOX(compose_row), chat_send_btn);
    gtk_box_append(GTK_BOX(page), compose_row);

    if (!chat_history_messages) {
        chat_history_messages = g_ptr_array_new_with_free_func((GDestroyNotify)json_node_unref);
    }
    chat_event_listener_id = gateway_ws_event_subscribe(on_chat_event, NULL);

    chat_rebuild_agent_dropdown();
    chat_rebuild_model_dropdown();
    chat_rebuild_session_dropdown();

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    chat_set_send_enabled();
    return scrolled;
}

static void chat_refresh(void) {
    if (!chat_status_label || chat_fetch_in_flight || chat_sessions_in_flight || chat_history_in_flight) return;

    const DesktopReadinessSnapshot *snapshot = state_get_readiness_snapshot();
    readiness_describe_chat_gate(snapshot, &chat_gate_info);
    if (!chat_gate_info.ready) {
        chat_render_blocked_state(&chat_gate_info);
        chat_set_send_enabled();
        return;
    }

    if (!section_is_stale(&chat_last_fetch_us)) {
        if (!chat_selected_session_key) {
            chat_set_session_dropdown_placeholder("No sessions yet", FALSE);
        }
        chat_set_send_enabled();
        return;
    }

    chat_fetch_in_flight = TRUE;
    chat_dependencies_pending = 0;
    ChatRequestContext *agents_ctx = chat_request_context_new();
    g_autofree gchar *agents_rid = gateway_rpc_request("agents.list", NULL, 0, on_agents_response, agents_ctx);
    if (agents_rid) chat_dependencies_pending++;
    else chat_request_context_free(agents_ctx);

    ChatRequestContext *models_ctx = chat_request_context_new();
    g_autofree gchar *models_rid = gateway_rpc_request("models.list", NULL, 0, on_models_response, models_ctx);
    if (models_rid) chat_dependencies_pending++;
    else chat_request_context_free(models_ctx);

    if (!agents_rid || !models_rid) {
        gtk_label_set_text(GTK_LABEL(chat_status_label), "Failed to request chat dependencies");
        chat_fetch_in_flight = FALSE;
        chat_dependencies_pending = 0;
        chat_set_agent_dropdown_placeholder("No agents available", FALSE);
        chat_set_model_dropdown_error_placeholder("Model list unavailable");
        chat_set_session_dropdown_placeholder("No sessions yet", FALSE);
    }
    chat_set_send_enabled();
}

static void chat_destroy(void) {
    chat_generation++;

    if (chat_event_listener_id) {
        gateway_ws_event_unsubscribe(chat_event_listener_id);
        chat_event_listener_id = 0;
    }

    ui_dropdown_detach_model(chat_agent_dropdown, (gpointer *)&chat_agent_model);
    ui_dropdown_detach_model(chat_model_dropdown, (gpointer *)&chat_model_model);
    ui_dropdown_detach_model(chat_session_dropdown, (gpointer *)&chat_session_model);

    chat_status_label = NULL;
    chat_messages_box = NULL;
    chat_agent_dropdown = NULL;
    chat_model_dropdown = NULL;
    chat_session_dropdown = NULL;
    chat_show_thinking_toggle = NULL;
    chat_show_tools_toggle = NULL;
    chat_compose_view = NULL;
    chat_send_btn = NULL;

    chat_agent_model = NULL;
    chat_model_model = NULL;
    chat_session_model = NULL;

    gateway_sessions_data_free(chat_sessions_cache);
    chat_sessions_cache = NULL;
    if (chat_agents) g_ptr_array_unref(chat_agents);
    if (chat_models) g_ptr_array_unref(chat_models);
    if (chat_session_choices) g_ptr_array_unref(chat_session_choices);
    if (chat_history_messages) g_ptr_array_unref(chat_history_messages);
    if (chat_finalized_assistant_queue) g_ptr_array_unref(chat_finalized_assistant_queue);
    chat_agents = NULL;
    chat_models = NULL;
    chat_session_choices = NULL;
    chat_history_messages = NULL;
    chat_finalized_assistant_queue = NULL;

    g_clear_pointer(&chat_selected_agent_id, g_free);
    g_clear_pointer(&chat_selected_model_id, g_free);
    g_clear_pointer(&chat_selected_session_key, g_free);
    g_clear_pointer(&chat_last_finalized_run_id, g_free);
    g_clear_pointer(&chat_last_finalized_session_key, g_free);
    chat_clear_pending_state();

    chat_fetch_in_flight = FALSE;
    chat_sessions_in_flight = FALSE;
    chat_history_in_flight = FALSE;
    chat_dependencies_pending = 0;
    chat_last_fetch_us = 0;
    chat_show_thinking = FALSE;
    chat_show_tools = TRUE;
    chat_gate_info.ready = FALSE;
    chat_gate_info.reason = CHAT_BLOCK_UNKNOWN;
    chat_gate_info.status = NULL;
    chat_gate_info.next_action = NULL;
}

static void chat_invalidate(void) {
    section_mark_stale(&chat_last_fetch_us);
    chat_clear_pending_state();
}

static const SectionController chat_controller = {
    .build = chat_build,
    .refresh = chat_refresh,
    .destroy = chat_destroy,
    .invalidate = chat_invalidate,
};

const SectionController* section_chat_get(void) {
    return &chat_controller;
}
