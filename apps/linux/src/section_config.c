/*
 * section_config.c
 *
 * Config section controller for the OpenClaw Linux Companion App.
 *
 * Owns the main-window configuration page UI, local rendering, validation
 * state presentation, and config mutation/refresh interactions delegated
 * through the shared gateway/config helpers.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_config.h"

#include <adwaita.h>
#include <json-glib/json-glib.h>

#include "config_setup_transform.h"
#include "display_model.h"
#include "gateway_client.h"
#include "gateway_data.h"
#include "gateway_mutations.h"
#include "gateway_rpc.h"
#include "json_access.h"
#include "readiness.h"
#include "state.h"
#include "ui_model_utils.h"

static GtkWidget *cfg_status_label = NULL;
static GtkWidget *cfg_path_label = NULL;
static GtkWidget *cfg_modified_label = NULL;
static GtkWidget *cfg_warning_label = NULL;
static GtkWidget *cfg_issues_label = NULL;
static GtkWidget *cfg_json_view = NULL;
static GtkWidget *cfg_validation_label = NULL;
static GtkWidget *cfg_copy_btn = NULL;
static GtkWidget *cfg_reload_btn = NULL;
static GtkWidget *cfg_save_btn = NULL;
static GtkWidget *cfg_setup_provider_label = NULL;
static GtkWidget *cfg_setup_default_model_label = NULL;
static GtkWidget *cfg_setup_catalog_label = NULL;
static GtkWidget *cfg_setup_readiness_label = NULL;
static GtkWidget *cfg_setup_status_label = NULL;
static GtkWidget *cfg_provider_id_entry = NULL;
static GtkWidget *cfg_provider_base_url_entry = NULL;
static GtkWidget *cfg_reload_models_btn = NULL;
static GtkWidget *cfg_model_dropdown = NULL;
static GtkStringList *cfg_model_dropdown_model = NULL;
static GtkWidget *cfg_apply_provider_btn = NULL;
static GtkWidget *cfg_apply_model_btn = NULL;
static guint cfg_copy_reset_id = 0;
static gboolean cfg_programmatic_change = FALSE;
static gboolean cfg_editor_dirty = FALSE;
static gboolean cfg_editor_valid = TRUE;
static gboolean cfg_request_in_flight = FALSE;
static gboolean cfg_initial_load_requested = FALSE;
static gchar *cfg_baseline_text = NULL;
static gchar *cfg_baseline_hash = NULL;
static guint cfg_generation = 1;
static gboolean cfg_models_request_in_flight = FALSE;
static GPtrArray *cfg_models_cache = NULL;

typedef struct {
    gchar *id;
    gchar *label;
} ConfigModelChoice;

static gchar* cfg_editor_get_text(void);
static void cfg_request_reload(void);
static void cfg_refresh_setup_surface(void);
static void on_cfg_save_done(const GatewayRpcResponse *response, gpointer user_data);

static void cfg_model_choice_free(ConfigModelChoice *choice) {
    if (!choice) {
        return;
    }

    g_free(choice->id);
    g_free(choice->label);
    g_free(choice);
}

static void cfg_attach_model_dropdown_model(GtkStringList *new_model,
                                            guint selected,
                                            gboolean enabled) {
    if (!new_model) {
        return;
    }

    ui_dropdown_replace_model(cfg_model_dropdown,
                              (gpointer *)&cfg_model_dropdown_model,
                              G_LIST_MODEL(new_model),
                              selected,
                              enabled);
}

static void cfg_set_model_dropdown_placeholder(const gchar *label,
                                               gboolean enabled) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    gtk_string_list_append(new_model, label && label[0] != '\0' ? label : "No models loaded");
    cfg_attach_model_dropdown_model(new_model, 0, enabled);
}

static gchar* cfg_extract_default_model_id(JsonObject *root_obj) {
    if (!root_obj || !json_object_has_member(root_obj, "agents")) {
        return NULL;
    }

    JsonNode *agents_node = json_object_get_member(root_obj, "agents");
    if (!agents_node || !JSON_NODE_HOLDS_OBJECT(agents_node)) {
        return NULL;
    }

    JsonObject *agents_obj = json_node_get_object(agents_node);
    JsonObject *defaults_obj = NULL;
    if (json_object_has_member(agents_obj, "defaults")) {
        JsonNode *defaults_node = json_object_get_member(agents_obj, "defaults");
        if (defaults_node && JSON_NODE_HOLDS_OBJECT(defaults_node)) {
            defaults_obj = json_node_get_object(defaults_node);
        }
    }
    if (!defaults_obj && json_object_has_member(agents_obj, "default")) {
        JsonNode *defaults_node = json_object_get_member(agents_obj, "default");
        if (defaults_node && JSON_NODE_HOLDS_OBJECT(defaults_node)) {
            defaults_obj = json_node_get_object(defaults_node);
        }
    }
    if (!defaults_obj || !json_object_has_member(defaults_obj, "model")) {
        return NULL;
    }

    JsonNode *model_node = json_object_get_member(defaults_obj, "model");
    if (model_node && JSON_NODE_HOLDS_VALUE(model_node) &&
        json_node_get_value_type(model_node) == G_TYPE_STRING) {
        const gchar *model = json_node_get_string(model_node);
        return (model && model[0] != '\0') ? g_strdup(model) : NULL;
    }
    if (model_node && JSON_NODE_HOLDS_OBJECT(model_node)) {
        JsonObject *model_obj = json_node_get_object(model_node);
        const gchar *primary = oc_json_string_member(model_obj, "primary");
        return (primary && primary[0] != '\0') ? g_strdup(primary) : NULL;
    }

    return NULL;
}

static gboolean cfg_set_editor_text_programmatically(const gchar *text) {
    if (!cfg_json_view) {
        return FALSE;
    }

    GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(cfg_json_view));
    cfg_programmatic_change = TRUE;
    gtk_text_buffer_set_text(buffer, text ? text : "{}", -1);
    cfg_programmatic_change = FALSE;
    return TRUE;
}

static void on_cfg_open_file(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg && cfg->config_path) {
        g_autofree gchar *uri = g_filename_to_uri(cfg->config_path, NULL, NULL);
        if (uri) {
            g_app_info_launch_default_for_uri(uri, NULL, NULL);
        }
    }
}

static void on_cfg_open_folder(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    GatewayConfig *cfg = gateway_client_get_config();
    if (cfg && cfg->config_path) {
        g_autofree gchar *dir = g_path_get_dirname(cfg->config_path);
        g_autofree gchar *uri = g_filename_to_uri(dir, NULL, NULL);
        if (uri) {
            g_app_info_launch_default_for_uri(uri, NULL, NULL);
        }
    }
}

static gboolean reset_cfg_copy_label(gpointer data) {
    (void)data;

    if (cfg_copy_btn) {
        gtk_button_set_label(GTK_BUTTON(cfg_copy_btn), "Copy Config JSON");
    }
    cfg_copy_reset_id = 0;
    return G_SOURCE_REMOVE;
}

static void on_cfg_copy_json(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    g_autofree gchar *contents = cfg_editor_get_text();
    if (!contents) {
        return;
    }

    GdkClipboard *clipboard = gdk_display_get_clipboard(gdk_display_get_default());
    gdk_clipboard_set_text(clipboard, contents);
    if (cfg_copy_btn) {
        gtk_button_set_label(GTK_BUTTON(cfg_copy_btn), "Copied!");
        if (cfg_copy_reset_id > 0) {
            g_source_remove(cfg_copy_reset_id);
        }
        cfg_copy_reset_id = g_timeout_add(2000, reset_cfg_copy_label, NULL);
    }
}

static gchar* cfg_get_modified_text(const char *path) {
    if (!path) {
        return g_strdup("—");
    }

    g_autoptr(GFile) file = g_file_new_for_path(path);
    g_autoptr(GFileInfo) info = g_file_query_info(file,
                                                  G_FILE_ATTRIBUTE_TIME_MODIFIED,
                                                  G_FILE_QUERY_INFO_NONE,
                                                  NULL,
                                                  NULL);
    if (!info) {
        return g_strdup("—");
    }

    g_autoptr(GDateTime) dt = g_file_info_get_modification_date_time(info);
    if (!dt) {
        return g_strdup("—");
    }

    g_autoptr(GDateTime) local = g_date_time_to_local(dt);
    return g_date_time_format(local, "%Y-%m-%d %H:%M:%S");
}

static gchar* cfg_editor_get_text(void) {
    if (!cfg_json_view) {
        return g_strdup("");
    }

    GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(cfg_json_view));
    GtkTextIter start;
    GtkTextIter end;
    gtk_text_buffer_get_bounds(buffer, &start, &end);
    return gtk_text_buffer_get_text(buffer, &start, &end, FALSE);
}

static void cfg_refresh_buttons(void) {
    if (cfg_reload_btn) {
        gtk_widget_set_sensitive(cfg_reload_btn, !cfg_request_in_flight);
    }
    if (cfg_save_btn) {
        gtk_widget_set_sensitive(cfg_save_btn,
                                 !cfg_request_in_flight && cfg_editor_dirty && cfg_editor_valid);
    }
    if (cfg_reload_models_btn) {
        gtk_widget_set_sensitive(cfg_reload_models_btn,
                                 !cfg_request_in_flight && !cfg_models_request_in_flight);
    }
    if (cfg_apply_provider_btn) {
        gtk_widget_set_sensitive(cfg_apply_provider_btn,
                                 !cfg_request_in_flight && cfg_editor_valid);
    }
    if (cfg_apply_model_btn) {
        gboolean has_models = cfg_models_cache && cfg_models_cache->len > 0;
        gtk_widget_set_sensitive(cfg_apply_model_btn,
                                 !cfg_request_in_flight && has_models && cfg_editor_valid);
    }
}

static void cfg_set_validation_message(const gchar *message, gboolean valid) {
    if (!cfg_validation_label) {
        return;
    }

    gtk_label_set_text(GTK_LABEL(cfg_validation_label), message ? message : "Validation unavailable");
    gtk_widget_remove_css_class(cfg_validation_label, "success");
    gtk_widget_remove_css_class(cfg_validation_label, "error");
    gtk_widget_add_css_class(cfg_validation_label, valid ? "success" : "error");
}

static GtkWidget* cfg_setup_fact_row(const gchar *title, GtkWidget **out_value) {
    GtkWidget *row = adw_action_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(row), title);

    GtkWidget *value = gtk_label_new("—");
    gtk_label_set_selectable(GTK_LABEL(value), TRUE);
    gtk_label_set_wrap(GTK_LABEL(value), TRUE);
    gtk_label_set_xalign(GTK_LABEL(value), 1.0);
    gtk_widget_set_hexpand(value, TRUE);
    gtk_widget_set_halign(value, GTK_ALIGN_END);
    adw_action_row_add_suffix(ADW_ACTION_ROW(row), value);

    *out_value = value;
    return row;
}

static gboolean cfg_validate_and_track(const gchar *text) {
    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) error = NULL;
    gboolean valid = json_parser_load_from_data(parser, text ? text : "", -1, &error);

    if (valid) {
        JsonNode *root = json_parser_get_root(parser);
        valid = root && JSON_NODE_HOLDS_OBJECT(root);
        if (!valid && cfg_validation_label) {
            cfg_set_validation_message("Validation: root value must be a JSON object", FALSE);
        }
    } else if (cfg_validation_label) {
        g_autofree gchar *message = g_strdup_printf("Validation: %s",
                                                    error && error->message ? error->message : "invalid JSON");
        cfg_set_validation_message(message, FALSE);
    }

    if (valid && cfg_validation_label) {
        cfg_set_validation_message("Validation: JSON is valid", TRUE);
    }

    cfg_editor_valid = valid;
    cfg_editor_dirty = (g_strcmp0(text ? text : "", cfg_baseline_text ? cfg_baseline_text : "") != 0);
    cfg_refresh_buttons();
    return valid;
}

static void cfg_request_save_text(const gchar *text) {
    if (cfg_request_in_flight) {
        return;
    }
    if (!cfg_validate_and_track(text)) {
        return;
    }
    if (!cfg_editor_dirty) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "No config changes to save.");
        }
        return;
    }

    cfg_request_in_flight = TRUE;
    cfg_refresh_buttons();
    guint current_gen = cfg_generation;
    g_autofree gchar *request_id = mutation_config_set(text,
                                                       cfg_baseline_hash,
                                                       on_cfg_save_done,
                                                       GUINT_TO_POINTER(current_gen));
    if (!request_id) {
        cfg_request_in_flight = FALSE;
        if (cfg_validation_label) {
            cfg_set_validation_message("Failed to request config.set", FALSE);
        }
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Provider/model save request failed.");
        }
        cfg_refresh_buttons();
    }
}

static void cfg_rebuild_models_dropdown(const gchar *default_model_id) {
    GtkStringList *new_model = gtk_string_list_new(NULL);
    guint selected = 0;
    for (guint i = 0; cfg_models_cache && i < cfg_models_cache->len; i++) {
        ConfigModelChoice *choice = g_ptr_array_index(cfg_models_cache, i);
        gtk_string_list_append(new_model, choice->label ? choice->label : choice->id);
        if (default_model_id && choice->id && g_strcmp0(choice->id, default_model_id) == 0) {
            selected = i;
        }
    }
    if (cfg_models_cache && cfg_models_cache->len > 0) {
        cfg_attach_model_dropdown_model(new_model, selected, TRUE);
    } else {
        cfg_attach_model_dropdown_model(new_model, 0, FALSE);
    }
}

static void cfg_refresh_setup_surface(void) {
    g_autofree gchar *text = cfg_editor_get_text();
    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) error = NULL;

    const gchar *provider_id = NULL;
    const gchar *provider_base_url = NULL;
    g_autofree gchar *default_model_id = NULL;

    if (json_parser_load_from_data(parser, text ? text : "", -1, &error)) {
        JsonNode *root = json_parser_get_root(parser);
        if (root && JSON_NODE_HOLDS_OBJECT(root)) {
            JsonObject *root_obj = json_node_get_object(root);
            default_model_id = cfg_extract_default_model_id(root_obj);

            if (json_object_has_member(root_obj, "models")) {
                JsonNode *models_node = json_object_get_member(root_obj, "models");
                if (models_node && JSON_NODE_HOLDS_OBJECT(models_node)) {
                    JsonObject *models_obj = json_node_get_object(models_node);
                    if (json_object_has_member(models_obj, "providers")) {
                        JsonNode *providers_node = json_object_get_member(models_obj, "providers");
                        if (providers_node && JSON_NODE_HOLDS_OBJECT(providers_node)) {
                            JsonObject *providers_obj = json_node_get_object(providers_node);
                            GList *members = json_object_get_members(providers_obj);
                            if (members) {
                                provider_id = members->data;
                                JsonNode *provider_node = json_object_get_member(providers_obj, provider_id);
                                if (provider_node && JSON_NODE_HOLDS_OBJECT(provider_node)) {
                                    JsonObject *provider_obj = json_node_get_object(provider_node);
                                    provider_base_url = oc_json_string_member(provider_obj, "baseUrl");
                                }
                            }
                            g_list_free(members);
                        }
                    }
                }
            }
        }
    }

    if (cfg_provider_id_entry) {
        gtk_editable_set_text(GTK_EDITABLE(cfg_provider_id_entry), provider_id ? provider_id : "");
    }
    if (cfg_provider_base_url_entry) {
        gtk_editable_set_text(GTK_EDITABLE(cfg_provider_base_url_entry), provider_base_url ? provider_base_url : "");
    }

    const DesktopReadinessSnapshot *snapshot = state_get_readiness_snapshot();
    ChatGateInfo gate = {0};
    readiness_describe_chat_gate(snapshot, &gate);
    if (cfg_setup_provider_label) {
        gtk_label_set_text(GTK_LABEL(cfg_setup_provider_label),
                           provider_id && provider_id[0] != '\0' ? provider_id : "missing");
    }
    if (cfg_setup_default_model_label) {
        gtk_label_set_text(GTK_LABEL(cfg_setup_default_model_label),
                           default_model_id ? default_model_id : "missing");
    }
    if (cfg_setup_catalog_label) {
        g_autofree gchar *catalog_text = g_strdup_printf("%s / %s",
                                                         snapshot && snapshot->model_catalog_available ? "catalog ready" : "catalog missing",
                                                         snapshot && snapshot->selected_model_resolved ? "selected resolved" : "selected unresolved");
        gtk_label_set_text(GTK_LABEL(cfg_setup_catalog_label), catalog_text);
    }
    if (cfg_setup_readiness_label) {
        g_autofree gchar *readiness_text = g_strdup_printf("%s / %s (%s)",
                                                           snapshot && snapshot->agents_available ? "agents ready" : "agents missing",
                                                           gate.ready ? "chat ready" : "chat blocked",
                                                           readiness_chat_block_reason_to_string(gate.reason));
        gtk_label_set_text(GTK_LABEL(cfg_setup_readiness_label), readiness_text);
    }

    if (cfg_setup_status_label) {
        if (gate.ready) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Chat is ready.");
        } else {
            g_autofree gchar *status = g_strdup_printf("Blocked (%s). %s",
                                                       readiness_chat_block_reason_to_string(gate.reason),
                                                       gate.next_action ? gate.next_action : "Resolve provider/model readiness.");
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), status);
        }
    }

    if (cfg_models_cache && cfg_models_cache->len > 0) {
        cfg_rebuild_models_dropdown(default_model_id);
    } else {
        cfg_set_model_dropdown_placeholder("Load models to pick default", FALSE);
    }
    cfg_refresh_buttons();
}

static void on_cfg_models_list_done(const GatewayRpcResponse *response, gpointer user_data) {
    guint generation = GPOINTER_TO_UINT(user_data);
    if (generation != cfg_generation) {
        return;
    }

    cfg_models_request_in_flight = FALSE;
    if (cfg_models_cache) {
        g_ptr_array_unref(cfg_models_cache);
    }
    cfg_models_cache = g_ptr_array_new_with_free_func((GDestroyNotify)cfg_model_choice_free);

    if (!response || !response->ok || !response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Failed to reload models from gateway.");
        }
        cfg_set_model_dropdown_placeholder("Model list unavailable", FALSE);
        cfg_refresh_buttons();
        return;
    }

    JsonObject *obj = json_node_get_object(response->payload);
    JsonNode *models_node = json_object_get_member(obj, "models");
    if (models_node && JSON_NODE_HOLDS_ARRAY(models_node)) {
        JsonArray *array = json_node_get_array(models_node);
        for (guint i = 0; i < json_array_get_length(array); i++) {
            JsonNode *node = json_array_get_element(array, i);
            if (!node || !JSON_NODE_HOLDS_OBJECT(node)) {
                continue;
            }
            JsonObject *model_obj = json_node_get_object(node);
            const gchar *id = oc_json_string_member(model_obj, "id");
            if (!id || id[0] == '\0') {
                continue;
            }
            const gchar *name = oc_json_string_member(model_obj, "name");
            const gchar *provider = oc_json_string_member(model_obj, "provider");
            ConfigModelChoice *choice = g_new0(ConfigModelChoice, 1);
            choice->id = g_strdup(id);
            choice->label = g_strdup_printf("%s (%s)", name ? name : id, provider ? provider : "provider");
            g_ptr_array_add(cfg_models_cache, choice);
        }
    }

    cfg_refresh_setup_surface();
    if (cfg_setup_status_label) {
        g_autofree gchar *message = g_strdup_printf("Loaded %u model(s) from gateway.", cfg_models_cache->len);
        gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), message);
    }
}

static void on_cfg_reload_models(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    if (cfg_models_request_in_flight) {
        return;
    }

    cfg_models_request_in_flight = TRUE;
    cfg_refresh_buttons();
    guint current_gen = cfg_generation;
    g_autofree gchar *request_id = gateway_rpc_request("models.list",
                                                       NULL,
                                                       0,
                                                       on_cfg_models_list_done,
                                                       GUINT_TO_POINTER(current_gen));
    if (!request_id) {
        cfg_models_request_in_flight = FALSE;
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Failed to request models.list.");
        }
        cfg_refresh_buttons();
        gateway_client_request_dependency_refresh();
        return;
    }

    gateway_client_invalidate_dependencies(TRUE, FALSE, FALSE);
    gateway_client_request_dependency_refresh();
}

static void on_cfg_apply_provider(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    g_autofree gchar *provider_id = g_strdup(gtk_editable_get_text(GTK_EDITABLE(cfg_provider_id_entry)));
    g_autofree gchar *base_url = g_strdup(gtk_editable_get_text(GTK_EDITABLE(cfg_provider_base_url_entry)));

    if (!provider_id || provider_id[0] == '\0') {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Provider id is required.");
        }
        return;
    }

    if (!cfg_editor_valid) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Fix config JSON before applying provider.");
        }
        return;
    }

    g_autofree gchar *text = cfg_editor_get_text();
    g_autoptr(GError) error = NULL;
    g_autofree gchar *updated = config_setup_apply_provider(text, provider_id, base_url, &error);
    if (!updated) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label),
                               error && error->message ? error->message : "Failed to apply provider config shape.");
        }
        return;
    }

    cfg_set_editor_text_programmatically(updated);
    cfg_validate_and_track(updated);
    if (cfg_setup_status_label) {
        gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Provider block updated. Saving…");
    }
    cfg_request_save_text(updated);
}

static void on_cfg_apply_default_model(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    guint idx = cfg_model_dropdown ? gtk_drop_down_get_selected(GTK_DROP_DOWN(cfg_model_dropdown)) : GTK_INVALID_LIST_POSITION;
    if (!cfg_models_cache || idx == GTK_INVALID_LIST_POSITION || idx >= cfg_models_cache->len) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Select a model from the loaded catalog.");
        }
        return;
    }

    ConfigModelChoice *choice = g_ptr_array_index(cfg_models_cache, idx);
    if (!choice || !choice->id) {
        return;
    }

    if (!cfg_editor_valid) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Fix config JSON before applying default model.");
        }
        return;
    }

    g_autofree gchar *provider_id = g_strdup(gtk_editable_get_text(GTK_EDITABLE(cfg_provider_id_entry)));
    g_autofree gchar *text = cfg_editor_get_text();
    g_autoptr(GError) error = NULL;
    g_autofree gchar *updated = config_setup_apply_default_model(text,
                                                                 provider_id,
                                                                 choice->id,
                                                                 &error);
    if (!updated) {
        if (cfg_setup_status_label) {
            gtk_label_set_text(GTK_LABEL(cfg_setup_status_label),
                               error && error->message ? error->message : "Failed to apply default model config shape.");
        }
        return;
    }

    cfg_set_editor_text_programmatically(updated);
    cfg_validate_and_track(updated);
    if (cfg_setup_status_label) {
        gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Default model updated. Saving…");
    }
    cfg_request_save_text(updated);
}

static void on_cfg_buffer_changed(GtkTextBuffer *buffer, gpointer user_data) {
    (void)buffer;
    (void)user_data;

    if (cfg_programmatic_change) {
        return;
    }

    g_autofree gchar *text = cfg_editor_get_text();
    cfg_validate_and_track(text);
    cfg_refresh_setup_surface();
}

static void on_cfg_get_done(const GatewayRpcResponse *response, gpointer user_data) {
    guint generation = GPOINTER_TO_UINT(user_data);
    if (generation != cfg_generation) {
        return;
    }

    cfg_request_in_flight = FALSE;

    if (!response || !response->ok) {
        if (cfg_validation_label) {
            g_autofree gchar *message = g_strdup_printf("Load failed: %s",
                                                        response && response->error_msg ? response->error_msg : "unknown error");
            cfg_set_validation_message(message, FALSE);
        }
        cfg_refresh_buttons();
        return;
    }

    GatewayConfigSnapshot *snapshot = gateway_data_parse_config_get(response->payload);
    if (!snapshot || !snapshot->config) {
        if (cfg_validation_label) {
            cfg_set_validation_message("Load failed: invalid config response", FALSE);
        }
        gateway_config_snapshot_free(snapshot);
        cfg_refresh_buttons();
        return;
    }

    JsonNode *node = json_node_new(JSON_NODE_OBJECT);
    json_node_set_object(node, snapshot->config);
    g_autofree gchar *pretty = json_to_string(node, TRUE);
    json_node_unref(node);

    g_free(cfg_baseline_text);
    cfg_baseline_text = g_strdup(pretty ? pretty : "{}");
    g_free(cfg_baseline_hash);
    cfg_baseline_hash = g_strdup(snapshot->hash);

    if (cfg_json_view) {
        GtkTextBuffer *buffer = gtk_text_view_get_buffer(GTK_TEXT_VIEW(cfg_json_view));
        cfg_programmatic_change = TRUE;
        gtk_text_buffer_set_text(buffer, cfg_baseline_text, -1);
        cfg_programmatic_change = FALSE;
    }

    cfg_editor_dirty = FALSE;
    cfg_validate_and_track(cfg_baseline_text);
    cfg_refresh_setup_surface();
    cfg_refresh_buttons();
    gateway_config_snapshot_free(snapshot);
}

static void cfg_request_reload(void) {
    if (cfg_request_in_flight) {
        return;
    }

    cfg_request_in_flight = TRUE;
    cfg_refresh_buttons();
    guint current_gen = cfg_generation;
    g_autofree gchar *request_id = mutation_config_get(NULL, on_cfg_get_done, GUINT_TO_POINTER(current_gen));
    if (!request_id) {
        cfg_request_in_flight = FALSE;
        if (cfg_validation_label) {
            cfg_set_validation_message("Failed to request config.get", FALSE);
        }
        cfg_refresh_buttons();
    }
}

static void on_cfg_reload(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;
    cfg_request_reload();
}

static void on_cfg_save_done(const GatewayRpcResponse *response, gpointer user_data) {
    guint generation = GPOINTER_TO_UINT(user_data);
    if (generation != cfg_generation) {
        return;
    }

    cfg_request_in_flight = FALSE;
    if (!response || !response->ok) {
        if (cfg_validation_label) {
            g_autofree gchar *message = g_strdup_printf("Save failed: %s",
                                                        response && response->error_msg ? response->error_msg : "unknown error");
            cfg_set_validation_message(message, FALSE);
        }
        cfg_refresh_buttons();
        return;
    }

    if (cfg_validation_label) {
        cfg_set_validation_message("Save successful. Reloading baseline…", TRUE);
    }
    if (cfg_setup_status_label) {
        gtk_label_set_text(GTK_LABEL(cfg_setup_status_label), "Saved provider/model config. Reloading baseline…");
    }
    gateway_client_invalidate_dependencies(TRUE, TRUE, TRUE);
    gateway_client_refresh();
    gateway_client_request_dependency_refresh();
    cfg_request_reload();
}

static void on_cfg_save(GtkButton *button, gpointer user_data) {
    (void)button;
    (void)user_data;

    if (cfg_request_in_flight) {
        return;
    }

    g_autofree gchar *text = cfg_editor_get_text();
    cfg_request_save_text(text);
}

static GtkWidget* config_build(void) {
    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 16);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *title = gtk_label_new("Config");
    gtk_widget_add_css_class(title, "title-3");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new("Operator-oriented gateway configuration with structured setup controls and raw JSON editing.");
    gtk_widget_add_css_class(subtitle, "dim-label");
    gtk_label_set_wrap(GTK_LABEL(subtitle), TRUE);
    gtk_label_set_xalign(GTK_LABEL(subtitle), 0.0);
    gtk_box_append(GTK_BOX(page), subtitle);

    GtkWidget *status_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(status_group), "Status");
    gtk_box_append(GTK_BOX(page), status_group);

    GtkWidget *status_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    gtk_widget_set_margin_start(status_box, 12);
    gtk_widget_set_margin_end(status_box, 12);
    gtk_widget_set_margin_top(status_box, 6);
    gtk_widget_set_margin_bottom(status_box, 6);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(status_group), status_box);

    cfg_status_label = gtk_label_new("—");
    gtk_widget_add_css_class(cfg_status_label, "title-3");
    gtk_label_set_xalign(GTK_LABEL(cfg_status_label), 0.0);
    gtk_box_append(GTK_BOX(status_box), cfg_status_label);

    cfg_issues_label = gtk_label_new("");
    gtk_widget_add_css_class(cfg_issues_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(cfg_issues_label), 0.0);
    gtk_widget_set_visible(cfg_issues_label, FALSE);
    gtk_box_append(GTK_BOX(status_box), cfg_issues_label);

    cfg_warning_label = gtk_label_new("");
    gtk_label_set_wrap(GTK_LABEL(cfg_warning_label), TRUE);
    gtk_label_set_xalign(GTK_LABEL(cfg_warning_label), 0.0);
    gtk_widget_set_visible(cfg_warning_label, FALSE);
    gtk_box_append(GTK_BOX(status_box), cfg_warning_label);

    GtkWidget *file_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(file_group), "File");
    gtk_box_append(GTK_BOX(page), file_group);

    GtkWidget *file_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    gtk_widget_set_margin_start(file_box, 12);
    gtk_widget_set_margin_end(file_box, 12);
    gtk_widget_set_margin_top(file_box, 6);
    gtk_widget_set_margin_bottom(file_box, 6);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(file_group), file_box);

    cfg_path_label = gtk_label_new("—");
    gtk_label_set_selectable(GTK_LABEL(cfg_path_label), TRUE);
    gtk_label_set_xalign(GTK_LABEL(cfg_path_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(cfg_path_label), TRUE);
    gtk_widget_add_css_class(cfg_path_label, "monospace");
    gtk_box_append(GTK_BOX(file_box), cfg_path_label);

    cfg_modified_label = gtk_label_new("Last modified: —");
    gtk_widget_add_css_class(cfg_modified_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(cfg_modified_label), 0.0);
    gtk_box_append(GTK_BOX(file_box), cfg_modified_label);

    GtkWidget *file_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);

    GtkWidget *open_file_btn = gtk_button_new_with_label("Open Config File");
    g_signal_connect(open_file_btn, "clicked", G_CALLBACK(on_cfg_open_file), NULL);
    gtk_box_append(GTK_BOX(file_row), open_file_btn);

    GtkWidget *open_folder_btn = gtk_button_new_with_label("Reveal Folder");
    g_signal_connect(open_folder_btn, "clicked", G_CALLBACK(on_cfg_open_folder), NULL);
    gtk_box_append(GTK_BOX(file_row), open_folder_btn);

    gtk_box_append(GTK_BOX(file_box), file_row);

    GtkWidget *setup_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(setup_group), "Provider & Model");
    gtk_box_append(GTK_BOX(page), setup_group);

    GtkWidget *setup_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    gtk_widget_set_margin_start(setup_box, 12);
    gtk_widget_set_margin_end(setup_box, 12);
    gtk_widget_set_margin_top(setup_box, 6);
    gtk_widget_set_margin_bottom(setup_box, 6);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(setup_group), setup_box);

    GtkWidget *facts_group = adw_preferences_group_new();
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(facts_group), cfg_setup_fact_row("Provider", &cfg_setup_provider_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(facts_group), cfg_setup_fact_row("Default model", &cfg_setup_default_model_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(facts_group), cfg_setup_fact_row("Catalog / Selected", &cfg_setup_catalog_label));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(facts_group), cfg_setup_fact_row("Agents / Chat", &cfg_setup_readiness_label));
    gtk_box_append(GTK_BOX(setup_box), facts_group);

    cfg_setup_status_label = gtk_label_new("Use this section to complete provider/model setup for chat readiness.");
    gtk_widget_add_css_class(cfg_setup_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(cfg_setup_status_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(cfg_setup_status_label), TRUE);
    gtk_box_append(GTK_BOX(setup_box), cfg_setup_status_label);

    GtkWidget *provider_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    cfg_provider_id_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(cfg_provider_id_entry), "Provider id (e.g. openai, ollama)");
    gtk_widget_set_size_request(cfg_provider_id_entry, 220, -1);
    gtk_box_append(GTK_BOX(provider_row), cfg_provider_id_entry);

    cfg_provider_base_url_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(cfg_provider_base_url_entry), "Provider baseUrl (optional)");
    gtk_widget_set_hexpand(cfg_provider_base_url_entry, TRUE);
    gtk_box_append(GTK_BOX(provider_row), cfg_provider_base_url_entry);

    cfg_apply_provider_btn = gtk_button_new_with_label("Configure Provider");
    g_signal_connect(cfg_apply_provider_btn, "clicked", G_CALLBACK(on_cfg_apply_provider), NULL);
    gtk_box_append(GTK_BOX(provider_row), cfg_apply_provider_btn);
    gtk_box_append(GTK_BOX(setup_box), provider_row);

    GtkWidget *model_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    cfg_reload_models_btn = gtk_button_new_with_label("Reload Models");
    g_signal_connect(cfg_reload_models_btn, "clicked", G_CALLBACK(on_cfg_reload_models), NULL);
    gtk_box_append(GTK_BOX(model_row), cfg_reload_models_btn);

    cfg_model_dropdown_model = NULL;
    cfg_model_dropdown = gtk_drop_down_new(NULL, NULL);
    gtk_widget_set_hexpand(cfg_model_dropdown, TRUE);
    gtk_box_append(GTK_BOX(model_row), cfg_model_dropdown);

    cfg_apply_model_btn = gtk_button_new_with_label("Set Default Model");
    gtk_widget_add_css_class(cfg_apply_model_btn, "suggested-action");
    g_signal_connect(cfg_apply_model_btn, "clicked", G_CALLBACK(on_cfg_apply_default_model), NULL);
    gtk_box_append(GTK_BOX(model_row), cfg_apply_model_btn);
    gtk_box_append(GTK_BOX(setup_box), model_row);

    cfg_set_model_dropdown_placeholder("Load models to pick default", FALSE);

    GtkWidget *json_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(json_group), "Raw Config (Advanced)");
    gtk_box_append(GTK_BOX(page), json_group);

    GtkWidget *json_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(json_box, 12);
    gtk_widget_set_margin_end(json_box, 12);
    gtk_widget_set_margin_top(json_box, 6);
    gtk_widget_set_margin_bottom(json_box, 6);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(json_group), json_box);

    GtkTextBuffer *json_buffer = gtk_text_buffer_new(NULL);
    cfg_json_view = gtk_text_view_new_with_buffer(json_buffer);
    gtk_text_view_set_editable(GTK_TEXT_VIEW(cfg_json_view), TRUE);
    gtk_text_view_set_cursor_visible(GTK_TEXT_VIEW(cfg_json_view), TRUE);
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(cfg_json_view), GTK_WRAP_WORD_CHAR);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(cfg_json_view), TRUE);
    gtk_widget_set_vexpand(cfg_json_view, TRUE);
    g_signal_connect(json_buffer, "changed", G_CALLBACK(on_cfg_buffer_changed), NULL);

    GtkWidget *json_scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(json_scrolled), cfg_json_view);
    gtk_widget_set_vexpand(json_scrolled, TRUE);
    gtk_scrolled_window_set_min_content_height(GTK_SCROLLED_WINDOW(json_scrolled), 200);
    GtkWidget *json_frame = gtk_frame_new(NULL);
    gtk_frame_set_child(GTK_FRAME(json_frame), json_scrolled);
    gtk_box_append(GTK_BOX(json_box), json_frame);

    cfg_validation_label = gtk_label_new("Validation: loading config…");
    gtk_label_set_xalign(GTK_LABEL(cfg_validation_label), 0.0);
    gtk_label_set_wrap(GTK_LABEL(cfg_validation_label), TRUE);
    gtk_box_append(GTK_BOX(json_box), cfg_validation_label);

    GtkWidget *copy_row = gtk_action_bar_new();

    cfg_reload_btn = gtk_button_new_with_label("Reload");
    g_signal_connect(cfg_reload_btn, "clicked", G_CALLBACK(on_cfg_reload), NULL);
    gtk_action_bar_pack_start(GTK_ACTION_BAR(copy_row), cfg_reload_btn);

    cfg_copy_btn = gtk_button_new_with_label("Copy Config JSON");
    g_signal_connect(cfg_copy_btn, "clicked", G_CALLBACK(on_cfg_copy_json), NULL);
    gtk_action_bar_pack_start(GTK_ACTION_BAR(copy_row), cfg_copy_btn);

    cfg_save_btn = gtk_button_new_with_label("Save");
    gtk_widget_add_css_class(cfg_save_btn, "suggested-action");
    g_signal_connect(cfg_save_btn, "clicked", G_CALLBACK(on_cfg_save), NULL);
    gtk_action_bar_pack_end(GTK_ACTION_BAR(copy_row), cfg_save_btn);

    gtk_box_append(GTK_BOX(json_box), copy_row);

    cfg_refresh_buttons();
    return page;
}

static void config_refresh(void) {
    if (!cfg_status_label) {
        return;
    }

    HealthState *health = state_get_health();
    GatewayConfig *cfg = gateway_client_get_config();
    const char *path = cfg ? cfg->config_path : NULL;

    ConfigDisplayModel model;
    config_display_model_build(health, path, &model);

    gtk_label_set_text(GTK_LABEL(cfg_status_label),
                       model.is_valid ? "Configuration Valid" : "Configuration Invalid");

    if (model.issues_count > 0) {
        g_autofree gchar *issues_text = g_strdup_printf("%d issue(s) detected", model.issues_count);
        gtk_label_set_text(GTK_LABEL(cfg_issues_label), issues_text);
        gtk_widget_set_visible(cfg_issues_label, TRUE);
    } else {
        gtk_widget_set_visible(cfg_issues_label, FALSE);
    }

    if (model.warning_text) {
        gtk_label_set_text(GTK_LABEL(cfg_warning_label), model.warning_text);
        gtk_widget_set_visible(cfg_warning_label, TRUE);
    } else {
        gtk_widget_set_visible(cfg_warning_label, FALSE);
    }

    g_autofree gchar *cfg_path_display = NULL;
    if (model.config_path && model.config_path[0] != '\0') {
        if (g_utf8_validate(model.config_path, -1, NULL)) {
            cfg_path_display = g_strdup(model.config_path);
        } else {
            cfg_path_display = g_filename_display_name(model.config_path);
        }
    }
    gtk_label_set_text(GTK_LABEL(cfg_path_label), cfg_path_display ? cfg_path_display : "—");

    g_autofree gchar *modified_text = cfg_get_modified_text(path);
    g_autofree gchar *modified_label = g_strdup_printf("Last modified: %s", modified_text);
    gtk_label_set_text(GTK_LABEL(cfg_modified_label), modified_label);

    if (!cfg_initial_load_requested && gateway_rpc_is_ready()) {
        cfg_initial_load_requested = TRUE;
        cfg_request_reload();
    }

    cfg_refresh_setup_surface();
    cfg_refresh_buttons();
}

static void config_destroy(void) {
    cfg_generation++;

    cfg_status_label = NULL;
    cfg_path_label = NULL;
    cfg_modified_label = NULL;
    cfg_warning_label = NULL;
    cfg_issues_label = NULL;
    cfg_json_view = NULL;
    cfg_validation_label = NULL;
    cfg_setup_provider_label = NULL;
    cfg_setup_default_model_label = NULL;
    cfg_setup_catalog_label = NULL;
    cfg_setup_readiness_label = NULL;
    cfg_setup_status_label = NULL;
    cfg_provider_id_entry = NULL;
    cfg_provider_base_url_entry = NULL;
    cfg_reload_models_btn = NULL;
    ui_dropdown_detach_model(cfg_model_dropdown, (gpointer *)&cfg_model_dropdown_model);
    cfg_model_dropdown = NULL;
    cfg_model_dropdown_model = NULL;
    cfg_apply_provider_btn = NULL;
    cfg_apply_model_btn = NULL;
    if (cfg_copy_reset_id > 0) {
        g_source_remove(cfg_copy_reset_id);
        cfg_copy_reset_id = 0;
    }
    cfg_copy_btn = NULL;
    cfg_reload_btn = NULL;
    cfg_save_btn = NULL;
    cfg_programmatic_change = FALSE;
    cfg_editor_dirty = FALSE;
    cfg_editor_valid = TRUE;
    cfg_request_in_flight = FALSE;
    cfg_initial_load_requested = FALSE;
    cfg_models_request_in_flight = FALSE;
    if (cfg_models_cache) {
        g_ptr_array_unref(cfg_models_cache);
    }
    cfg_models_cache = NULL;
    g_clear_pointer(&cfg_baseline_text, g_free);
    g_clear_pointer(&cfg_baseline_hash, g_free);
}

static void config_invalidate(void) {
    cfg_initial_load_requested = FALSE;
}

static const SectionController config_controller = {
    .build = config_build,
    .refresh = config_refresh,
    .destroy = config_destroy,
    .invalidate = config_invalidate,
};

const SectionController* section_config_get(void) {
    return &config_controller;
}
