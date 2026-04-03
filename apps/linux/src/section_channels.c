/*
 * section_channels.c
 *
 * Channels section controller for the OpenClaw Linux Companion App.
 *
 * Complete native channel management: card-based display with per-
 * channel account details, Probe (force re-check) and Logout mutation
 * actions. RPC fetch via channels.status.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_channels.h"
#include "gateway_rpc.h"
#include "gateway_data.h"
#include "gateway_mutations.h"
#include <adwaita.h>

/* ── State ───────────────────────────────────────────────────────── */

static GtkWidget *channels_list_box = NULL;
static GtkWidget *channels_status_label = NULL;
static GtkWidget *channels_filter_dropdown = NULL;
static GatewayChannelsData *channels_data_cache = NULL;
static gboolean channels_fetch_in_flight = FALSE;
static gint64 channels_last_fetch_us = 0;
static gint current_filter = 0; /* 0: All, 1: Configured, 2: Available */

/* Forward declarations */
static void channels_rebuild_list(void);
static void channels_force_refresh(void);

/* ── Mutation callbacks ──────────────────────────────────────────── */

static void on_mutation_done(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    if (!channels_status_label) return;

    if (!response->ok) {
        g_autofree gchar *msg = g_strdup_printf("Error: %s",
            response->error_msg ? response->error_msg : "unknown");
        gtk_label_set_text(GTK_LABEL(channels_status_label), msg);
    }

    channels_force_refresh();
}

/* ── Action handlers ─────────────────────────────────────────────── */

static void on_probe(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    if (channels_status_label)
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Probing\u2026");

    g_autofree gchar *req = mutation_channels_status(TRUE, on_mutation_done, NULL);
    if (!req) {
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (channels_status_label)
            gtk_label_set_text(GTK_LABEL(channels_status_label), "Failed to send request");
    }
}

/* ── Channel Card Action Handlers ────────────────────────────────── */

/* Full config storage for editor session - stores the complete config object
 * and hash so we can safely rebuild the full document on save */
typedef struct {
    JsonObject *full_config_obj;  /* Owned reference to full config object */
    gchar *base_hash;           /* Config hash for OCC */
    gchar *channel_id;          /* Channel being edited */
} ConfigEditorSession;

static void config_editor_session_free(ConfigEditorSession *session) {
    if (!session) return;
    if (session->full_config_obj) json_object_unref(session->full_config_obj);
    g_free(session->base_hash);
    g_free(session->channel_id);
    g_free(session);
}

static ConfigEditorSession* config_editor_session_new(JsonObject *full_config,
                                                       const gchar *hash,
                                                       const gchar *channel_id) {
    ConfigEditorSession *session = g_new0(ConfigEditorSession, 1);
    session->full_config_obj = full_config ? json_object_ref(full_config) : NULL;
    session->base_hash = g_strdup(hash);
    session->channel_id = g_strdup(channel_id);
    return session;
}

static void on_config_save_done(const GatewayRpcResponse *response, gpointer user_data) {
    ConfigEditorSession *session = (ConfigEditorSession *)user_data;
    if (!response->ok && channels_status_label) {
        g_autofree gchar *msg = g_strdup_printf("Config Save Error: %s",
            response->error_msg ? response->error_msg : "unknown");
        gtk_label_set_text(GTK_LABEL(channels_status_label), msg);
    } else if (channels_status_label) {
        g_autofree gchar *msg = g_strdup_printf("Config saved for %s", session->channel_id);
        gtk_label_set_text(GTK_LABEL(channels_status_label), msg);
    }
    config_editor_session_free(session);
    channels_force_refresh();
}

static void on_config_dialog_response(GObject *source, GAsyncResult *result, gpointer user_data) {
    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(source);
    ConfigEditorSession *session = (ConfigEditorSession *)user_data;

    const gchar *response_id = adw_alert_dialog_choose_finish(dialog, result);
    if (g_strcmp0(response_id, "save") != 0) {
        config_editor_session_free(session);
        return;
    }

    GtkWidget *text_view = g_object_get_data(G_OBJECT(dialog), "config-text-view");
    if (!text_view || !session || !session->full_config_obj || !session->channel_id) {
        config_editor_session_free(session);
        return;
    }

    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(text_view));
    GtkTextIter start, end;
    gtk_text_buffer_get_bounds(buf, &start, &end);
    g_autofree gchar *edited_json = gtk_text_buffer_get_text(buf, &start, &end, FALSE);

    /* STRICT VALIDATION: Parse the edited JSON text BEFORE any save attempt */
    JsonParser *parser = json_parser_new();
    GError *parse_error = NULL;
    if (!json_parser_load_from_data(parser, edited_json, -1, &parse_error)) {
        if (channels_status_label) {
            g_autofree gchar *err_msg = g_strdup_printf(
                "Config validation error: %s", 
                parse_error ? parse_error->message : "Invalid JSON");
            gtk_label_set_text(GTK_LABEL(channels_status_label), err_msg);
        }
        if (parse_error) g_error_free(parse_error);
        g_object_unref(parser);
        config_editor_session_free(session);
        return;
    }
    
    /* JSON is valid - verify it's an object */
    JsonNode *parsed_root = json_parser_get_root(parser);
    if (!JSON_NODE_HOLDS_OBJECT(parsed_root)) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Config error: JSON must be an object");
        }
        g_object_unref(parser);
        config_editor_session_free(session);
        return;
    }
    
    /* Get the edited channel subtree */
    /* I1: Properly manage JsonNode ownership - copy root for later transfer */
    JsonNode *edited_channel_node = json_node_copy(parsed_root);
    g_object_unref(parser);

    if (channels_status_label)
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Saving config\u2026");

    /* Build the FULL updated config document:
     * 1. TRUE deep copy of the stored full config (via serialize+parse to ensure isolation)
     * 2. Ensure channels object exists (create if absent)
     * 3. Replace channels[channel_id] with the edited subtree
     * 4. Serialize the full updated config
     */
    
    /* TRUE deep copy: serialize stored config and re-parse to get isolated mutable tree.
     * session->full_config_obj must remain unchanged in memory during save preparation. */
    g_autofree gchar *stored_config_json = json_to_string(
        json_node_new(JSON_NODE_OBJECT), FALSE);
    {
        JsonNode *temp_node = json_node_new(JSON_NODE_OBJECT);
        json_node_set_object(temp_node, session->full_config_obj);
        g_free(stored_config_json);
        stored_config_json = json_to_string(temp_node, FALSE);
        json_node_unref(temp_node);
    }
    
    JsonParser *copy_parser = json_parser_new();
    GError *copy_error = NULL;
    if (!json_parser_load_from_data(copy_parser, stored_config_json, -1, &copy_error)) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Config save error: Failed to deep-copy stored config");
        }
        if (copy_error) g_error_free(copy_error);
        g_object_unref(copy_parser);
        config_editor_session_free(session);
        return;
    }
    
    /* json_parser_get_root returns a BORROWED node - must copy before parser is freed.
     * full_config_copy is an OWNED node safe to mutate after parser cleanup. */
    JsonNode *copy_root = json_parser_get_root(copy_parser);
    JsonNode *full_config_copy = json_node_copy(copy_root);
    g_object_unref(copy_parser);
    
    /* Navigate to or create channels object */
    JsonObject *root_obj = json_node_get_object(full_config_copy);
    JsonObject *channels_obj = NULL;
    
    if (json_object_has_member(root_obj, "channels")) {
        JsonNode *channels_node = json_object_get_member(root_obj, "channels");
        if (JSON_NODE_HOLDS_OBJECT(channels_node)) {
            channels_obj = json_node_get_object(channels_node);
        }
    }
    
    /* Create channels object if it doesn't exist or isn't an object */
    if (!channels_obj) {
        channels_obj = json_object_new();
        JsonNode *channels_node = json_node_new(JSON_NODE_OBJECT);
        json_node_set_object(channels_node, channels_obj);
        json_object_set_member(root_obj, "channels", channels_node);
    }
    
    /* Replace the specific channel with edited subtree */
    if (json_object_has_member(channels_obj, session->channel_id)) {
        json_object_remove_member(channels_obj, session->channel_id);
    }
    /* I1: Transfer ownership of edited_channel_node to the channels object */
    json_object_set_member(channels_obj, session->channel_id, edited_channel_node);

    /* Serialize the FULL updated config document */
    g_autofree gchar *full_raw_json = json_to_string(full_config_copy, FALSE);
    json_node_unref(full_config_copy);

    /* Send the full config document with base hash for OCC */
    g_autofree gchar *req = mutation_config_set(full_raw_json, session->base_hash, 
                                                on_config_save_done, session);
    if (!req && channels_status_label) {
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Failed to send save request");
        config_editor_session_free(session);
    }
    /* Note: session is now owned by the callback; if req is NULL we freed it above */
}

static void on_config_get_done(const GatewayRpcResponse *response, gpointer user_data) {
    gchar *channel_id = (gchar *)user_data;
    
    /* STRICT GUARDS: Check response state before any payload access */
    if (!response || !response->ok) {
        if (channels_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Failed to load config: %s",
                response && response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(channels_status_label), msg);
        }
        g_free(channel_id);
        return;
    }
    
    /* STRICT GUARDS: payload must exist and be an object */
    if (!response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Config load error: Invalid or missing response payload");
        }
        g_free(channel_id);
        return;
    }

    JsonObject *root_obj = json_node_get_object(response->payload);
    
    /* STRICT GUARDS: Require expected top-level members */
    if (!json_object_has_member(root_obj, "hash")) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Config load error: Response missing required 'hash' field");
        }
        g_free(channel_id);
        return;
    }
    const gchar *hash = json_object_get_string_member(root_obj, "hash");

    /* Extract the full config object - config.get returns {hash, config: {...}} */
    JsonObject *full_config_obj = NULL;
    if (json_object_has_member(root_obj, "config")) {
        JsonNode *config_node = json_object_get_member(root_obj, "config");
        if (JSON_NODE_HOLDS_OBJECT(config_node)) {
            full_config_obj = json_node_get_object(config_node);
        }
    }
    
    if (!full_config_obj) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Config load error: Response missing 'config' object");
        }
        g_free(channel_id);
        return;
    }
    
    /* Extract the specific channel node from full config for editing display */
    JsonObject *channels_obj = NULL;
    if (json_object_has_member(full_config_obj, "channels")) {
        JsonNode *channels_node = json_object_get_member(full_config_obj, "channels");
        if (JSON_NODE_HOLDS_OBJECT(channels_node)) {
            channels_obj = json_node_get_object(channels_node);
        }
    }
    
    JsonNode *channel_node = NULL;
    if (channels_obj && json_object_has_member(channels_obj, channel_id)) {
        channel_node = json_object_get_member(channels_obj, channel_id);
    }

    /* Convert channel payload to JSON string for editing */
    g_autofree gchar *config_json = NULL;
    if (channel_node && JSON_NODE_HOLDS_OBJECT(channel_node)) {
        config_json = json_to_string(channel_node, TRUE);
    } else {
        config_json = g_strdup("{}");
    }

    /* Create editor session with full config and metadata */
    ConfigEditorSession *session = config_editor_session_new(full_config_obj, hash, channel_id);

    g_autofree gchar *title = g_strdup_printf("Configure %s", channel_id);
    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(adw_alert_dialog_new(title, NULL));
    adw_alert_dialog_add_responses(dialog, "cancel", "Cancel", "save", "Save", NULL);
    adw_alert_dialog_set_response_appearance(dialog, "save", ADW_RESPONSE_SUGGESTED);
    adw_alert_dialog_set_default_response(dialog, "save");
    adw_alert_dialog_set_close_response(dialog, "cancel");

    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_widget_set_size_request(scrolled, 400, 300);
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled), GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    gtk_widget_set_margin_start(scrolled, 12);
    gtk_widget_set_margin_end(scrolled, 12);
    gtk_widget_set_margin_top(scrolled, 12);
    gtk_widget_set_margin_bottom(scrolled, 12);

    GtkWidget *text_view = gtk_text_view_new();
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(text_view), TRUE);
    gtk_text_buffer_set_text(gtk_text_view_get_buffer(GTK_TEXT_VIEW(text_view)), config_json, -1);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), text_view);

    adw_alert_dialog_set_extra_child(dialog, scrolled);

    g_object_set_data(G_OBJECT(dialog), "config-text-view", text_view);
    /* session is passed to callback; callback owns it */

    /* Use the main window as the dialog parent */
    GtkApplication *app = GTK_APPLICATION(g_application_get_default());
    GtkWidget *toplevel = GTK_WIDGET(gtk_application_get_active_window(app));
    
    adw_alert_dialog_choose(dialog, toplevel, NULL, on_config_dialog_response, session);
    g_free(channel_id);
}

static void on_edit_config(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *channel_id = (const gchar *)g_object_get_data(G_OBJECT(btn), "channel-id");
    if (!channel_id) return;

    if (channels_status_label)
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Loading config\u2026");

    /* config.get backend contract: NO scope parameter accepted.
     * Always returns full config document {hash, config: {...}}
     * We pass NULL for scope to comply with the empty params contract.
     */
    g_autofree gchar *req = mutation_config_get(NULL, on_config_get_done, g_strdup(channel_id));
    if (!req && channels_status_label) {
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Failed to request config");
    }
}

/* ── Web Login / QR Flow ─────────────────────────────────────────── */

static void on_web_login_wait_done(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    
    /* STRICT GUARDS: Check response state before any payload access */
    if (!response || !response->ok) {
        if (channels_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Login failed: %s",
                response && response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(channels_status_label), msg);
        }
        channels_force_refresh();
        return;
    }
    
    /* STRICT GUARDS: payload must exist and be an object */
    if (!response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Login error: Invalid or missing response payload");
        }
        channels_force_refresh();
        return;
    }
    
    JsonObject *payload_obj = json_node_get_object(response->payload);
    
    /* STRICT GUARDS: Require 'connected' member for success determination */
    if (!json_object_has_member(payload_obj, "connected")) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Login error: Response missing required 'connected' field");
        }
        channels_force_refresh();
        return;
    }
    
    JsonNode *conn_node = json_object_get_member(payload_obj, "connected");
    if (json_node_get_value_type(conn_node) != G_TYPE_BOOLEAN) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Login error: 'connected' field has invalid type");
        }
        channels_force_refresh();
        return;
    }
    
    gboolean connected = json_node_get_boolean(conn_node);
    
    /* STRICT SUCCESS GATE: Only report success when connected == TRUE */
    if (channels_status_label) {
        if (connected) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), "Login successful!");
        } else {
            const gchar *msg = "Login incomplete or timed out";
            if (json_object_has_member(payload_obj, "message")) {
                msg = json_object_get_string_member(payload_obj, "message");
            }
            g_autofree gchar *status_msg = g_strdup_printf("Login status: %s", msg ? msg : "unknown");
            gtk_label_set_text(GTK_LABEL(channels_status_label), status_msg);
        }
    }
    channels_force_refresh();
}

static void on_web_login_start_done(const GatewayRpcResponse *response, gpointer user_data) {
    gchar *channel_id = (gchar *)user_data;
    
    /* STRICT GUARDS: Check response state before any payload access */
    if (!response || !response->ok) {
        if (channels_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Failed to start login: %s",
                response && response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(channels_status_label), msg);
        }
        g_free(channel_id);
        return;
    }
    
    /* STRICT GUARDS: payload must exist and be an object */
    if (!response->payload || !JSON_NODE_HOLDS_OBJECT(response->payload)) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Login start error: Invalid or missing response payload");
        }
        g_free(channel_id);
        return;
    }

    JsonObject *payload_obj = json_node_get_object(response->payload);
    
    /* STRICT GUARDS: Require qrDataUrl member for QR display */
    if (!json_object_has_member(payload_obj, "qrDataUrl")) {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Login start error: Response missing required 'qrDataUrl' field");
        }
        g_free(channel_id);
        return;
    }
    
    const gchar *qr_data_url = json_object_get_string_member(payload_obj, "qrDataUrl");
    if (!qr_data_url || *qr_data_url == '\0') {
        if (channels_status_label) {
            gtk_label_set_text(GTK_LABEL(channels_status_label), 
                "Login start error: 'qrDataUrl' is empty or null");
        }
        g_free(channel_id);
        return;
    }

    /* Render QR code dialog */
    g_autofree gchar *title = g_strdup_printf("Link Device: %s", channel_id);
    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(adw_alert_dialog_new(title, "Scan this QR code with your device to link it."));
    adw_alert_dialog_add_responses(dialog, "close", "Close", NULL);
    adw_alert_dialog_set_default_response(dialog, "close");
    adw_alert_dialog_set_close_response(dialog, "close");

    /* Extract base64 image data */
    const gchar *b64_start = g_strstr_len(qr_data_url, -1, "base64,");
    if (b64_start) {
        b64_start += 7; /* skip "base64," */
        gsize out_len = 0;
        guchar *img_data = g_base64_decode(b64_start, &out_len);
        
        if (img_data) {
            g_autoptr(GInputStream) stream = g_memory_input_stream_new_from_data(img_data, out_len, g_free);
            g_autoptr(GError) error = NULL;
            g_autoptr(GdkPixbuf) pixbuf = gdk_pixbuf_new_from_stream(stream, NULL, &error);
            
            if (pixbuf) {
                /* Modern GTK4: create texture from pixbuf for gtk_picture */
                GdkTexture *texture = gdk_texture_new_for_pixbuf(pixbuf);
                GtkWidget *img = gtk_picture_new_for_paintable(GDK_PAINTABLE(texture));
                g_object_unref(texture);
                gtk_widget_set_size_request(img, 256, 256);
                gtk_widget_set_margin_start(img, 24);
                gtk_widget_set_margin_end(img, 24);
                gtk_widget_set_margin_top(img, 12);
                gtk_widget_set_margin_bottom(img, 24);
                adw_alert_dialog_set_extra_child(dialog, img);
            }
        }
    }

    GtkApplication *app = GTK_APPLICATION(g_application_get_default());
    GtkWidget *toplevel = GTK_WIDGET(gtk_application_get_active_window(app));
    adw_alert_dialog_choose(dialog, toplevel, NULL, NULL, NULL);

    if (channels_status_label)
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Waiting for login completion\u2026");

    /* Begin waiting for the actual login resolution */
    /* 120s timeout, null account_id since we are linking a primary account */
    g_autofree gchar *req = mutation_web_login_wait(120000, NULL, on_web_login_wait_done, NULL);
    if (!req && channels_status_label) {
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Failed to send wait request");
    }
    
    g_free(channel_id);
}

static void on_start_web_login(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *channel_id = (const gchar *)g_object_get_data(G_OBJECT(btn), "channel-id");
    if (!channel_id) return;

    if (channels_status_label)
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Starting login flow\u2026");

    g_autofree gchar *req = mutation_web_login_start(on_web_login_start_done, g_strdup(channel_id));
    if (!req && channels_status_label) {
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Failed to start login");
    }
}

/* ── Logout ──────────────────────────────────────────────────────── */
static void on_logout_dialog_response(GObject *source, GAsyncResult *result, gpointer user_data) {
    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(source);
    (void)user_data;

    const gchar *response_id = adw_alert_dialog_choose_finish(dialog, result);
    if (g_strcmp0(response_id, "logout") != 0) return;

    const gchar *channel_id = g_object_get_data(G_OBJECT(dialog), "channel-id");
    const gchar *account_id = g_object_get_data(G_OBJECT(dialog), "account-id");
    if (!channel_id) return;

    if (channels_status_label)
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Logging out\u2026");

    g_autofree gchar *req = mutation_channels_logout(channel_id, account_id, on_mutation_done, NULL);
    if (!req && channels_status_label) {
        gtk_label_set_text(GTK_LABEL(channels_status_label), "Failed to send request");
    }
}

static void on_logout(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *channel_id = (const gchar *)g_object_get_data(G_OBJECT(btn), "channel-id");
    const gchar *label = (const gchar *)g_object_get_data(G_OBJECT(btn), "channel-label");
    if (!channel_id) return;

    g_autofree gchar *body = g_strdup_printf(
        "Logout from %s? You will need to re-authenticate to use this channel.",
        label ? label : channel_id);

    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(
        adw_alert_dialog_new("Logout Channel", body));
    adw_alert_dialog_add_responses(dialog, "cancel", "Cancel", "logout", "Logout", NULL);
    adw_alert_dialog_set_response_appearance(dialog, "logout", ADW_RESPONSE_DESTRUCTIVE);
    adw_alert_dialog_set_default_response(dialog, "cancel");
    adw_alert_dialog_set_close_response(dialog, "cancel");

    g_object_set_data_full(G_OBJECT(dialog), "channel-id", g_strdup(channel_id), g_free);

    GtkWidget *toplevel = GTK_WIDGET(gtk_widget_get_root(GTK_WIDGET(btn)));
    adw_alert_dialog_choose(dialog, toplevel, NULL, on_logout_dialog_response, NULL);
}

static void on_filter_changed(GObject *gobject, GParamSpec *pspec, gpointer user_data) {
    (void)pspec; (void)user_data;
    current_filter = adw_combo_row_get_selected(ADW_COMBO_ROW(gobject));
    channels_rebuild_list();
}

/* ── Channel card builder ────────────────────────────────────────── */

static void build_channel_card(GatewayChannel *ch) {
    GtkWidget *frame = gtk_frame_new(NULL);
    gtk_widget_set_margin_top(frame, 6);
    gtk_widget_set_margin_bottom(frame, 2);

    GtkWidget *card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_start(card, 12);
    gtk_widget_set_margin_end(card, 12);
    gtk_widget_set_margin_top(card, 10);
    gtk_widget_set_margin_bottom(card, 10);

    /* ── Header: dot + name + account count ── */
    GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);

    GtkWidget *dot = gtk_label_new(ch->connected ? "\u25CF" : "\u25CB");
    gtk_widget_add_css_class(dot, ch->connected ? "success" : "dim-label");
    gtk_box_append(GTK_BOX(hdr), dot);

    const gchar *ch_label = ch->label ? ch->label : ch->channel_id;
    GtkWidget *name_lbl = gtk_label_new(ch_label);
    gtk_widget_add_css_class(name_lbl, "heading");
    gtk_label_set_xalign(GTK_LABEL(name_lbl), 0.0);
    gtk_widget_set_hexpand(name_lbl, TRUE);
    gtk_box_append(GTK_BOX(hdr), name_lbl);

    if (ch->account_count > 0) {
        g_autofree gchar *acct_str = g_strdup_printf("%d account%s",
            ch->account_count, ch->account_count == 1 ? "" : "s");
        GtkWidget *acct = gtk_label_new(acct_str);
        gtk_widget_add_css_class(acct, "dim-label");
        gtk_box_append(GTK_BOX(hdr), acct);
    }

    gtk_box_append(GTK_BOX(card), hdr);

    /* ── Detail label ── */
    if (ch->detail_label) {
        GtkWidget *detail = gtk_label_new(ch->detail_label);
        gtk_widget_add_css_class(detail, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(detail), 0.0);
        gtk_box_append(GTK_BOX(card), detail);
    }

    /* ── Per-account details ── */
    for (gint j = 0; j < ch->n_accounts; j++) {
        GatewayChannelAccount *acct = &ch->accounts[j];

        GtkWidget *acct_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
        gtk_widget_set_margin_top(acct_row, 2);

        /* Account status dot */
        GtkWidget *adot = gtk_label_new(acct->connected ? "\u25CF" : "\u25CB");
        gtk_widget_add_css_class(adot, acct->connected ? "success" : "dim-label");
        gtk_box_append(GTK_BOX(acct_row), adot);

        /* Display name or account ID */
        const gchar *acct_name = acct->display_name ? acct->display_name : acct->account_id;
        GtkWidget *acct_lbl = gtk_label_new(acct_name);
        gtk_label_set_xalign(GTK_LABEL(acct_lbl), 0.0);
        gtk_label_set_ellipsize(GTK_LABEL(acct_lbl), PANGO_ELLIPSIZE_END);
        gtk_widget_set_hexpand(acct_lbl, TRUE);
        gtk_box_append(GTK_BOX(acct_row), acct_lbl);

        /* Mode badge */
        if (acct->mode) {
            GtkWidget *mode = gtk_label_new(acct->mode);
            gtk_widget_add_css_class(mode, "dim-label");
            gtk_box_append(GTK_BOX(acct_row), mode);
        }

        gtk_box_append(GTK_BOX(card), acct_row);

        /* Account error */
        if (acct->last_error) {
            GtkWidget *err = gtk_label_new(acct->last_error);
            gtk_widget_add_css_class(err, "error");
            gtk_label_set_xalign(GTK_LABEL(err), 0.0);
            gtk_label_set_wrap(GTK_LABEL(err), TRUE);
            gtk_label_set_max_width_chars(GTK_LABEL(err), 80);
            gtk_widget_set_margin_start(err, 20);
            gtk_box_append(GTK_BOX(card), err);
        }
    }

    /* ── Action buttons ── */
    GtkWidget *actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    gtk_widget_set_margin_top(actions, 6);

    /* Edit Config */
    GtkWidget *btn_config = gtk_button_new_with_label("Config");
    gtk_widget_add_css_class(btn_config, "flat");
    g_object_set_data_full(G_OBJECT(btn_config), "channel-id", g_strdup(ch->channel_id), g_free);
    g_signal_connect(btn_config, "clicked", G_CALLBACK(on_edit_config), NULL);
    gtk_box_append(GTK_BOX(actions), btn_config);

    /* Web Login (WhatsApp QR) */
    if (g_strcmp0(ch->channel_id, "whatsapp") == 0 && !ch->connected) {
        GtkWidget *btn_link = gtk_button_new_with_label("Link Device");
        gtk_widget_add_css_class(btn_link, "suggested-action");
        g_object_set_data_full(G_OBJECT(btn_link), "channel-id", g_strdup(ch->channel_id), g_free);
        g_signal_connect(btn_link, "clicked", G_CALLBACK(on_start_web_login), NULL);
        gtk_box_append(GTK_BOX(actions), btn_link);
    }

    /* Logout */
    if (ch->connected) {
        GtkWidget *btn_logout = gtk_button_new_with_label("Logout");
        gtk_widget_add_css_class(btn_logout, "flat");
        gtk_widget_add_css_class(btn_logout, "destructive-action");
        g_object_set_data_full(G_OBJECT(btn_logout), "channel-id",
            g_strdup(ch->channel_id), g_free);
        g_object_set_data_full(G_OBJECT(btn_logout), "channel-label",
            g_strdup(ch_label), g_free);
        g_signal_connect(btn_logout, "clicked", G_CALLBACK(on_logout), NULL);
        gtk_box_append(GTK_BOX(actions), btn_logout);
    }

    gtk_box_append(GTK_BOX(card), actions);

    gtk_frame_set_child(GTK_FRAME(frame), card);
    gtk_box_append(GTK_BOX(channels_list_box), frame);
}

/* ── List rebuild ────────────────────────────────────────────────── */

static void channels_rebuild_list(void) {
    if (!channels_list_box) return;

    section_box_clear(channels_list_box);

    if (!channels_data_cache || channels_data_cache->n_channels == 0) {
        GtkWidget *empty = gtk_label_new("No channels available.");
        gtk_widget_add_css_class(empty, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(empty), 0.0);
        gtk_box_append(GTK_BOX(channels_list_box), empty);
        return;
    }

    for (gint i = 0; i < channels_data_cache->n_channels; i++) {
        GatewayChannel *ch = &channels_data_cache->channels[i];
        gboolean is_configured = (ch->account_count > 0 || ch->connected);
        
        gboolean match = FALSE;
        if (current_filter == 0) match = TRUE;
        else if (current_filter == 1) match = is_configured;
        else if (current_filter == 2) match = !is_configured;
        
        if (match) {
            build_channel_card(ch);
        }
    }
}

/* ── RPC callback ────────────────────────────────────────────────── */

static void on_channels_rpc_response(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    channels_fetch_in_flight = FALSE;

    if (!channels_list_box) return;

    if (!response->ok) {
        if (channels_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Error: %s",
                response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(channels_status_label), msg);
        }
        return;
    }

    section_mark_fresh(&channels_last_fetch_us);
    gateway_channels_data_free(channels_data_cache);
    channels_data_cache = gateway_data_parse_channels(response->payload);

    if (channels_status_label) {
        if (channels_data_cache) {
            gint connected = 0;
            for (gint i = 0; i < channels_data_cache->n_channels; i++) {
                if (channels_data_cache->channels[i].connected) connected++;
            }
            g_autofree gchar *msg = g_strdup_printf("%d channel%s (%d connected)",
                channels_data_cache->n_channels,
                channels_data_cache->n_channels == 1 ? "" : "s",
                connected);
            gtk_label_set_text(GTK_LABEL(channels_status_label), msg);
        } else {
            gtk_label_set_text(GTK_LABEL(channels_status_label), "Failed to parse response");
        }
    }

    channels_rebuild_list();
}

/* ── Force refresh (after mutation) ──────────────────────────────── */

static void channels_force_refresh(void) {
    section_mark_stale(&channels_last_fetch_us);
    channels_fetch_in_flight = FALSE;

    if (!channels_list_box) return;
    if (!gateway_rpc_is_ready()) return;

    channels_fetch_in_flight = TRUE;
    g_autofree gchar *req_id = gateway_rpc_request(
        "channels.status", NULL, 0, on_channels_rpc_response, NULL);
    if (!req_id) {
        channels_fetch_in_flight = FALSE;
    }
}

/* ── SectionController callbacks ─────────────────────────────────── */

static GtkWidget* channels_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 12);
    gtk_box_append(GTK_BOX(page), hdr);

    GtkWidget *title = gtk_label_new("Channels");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_widget_set_hexpand(title, TRUE);
    gtk_box_append(GTK_BOX(hdr), title);

    GtkStringList *filter_model = gtk_string_list_new((const char * const[]){
        "All", "Configured", "Available", NULL
    });
    channels_filter_dropdown = adw_combo_row_new();
    adw_combo_row_set_model(ADW_COMBO_ROW(channels_filter_dropdown), G_LIST_MODEL(filter_model));
    adw_combo_row_set_selected(ADW_COMBO_ROW(channels_filter_dropdown), current_filter);
    g_signal_connect(channels_filter_dropdown, "notify::selected", G_CALLBACK(on_filter_changed), NULL);
    gtk_widget_set_valign(channels_filter_dropdown, GTK_ALIGN_CENTER);
    gtk_box_append(GTK_BOX(hdr), channels_filter_dropdown);

    channels_status_label = gtk_label_new("Loading\u2026");
    gtk_widget_add_css_class(channels_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(channels_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), channels_status_label);

    /* Probe button — force re-check connectivity */
    GtkWidget *btn_probe = gtk_button_new_with_label("Probe All Channels");
    gtk_widget_add_css_class(btn_probe, "flat");
    gtk_widget_set_halign(btn_probe, GTK_ALIGN_START);
    g_signal_connect(btn_probe, "clicked", G_CALLBACK(on_probe), NULL);
    gtk_box_append(GTK_BOX(page), btn_probe);

    GtkWidget *sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep, 4);
    gtk_widget_set_margin_bottom(sep, 4);
    gtk_box_append(GTK_BOX(page), sep);

    channels_list_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_box_append(GTK_BOX(page), channels_list_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void channels_refresh(void) {
    if (!channels_list_box || channels_fetch_in_flight) return;
    if (!section_is_stale(&channels_last_fetch_us)) return;
    if (!gateway_rpc_is_ready()) {
        if (channels_status_label)
            gtk_label_set_text(GTK_LABEL(channels_status_label), "Gateway not connected");
        return;
    }

    channels_fetch_in_flight = TRUE;
    g_autofree gchar *req_id = gateway_rpc_request(
        "channels.status", NULL, 0, on_channels_rpc_response, NULL);
    if (!req_id) {
        channels_fetch_in_flight = FALSE;
        if (channels_status_label)
            gtk_label_set_text(GTK_LABEL(channels_status_label), "Failed to send request");
    }
}

static void channels_destroy(void) {
    channels_list_box = NULL;
    channels_status_label = NULL;
    channels_filter_dropdown = NULL;
    channels_fetch_in_flight = FALSE;
    gateway_channels_data_free(channels_data_cache);
    channels_data_cache = NULL;
    channels_last_fetch_us = 0;
}

static void channels_invalidate(void) {
    section_mark_stale(&channels_last_fetch_us);
}

/* ── Public ──────────────────────────────────────────────────────── */

static const SectionController channels_controller = {
    .build      = channels_build,
    .refresh    = channels_refresh,
    .destroy    = channels_destroy,
    .invalidate = channels_invalidate,
};

const SectionController* section_channels_get(void) {
    return &channels_controller;
}
