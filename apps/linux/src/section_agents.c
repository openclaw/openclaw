/*
 * section_agents.c
 * Description: Agents management section controller for the Linux companion app.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_agents.h"

#include <adwaita.h>

#include "gateway_data.h"
#include "gateway_rpc.h"
#include "json_access.h"
#include "log.h"
#include "format_utils.h"
#include "ui_model_utils.h"

typedef struct {
    gchar *id;
    gchar *name;
    gchar *workspace;
    gchar *emoji;
    gchar *avatar;
    gchar *model;
} AgentRow;

typedef struct {
    gchar *name;
    gchar *path;
    guint64 size;
    gboolean missing;
} AgentFileRow;

typedef struct {
    gchar *id;
    gchar *label;
} AgentModelChoice;

static void agent_row_free(AgentRow *a) {
    if (!a) return;
    g_free(a->id);
    g_free(a->name);
    g_free(a->workspace);
    g_free(a->emoji);
    g_free(a->avatar);
    g_free(a->model);
    g_free(a);
}

static void agent_file_row_free(AgentFileRow *f) {
    if (!f) return;
    g_free(f->name);
    g_free(f->path);
    g_free(f);
}

static void agent_model_choice_free(AgentModelChoice *m) {
    if (!m) return;
    g_free(m->id);
    g_free(m->label);
    g_free(m);
}

static GtkWidget *agents_status_label = NULL;
static GtkWidget *agents_list_box = NULL;
static GtkWidget *agents_files_box = NULL;
static GtkWidget *agents_name_entry = NULL;
static GtkWidget *agents_workspace_entry = NULL;
static GtkWidget *agents_avatar_entry = NULL;
static GtkWidget *agents_model_dropdown = NULL;
static GtkStringList *agents_model_dropdown_model = NULL;
static GtkWidget *agents_selected_label = NULL;

static GPtrArray *agents_cache = NULL;
static GPtrArray *agent_models_cache = NULL;
static gint agents_selected_index = -1;
static gchar *agents_selected_agent_id = NULL;
static gboolean agents_fetch_in_flight = FALSE;
static gint64 agents_last_fetch_us = 0;
static guint agents_generation = 1;

typedef struct {
    guint generation;
} AgentsRequestContext;

static AgentsRequestContext* agents_request_context_new(void) {
    AgentsRequestContext *ctx = g_new0(AgentsRequestContext, 1);
    ctx->generation = agents_generation;
    return ctx;
}

static gboolean agents_request_context_is_stale(const AgentsRequestContext *ctx) {
    return !ctx || ctx->generation != agents_generation;
}

static void agents_request_context_free(gpointer data) {
    g_free(data);
}

static void agents_attach_dropdown_model(GtkStringList *new_model, guint selected, gboolean sensitive) {
    if (!new_model) return;
    ui_dropdown_replace_model(agents_model_dropdown,
                              (gpointer *)&agents_model_dropdown_model,
                              G_LIST_MODEL(new_model),
                              selected,
                              sensitive);
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: model attach selected=%u sensitive=%d", selected, sensitive);
}

static void agents_set_model_dropdown_placeholder(const gchar *label, gboolean sensitive) {
    GtkStringList *placeholder = gtk_string_list_new(NULL);
    gtk_string_list_append(placeholder, label && label[0] != '\0' ? label : "Session default");
    agents_attach_dropdown_model(placeholder, 0, sensitive);
}

static const gchar* agents_selected_agent_model(void) {
    if (!agents_cache || agents_selected_index < 0 || (guint)agents_selected_index >= agents_cache->len) {
        return NULL;
    }
    AgentRow *a = g_ptr_array_index(agents_cache, agents_selected_index);
    return a ? a->model : NULL;
}

static const gchar* agents_selected_model_id(void) {
    guint idx = agents_model_dropdown ? gtk_drop_down_get_selected(GTK_DROP_DOWN(agents_model_dropdown)) : 0;
    if (idx == 0 || !agent_models_cache || (idx - 1) >= agent_models_cache->len) {
        return NULL;
    }
    AgentModelChoice *m = g_ptr_array_index(agent_models_cache, idx - 1);
    return m->id;
}

static void agents_rebuild_model_dropdown(const gchar *preferred_model) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    gtk_string_list_append(new_model, "Session default");
    guint selected = 0;
    for (guint i = 0; agent_models_cache && i < agent_models_cache->len; i++) {
        AgentModelChoice *m = g_ptr_array_index(agent_models_cache, i);
        gtk_string_list_append(new_model, m->label ? m->label : m->id);
        if (preferred_model && g_strcmp0(preferred_model, m->id) == 0) {
            selected = i + 1;
        }
    }
    agents_attach_dropdown_model(new_model, selected, TRUE);
}

static void agents_list_clear(void) {
    if (!agents_list_box) return;
    GtkWidget *child = gtk_widget_get_first_child(agents_list_box);
    while (child) {
        GtkWidget *next = gtk_widget_get_next_sibling(child);
        gtk_list_box_remove(GTK_LIST_BOX(agents_list_box), child);
        child = next;
    }
}

static void agents_rebuild_files(const GPtrArray *files) {
    if (!agents_files_box) return;
    section_box_clear(agents_files_box);

    if (!files || files->len == 0) {
        GtkWidget *empty = gtk_label_new("No workspace files");
        gtk_widget_add_css_class(empty, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(empty), 0.0);
        gtk_box_append(GTK_BOX(agents_files_box), empty);
        return;
    }

    for (guint i = 0; i < files->len; i++) {
        AgentFileRow *f = g_ptr_array_index((GPtrArray*)files, i);
        g_autofree gchar *size = format_size_bytes(f->size);
        const gchar *name = f->name ? f->name : (f->path ? f->path : "(unknown)");
        g_autofree gchar *line = g_strdup_printf("%s (%s)%s", name, size, f->missing ? " [missing]" : "");
        GtkWidget *lbl = gtk_label_new(line);
        gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
        gtk_widget_add_css_class(lbl, "dim-label");
        gtk_box_append(GTK_BOX(agents_files_box), lbl);
    }
}

static void on_agents_files_response(const GatewayRpcResponse *response, gpointer user_data) {
    AgentsRequestContext *ctx = (AgentsRequestContext *)user_data;
    if (agents_request_context_is_stale(ctx)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: stale files callback dropped");
        agents_request_context_free(ctx);
        return;
    }
    agents_request_context_free(ctx);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: files callback ok=%d", response ? response->ok : 0);
    g_autoptr(GPtrArray) files = g_ptr_array_new_with_free_func((GDestroyNotify)agent_file_row_free);

    if (response->ok && response->payload && JSON_NODE_HOLDS_OBJECT(response->payload)) {
        JsonObject *obj = json_node_get_object(response->payload);
        if (json_object_has_member(obj, "files")) {
            JsonNode *fn = json_object_get_member(obj, "files");
            if (fn && JSON_NODE_HOLDS_ARRAY(fn)) {
                JsonArray *arr = json_node_get_array(fn);
                guint len = json_array_get_length(arr);
                for (guint i = 0; i < len; i++) {
                    JsonNode *n = json_array_get_element(arr, i);
                    if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
                    JsonObject *fo = json_node_get_object(n);
                    AgentFileRow *row = g_new0(AgentFileRow, 1);
                    if (json_object_has_member(fo, "name")) {
                        JsonNode *nn = json_object_get_member(fo, "name");
                        if (nn && JSON_NODE_HOLDS_VALUE(nn) && json_node_get_value_type(nn) == G_TYPE_STRING) {
                            row->name = g_strdup(json_node_get_string(nn));
                        }
                    }
                    if (json_object_has_member(fo, "path")) {
                        JsonNode *pn = json_object_get_member(fo, "path");
                        if (pn && JSON_NODE_HOLDS_VALUE(pn) && json_node_get_value_type(pn) == G_TYPE_STRING) {
                            row->path = g_strdup(json_node_get_string(pn));
                        }
                    }
                    if (json_object_has_member(fo, "size")) {
                        JsonNode *sn = json_object_get_member(fo, "size");
                        if (sn && JSON_NODE_HOLDS_VALUE(sn) && json_node_get_value_type(sn) == G_TYPE_INT64) {
                            row->size = (guint64)json_node_get_int(sn);
                        }
                    }
                    if (json_object_has_member(fo, "missing")) {
                        JsonNode *mn = json_object_get_member(fo, "missing");
                        if (mn && JSON_NODE_HOLDS_VALUE(mn) && json_node_get_value_type(mn) == G_TYPE_BOOLEAN) {
                            row->missing = json_node_get_boolean(mn);
                        }
                    }
                    g_ptr_array_add(files, row);
                }
            }
        }
    }

    agents_rebuild_files(files);
}

static void agents_request_files_for_selected(void) {
    if (agents_selected_index < 0 || !agents_cache) return;
    if ((guint)agents_selected_index >= agents_cache->len) return;
    if (!gateway_rpc_is_ready()) return;

    AgentRow *agent = g_ptr_array_index(agents_cache, agents_selected_index);
    if (!agent || !agent->id) return;

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "agentId");
    json_builder_add_string_value(b, agent->id);
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    AgentsRequestContext *ctx = agents_request_context_new();
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: request agents.files.list");
    g_autofree gchar *rid = gateway_rpc_request("agents.files.list", params, 0,
                                                on_agents_files_response, ctx);
    json_node_unref(params);
    if (!rid) {
        agents_request_context_free(ctx);
        agents_rebuild_files(NULL);
    }
}

static void agents_populate_editor(void) {
    if (!agents_cache || agents_selected_index < 0 || (guint)agents_selected_index >= agents_cache->len) {
        gtk_label_set_text(GTK_LABEL(agents_selected_label), "No agent selected");
        gtk_editable_set_text(GTK_EDITABLE(agents_name_entry), "");
        gtk_editable_set_text(GTK_EDITABLE(agents_workspace_entry), "");
        gtk_editable_set_text(GTK_EDITABLE(agents_avatar_entry), "");
        agents_rebuild_model_dropdown(NULL);
        agents_rebuild_files(NULL);
        return;
    }

    AgentRow *a = g_ptr_array_index(agents_cache, agents_selected_index);
    g_autofree gchar *title = g_strdup_printf("Selected: %s", a->id ? a->id : "(unknown)");
    gtk_label_set_text(GTK_LABEL(agents_selected_label), title);
    gtk_editable_set_text(GTK_EDITABLE(agents_name_entry), a->name ? a->name : "");
    gtk_editable_set_text(GTK_EDITABLE(agents_workspace_entry), a->workspace ? a->workspace : "");
    gtk_editable_set_text(GTK_EDITABLE(agents_avatar_entry), a->avatar ? a->avatar : "");
    agents_rebuild_model_dropdown(a->model);
    agents_request_files_for_selected();
}

static void on_agents_row_activated(GtkListBox *box, GtkListBoxRow *row, gpointer user_data) {
    (void)box;
    (void)user_data;
    if (!row) return;
    agents_selected_index = gtk_list_box_row_get_index(row);
    if (agents_cache && agents_selected_index >= 0 && (guint)agents_selected_index < agents_cache->len) {
        AgentRow *selected = g_ptr_array_index(agents_cache, agents_selected_index);
        g_free(agents_selected_agent_id);
        agents_selected_agent_id = g_strdup(selected->id);
    }
    agents_populate_editor();
}

static void agents_rebuild_list(void) {
    if (!agents_list_box) return;
    agents_list_clear();

    if (!agents_cache || agents_cache->len == 0) {
        GtkWidget *empty = gtk_label_new("No agents available");
        gtk_widget_add_css_class(empty, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(empty), 0.0);
        gtk_list_box_append(GTK_LIST_BOX(agents_list_box), empty);
        return;
    }

    for (guint i = 0; i < agents_cache->len; i++) {
        AgentRow *a = g_ptr_array_index(agents_cache, i);
        g_autofree gchar *title = g_strdup_printf("%s%s", a->emoji ? a->emoji : "", a->emoji ? " " : "");
        g_autofree gchar *subtitle = g_strdup_printf("%s (%s) • %s",
                                                     a->name ? a->name : "Unnamed",
                                                     a->id ? a->id : "unknown",
                                                     a->model ? a->model : "session default");
        g_autofree gchar *line = g_strdup_printf("%s%s", title, subtitle);
        GtkWidget *row = gtk_label_new(line);
        gtk_label_set_xalign(GTK_LABEL(row), 0.0);
        gtk_label_set_ellipsize(GTK_LABEL(row), PANGO_ELLIPSIZE_END);
        gtk_list_box_append(GTK_LIST_BOX(agents_list_box), row);
    }

    if (agents_selected_index >= 0) {
        GtkListBoxRow *selected = gtk_list_box_get_row_at_index(GTK_LIST_BOX(agents_list_box), agents_selected_index);
        if (selected) gtk_list_box_select_row(GTK_LIST_BOX(agents_list_box), selected);
    }
}

static void on_agents_update_response(const GatewayRpcResponse *response, gpointer user_data) {
    AgentsRequestContext *ctx = (AgentsRequestContext *)user_data;
    if (agents_request_context_is_stale(ctx)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: stale update callback dropped");
        agents_request_context_free(ctx);
        return;
    }
    agents_request_context_free(ctx);

    if (!agents_status_label) return;
    if (response->ok) {
        gtk_label_set_text(GTK_LABEL(agents_status_label), "Agent updated");
        section_mark_stale(&agents_last_fetch_us);
    } else {
        gtk_label_set_text(GTK_LABEL(agents_status_label), "Agent update failed");
    }
}

static void on_agents_save_clicked(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    if (!agents_cache || agents_selected_index < 0 || (guint)agents_selected_index >= agents_cache->len) {
        return;
    }
    if (!gateway_rpc_is_ready()) return;

    AgentRow *a = g_ptr_array_index(agents_cache, agents_selected_index);
    if (!a->id || a->id[0] == '\0') {
        gtk_label_set_text(GTK_LABEL(agents_status_label), "Selected agent has no id");
        return;
    }

    const gchar *name = gtk_editable_get_text(GTK_EDITABLE(agents_name_entry));
    const gchar *workspace = gtk_editable_get_text(GTK_EDITABLE(agents_workspace_entry));
    const gchar *avatar = gtk_editable_get_text(GTK_EDITABLE(agents_avatar_entry));
    const gchar *model = agents_selected_model_id();

    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "agentId");
    json_builder_add_string_value(b, a->id);
    if (name && name[0] != '\0') {
        json_builder_set_member_name(b, "name");
        json_builder_add_string_value(b, name);
    }
    if (workspace && workspace[0] != '\0') {
        json_builder_set_member_name(b, "workspace");
        json_builder_add_string_value(b, workspace);
    }
    if (avatar && avatar[0] != '\0') {
        json_builder_set_member_name(b, "avatar");
        json_builder_add_string_value(b, avatar);
    }
    if (model && model[0] != '\0') {
        json_builder_set_member_name(b, "model");
        json_builder_add_string_value(b, model);
    }
    json_builder_end_object(b);
    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    AgentsRequestContext *ctx = agents_request_context_new();
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: request agents.update");
    g_autofree gchar *rid = gateway_rpc_request("agents.update", params, 0,
                                                on_agents_update_response, ctx);
    json_node_unref(params);
    if (!rid && agents_status_label) {
        agents_request_context_free(ctx);
        gtk_label_set_text(GTK_LABEL(agents_status_label), "Failed to send update");
    }
}

static void on_agents_list_response(const GatewayRpcResponse *response, gpointer user_data) {
    AgentsRequestContext *ctx = (AgentsRequestContext *)user_data;
    if (agents_request_context_is_stale(ctx)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: stale agents.list callback dropped");
        agents_request_context_free(ctx);
        return;
    }
    agents_request_context_free(ctx);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: agents.list callback ok=%d", response ? response->ok : 0);
    agents_fetch_in_flight = FALSE;

    if (!agents_status_label) return;

    if (!response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        gtk_label_set_text(GTK_LABEL(agents_status_label), "Failed to load agents");
        return;
    }

    if (agents_cache) {
        g_ptr_array_unref(agents_cache);
    }
    agents_cache = g_ptr_array_new_with_free_func((GDestroyNotify)agent_row_free);

    gchar *previous_agent_id = g_strdup(agents_selected_agent_id);

    JsonObject *obj = json_node_get_object(response->payload);
    if (json_object_has_member(obj, "agents")) {
        JsonNode *an = json_object_get_member(obj, "agents");
        if (an && JSON_NODE_HOLDS_ARRAY(an)) {
            JsonArray *arr = json_node_get_array(an);
            guint len = json_array_get_length(arr);
            for (guint i = 0; i < len; i++) {
                JsonNode *n = json_array_get_element(arr, i);
                if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
                JsonObject *ao = json_node_get_object(n);
                AgentRow *row = g_new0(AgentRow, 1);
                row->id = g_strdup(oc_json_string_member(ao, "id"));
                row->name = g_strdup(oc_json_string_member(ao, "name"));
                if (!row->id || row->id[0] == '\0') {
                    agent_row_free(row);
                    continue;
                }
                if (json_object_has_member(ao, "identity")) {
                    JsonNode *identity_node = json_object_get_member(ao, "identity");
                    if (identity_node && JSON_NODE_HOLDS_OBJECT(identity_node)) {
                        JsonObject *identity = json_node_get_object(identity_node);
                        const gchar *identity_name = oc_json_string_member(identity, "name");
                        if ((!row->name || row->name[0] == '\0') && identity_name) {
                            g_free(row->name);
                            row->name = g_strdup(identity_name);
                        }
                        row->emoji = g_strdup(oc_json_string_member(identity, "emoji"));
                        row->avatar = g_strdup(oc_json_string_member(identity, "avatar"));
                        if (!row->avatar) row->avatar = g_strdup(oc_json_string_member(identity, "avatarUrl"));
                    }
                }
                row->workspace = g_strdup(oc_json_string_member(ao, "workspace"));
                if (!row->avatar) row->avatar = g_strdup(oc_json_string_member(ao, "avatar"));
                if (json_object_has_member(ao, "model")) {
                    JsonNode *model_node = json_object_get_member(ao, "model");
                    if (model_node && JSON_NODE_HOLDS_OBJECT(model_node)) {
                        JsonObject *model = json_node_get_object(model_node);
                        row->model = g_strdup(oc_json_string_member(model, "primary"));
                    } else if (model_node && JSON_NODE_HOLDS_VALUE(model_node) &&
                               json_node_get_value_type(model_node) == G_TYPE_STRING) {
                        row->model = g_strdup(json_node_get_string(model_node));
                    }
                }
                g_ptr_array_add(agents_cache, row);
            }
        }
    }

    agents_selected_index = -1;
    for (guint i = 0; i < agents_cache->len; i++) {
        AgentRow *row = g_ptr_array_index(agents_cache, i);
        if (previous_agent_id && row->id && g_strcmp0(row->id, previous_agent_id) == 0) {
            agents_selected_index = (gint)i;
            break;
        }
    }
    if (agents_selected_index < 0 && agents_cache->len > 0) {
        agents_selected_index = 0;
    }
    if (agents_selected_index >= 0) {
        AgentRow *selected = g_ptr_array_index(agents_cache, agents_selected_index);
        g_free(agents_selected_agent_id);
        agents_selected_agent_id = g_strdup(selected->id);
    }
    g_free(previous_agent_id);

    agents_rebuild_list();
    agents_populate_editor();
    section_mark_fresh(&agents_last_fetch_us);

    g_autofree gchar *status = g_strdup_printf("%u agents", agents_cache->len);
    gtk_label_set_text(GTK_LABEL(agents_status_label), status);
}

static void on_agents_models_response(const GatewayRpcResponse *response, gpointer user_data) {
    AgentsRequestContext *ctx = (AgentsRequestContext *)user_data;
    if (agents_request_context_is_stale(ctx)) {
        OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: stale models.list callback dropped");
        agents_request_context_free(ctx);
        return;
    }
    agents_request_context_free(ctx);

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: models.list callback ok=%d", response ? response->ok : 0);
    if (agent_models_cache) g_ptr_array_unref(agent_models_cache);
    agent_models_cache = g_ptr_array_new_with_free_func((GDestroyNotify)agent_model_choice_free);

    if (!response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        agents_set_model_dropdown_placeholder("Models unavailable", FALSE);
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    JsonNode *mn = json_object_get_member(obj, "models");
    if (!mn || !JSON_NODE_HOLDS_ARRAY(mn)) {
        agents_set_model_dropdown_placeholder("No models available", FALSE);
        return;
    }

    JsonArray *arr = json_node_get_array(mn);
    for (guint i = 0; i < json_array_get_length(arr); i++) {
        JsonNode *n = json_array_get_element(arr, i);
        if (!n || !JSON_NODE_HOLDS_OBJECT(n)) continue;
        JsonObject *mo = json_node_get_object(n);
        AgentModelChoice *m = g_new0(AgentModelChoice, 1);
        if (json_object_has_member(mo, "id")) {
            JsonNode *idn = json_object_get_member(mo, "id");
            if (idn && JSON_NODE_HOLDS_VALUE(idn) && json_node_get_value_type(idn) == G_TYPE_STRING) {
                m->id = g_strdup(json_node_get_string(idn));
            }
        }
        const gchar *name = oc_json_string_member(mo, "name");
        const gchar *provider = oc_json_string_member(mo, "provider");
        m->label = g_strdup_printf("%s (%s)",
                                   name ? name : "model",
                                   provider ? provider : "provider");
        if (m->id) g_ptr_array_add(agent_models_cache, m); else agent_model_choice_free(m);
    }

    if (!agent_models_cache || agent_models_cache->len == 0) {
        agents_set_model_dropdown_placeholder("No models available", FALSE);
    } else {
        agents_rebuild_model_dropdown(agents_selected_agent_model());
    }
}

static GtkWidget* agents_build(void) {
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: build");

    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Agents");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    agents_status_label = gtk_label_new("Loading…");
    gtk_widget_add_css_class(agents_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(agents_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), agents_status_label);

    GtkWidget *content = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12);
    gtk_widget_set_hexpand(content, TRUE);
    gtk_widget_set_vexpand(content, TRUE);

    GtkWidget *left = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    gtk_widget_set_size_request(left, 260, -1);
    GtkWidget *left_title = gtk_label_new("Agent List");
    gtk_widget_add_css_class(left_title, "heading");
    gtk_label_set_xalign(GTK_LABEL(left_title), 0.0);
    gtk_box_append(GTK_BOX(left), left_title);

    GtkWidget *list_wrap = gtk_list_box_new();
    g_signal_connect(list_wrap, "row-activated", G_CALLBACK(on_agents_row_activated), NULL);
    agents_list_box = list_wrap;
    gtk_box_append(GTK_BOX(left), list_wrap);

    GtkWidget *right = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    gtk_widget_set_hexpand(right, TRUE);

    agents_selected_label = gtk_label_new("No agent selected");
    gtk_widget_add_css_class(agents_selected_label, "heading");
    gtk_label_set_xalign(GTK_LABEL(agents_selected_label), 0.0);
    gtk_box_append(GTK_BOX(right), agents_selected_label);

    agents_name_entry = gtk_entry_new();
    gtk_editable_set_text(GTK_EDITABLE(agents_name_entry), "");
    gtk_entry_set_placeholder_text(GTK_ENTRY(agents_name_entry), "Name");
    gtk_box_append(GTK_BOX(right), agents_name_entry);

    agents_workspace_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(agents_workspace_entry), "Workspace");
    gtk_box_append(GTK_BOX(right), agents_workspace_entry);

    agents_avatar_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(agents_avatar_entry), "Avatar URL or path");
    gtk_box_append(GTK_BOX(right), agents_avatar_entry);

    agents_model_dropdown_model = NULL;
    agents_model_dropdown = gtk_drop_down_new(NULL, NULL);
    agents_set_model_dropdown_placeholder("Loading models…", FALSE);
    gtk_box_append(GTK_BOX(right), agents_model_dropdown);

    GtkWidget *save_btn = gtk_button_new_with_label("Save Agent");
    gtk_widget_add_css_class(save_btn, "suggested-action");
    g_signal_connect(save_btn, "clicked", G_CALLBACK(on_agents_save_clicked), NULL);
    gtk_box_append(GTK_BOX(right), save_btn);

    GtkWidget *files_title = gtk_label_new("Workspace Files");
    gtk_widget_add_css_class(files_title, "heading");
    gtk_label_set_xalign(GTK_LABEL(files_title), 0.0);
    gtk_widget_set_margin_top(files_title, 8);
    gtk_box_append(GTK_BOX(right), files_title);

    agents_files_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
    gtk_box_append(GTK_BOX(right), agents_files_box);

    gtk_box_append(GTK_BOX(content), left);
    gtk_box_append(GTK_BOX(content), right);
    gtk_box_append(GTK_BOX(page), content);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void agents_refresh(void) {
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: refresh stale=%d inflight=%d", section_is_stale(&agents_last_fetch_us), agents_fetch_in_flight);
    if (!agents_status_label || agents_fetch_in_flight) return;
    if (!gateway_rpc_is_ready()) {
        gtk_label_set_text(GTK_LABEL(agents_status_label), "Gateway not connected");
        return;
    }
    if (!section_is_stale(&agents_last_fetch_us)) return;

    agents_fetch_in_flight = TRUE;
    AgentsRequestContext *list_ctx = agents_request_context_new();
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: request agents.list");
    g_autofree gchar *rid = gateway_rpc_request("agents.list", NULL, 0,
                                                on_agents_list_response, list_ctx);
    AgentsRequestContext *models_ctx = agents_request_context_new();
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: request models.list");
    g_autofree gchar *mrid = gateway_rpc_request("models.list", NULL, 0,
                                                 on_agents_models_response, models_ctx);
    if (!rid) {
        agents_request_context_free(list_ctx);
        agents_fetch_in_flight = FALSE;
        gtk_label_set_text(GTK_LABEL(agents_status_label), "Failed to request agents");
    }
    if (!mrid) {
        agents_request_context_free(models_ctx);
        agents_set_model_dropdown_placeholder("Models unavailable", FALSE);
    }
    (void)mrid;
}

static void agents_destroy(void) {
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: destroy begin");
    agents_generation++;

    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: model detach");
    ui_dropdown_detach_model(agents_model_dropdown, (gpointer *)&agents_model_dropdown_model);

    agents_status_label = NULL;
    agents_list_box = NULL;
    agents_files_box = NULL;
    agents_name_entry = NULL;
    agents_workspace_entry = NULL;
    agents_avatar_entry = NULL;
    agents_model_dropdown = NULL;
    agents_model_dropdown_model = NULL;
    agents_selected_label = NULL;

    if (agents_cache) g_ptr_array_unref(agents_cache);
    if (agent_models_cache) g_ptr_array_unref(agent_models_cache);
    agents_cache = NULL;
    agent_models_cache = NULL;
    agents_selected_index = -1;
    g_free(agents_selected_agent_id);
    agents_selected_agent_id = NULL;
    agents_fetch_in_flight = FALSE;
    agents_last_fetch_us = 0;
    OC_LOG_DEBUG(OPENCLAW_LOG_CAT_STATE, "agents: destroy end");
}

static void agents_invalidate(void) {
    section_mark_stale(&agents_last_fetch_us);
}

static const SectionController agents_controller = {
    .build = agents_build,
    .refresh = agents_refresh,
    .destroy = agents_destroy,
    .invalidate = agents_invalidate,
};

const SectionController* section_agents_get(void) {
    return &agents_controller;
}
