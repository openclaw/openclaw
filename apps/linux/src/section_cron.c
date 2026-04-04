/*
 * section_cron.c
 *
 * Cron section controller for the OpenClaw Linux Companion App.
 *
 * Complete native cron management: list with detail cards, schedule
 * info, next/last run times, and Enable/Disable, Trigger Now, Delete
 * mutation actions. RPC fetch via cron.list.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_cron.h"
#include "gateway_rpc.h"
#include "gateway_data.h"
#include "gateway_mutations.h"
#include "gateway_config.h"
#include "gateway_client.h"
#include <adwaita.h>

/* ── State ───────────────────────────────────────────────────────── */

static GtkWidget *cron_list_box = NULL;
static GtkWidget *cron_status_label = NULL;
static GtkWidget *cron_scheduler_banner = NULL;
static GtkWidget *cron_runs_box = NULL;
static GatewayCronData *cron_data_cache = NULL;
static GatewayCronStatus *cron_status_cache = NULL;
static GatewayCronRunsData *cron_runs_cache = NULL;
static gboolean cron_fetch_in_flight = FALSE;
static gboolean cron_status_fetch_in_flight = FALSE;
static gboolean cron_runs_fetch_in_flight = FALSE;
static gint64 cron_last_fetch_us = 0;
/* H1: Generation counter for stale response filtering */
static guint cron_refresh_generation = 0;

/* Forward declarations */
static void cron_rebuild_list(void);
static void cron_force_refresh(void);

/* ── Dashboard handoff ───────────────────────────────────────────── */

extern GatewayConfig* gateway_client_get_config(void);

static void on_open_dashboard(GtkButton *b, gpointer d) {
    (void)b; (void)d;
    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) return;
    g_autofree gchar *url = gateway_config_dashboard_url(cfg);
    if (url) g_app_info_launch_default_for_uri(url, NULL, NULL);
}

/* ── Mutation callbacks ──────────────────────────────────────────── */

static void on_mutation_done(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    if (!cron_status_label) return;

    if (!response->ok) {
        g_autofree gchar *msg = g_strdup_printf("Error: %s",
            response->error_msg ? response->error_msg : "unknown");
        gtk_label_set_text(GTK_LABEL(cron_status_label), msg);
    }

    cron_force_refresh();
}

/* ── Action handlers ─────────────────────────────────────────────── */

static void on_toggle_enable(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *id = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-id");
    gboolean currently_enabled = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(btn), "job-enabled"));
    if (!id) return;

    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    g_autofree gchar *req = mutation_cron_enable(id, !currently_enabled, on_mutation_done, NULL);
    if (!req) {
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (cron_status_label)
            gtk_label_set_text(GTK_LABEL(cron_status_label), "Failed to send request");
    }
}

static void on_trigger(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *id = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-id");
    if (!id) return;

    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    if (cron_status_label)
        gtk_label_set_text(GTK_LABEL(cron_status_label), "Triggering\u2026");

    g_autofree gchar *req = mutation_cron_run(id, on_mutation_done, NULL);
    if (!req) {
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (cron_status_label)
            gtk_label_set_text(GTK_LABEL(cron_status_label), "Failed to send request");
    }
}

/* Delete confirmation dialog */
static void on_delete_dialog_response(GObject *source, GAsyncResult *result, gpointer user_data) {
    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(source);
    (void)user_data;

    const gchar *response_id = adw_alert_dialog_choose_finish(dialog, result);
    if (g_strcmp0(response_id, "delete") != 0) return;

    const gchar *id = g_object_get_data(G_OBJECT(dialog), "job-id");
    if (!id) return;

    if (cron_status_label)
        gtk_label_set_text(GTK_LABEL(cron_status_label), "Deleting\u2026");

    g_autofree gchar *req = mutation_cron_remove(id, on_mutation_done, NULL);
    if (!req && cron_status_label) {
        gtk_label_set_text(GTK_LABEL(cron_status_label), "Failed to send request");
    }
}

static void on_delete(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *id = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-id");
    const gchar *name = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-name");
    if (!id) return;

    g_autofree gchar *body = g_strdup_printf(
        "Delete cron job \"%s\"? This cannot be undone.", name ? name : id);

    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(
        adw_alert_dialog_new("Delete Cron Job", body));
    adw_alert_dialog_add_responses(dialog, "cancel", "Cancel", "delete", "Delete", NULL);
    adw_alert_dialog_set_response_appearance(dialog, "delete", ADW_RESPONSE_DESTRUCTIVE);
    adw_alert_dialog_set_default_response(dialog, "cancel");
    adw_alert_dialog_set_close_response(dialog, "cancel");

    g_object_set_data_full(G_OBJECT(dialog), "job-id", g_strdup(id), g_free);

    GtkWidget *toplevel = GTK_WIDGET(gtk_widget_get_root(GTK_WIDGET(btn)));
    adw_alert_dialog_choose(dialog, toplevel, NULL, on_delete_dialog_response, NULL);
}

/* G1: Helper to insert route before #token fragment */
static gchar* dashboard_url_with_route(const gchar *base_url, const gchar *route) {
    if (!base_url || !route) return NULL;
    
    /* Find fragment marker */
    const gchar *fragment = strchr(base_url, '#');
    if (fragment) {
        /* Insert route before fragment */
        gsize base_len = fragment - base_url;
        /* Ensure base ends with / */
        gboolean needs_slash = (base_len == 0 || base_url[base_len - 1] != '/');
        return g_strdup_printf("%.*s%s%s%s",
                              (int)base_len, base_url,
                              needs_slash ? "/" : "",
                              route, fragment);
    } else {
        /* No fragment, append route normally */
        gboolean needs_slash = base_url[strlen(base_url) - 1] != '/';
        return g_strdup_printf("%s%s%s",
                              base_url,
                              needs_slash ? "/" : "",
                              route);
    }
}

static void on_open_transcript(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(G_OBJECT(btn), "session-key");
    if (!key) return;

    /* Implement Resource Locality Rule:
       If we have the store path from the cron status cache, try to open the local log file first.
       If it exists and is readable, open it directly.
       Otherwise, fall back to the dashboard web route. */
    if (cron_status_cache && cron_status_cache->store_path) {
        /* In cron, transcripts are usually stored inside `sessions/` within the store directory */
        g_autofree gchar *store_dir = g_path_get_dirname(cron_status_cache->store_path);
        g_autofree gchar *sessions_dir = g_build_filename(store_dir, "sessions", NULL);
        g_autofree gchar *local_path = g_build_filename(sessions_dir, key, "transcript.jsonl", NULL);
        if (g_file_test(local_path, G_FILE_TEST_EXISTS | G_FILE_TEST_IS_REGULAR)) {
            g_autofree gchar *file_uri = g_filename_to_uri(local_path, NULL, NULL);
            if (file_uri) {
                g_app_info_launch_default_for_uri(file_uri, NULL, NULL);
                return; /* Successfully launched local file */
            }
        }
    }

    GatewayConfig *cfg = gateway_client_get_config();
    if (!cfg) return;

    g_autofree gchar *url = gateway_config_dashboard_url(cfg);
    if (!url) return;

    /* Dashboard route for session logs: chat/:sessionKey */
    g_autofree gchar *route = g_strdup_printf("chat/%s", key);
    g_autofree gchar *log_url = dashboard_url_with_route(url, route);
    if (log_url) {
        g_app_info_launch_default_for_uri(log_url, NULL, NULL);
    }
}

/* ── Helpers ─────────────────────────────────────────────────────── */

static gchar* format_relative_time_ms(gint64 ts_ms) {
    if (ts_ms <= 0) return g_strdup("\u2014");

    gint64 now_ms = g_get_real_time() / 1000;
    gint64 diff_s = (now_ms - ts_ms) / 1000;

    if (diff_s < -60) {
        /* Future time */
        gint64 ahead = -diff_s;
        if (ahead < 60) return g_strdup("in <1m");
        if (ahead < 3600) return g_strdup_printf("in %ldm", (long)(ahead / 60));
        if (ahead < 86400) return g_strdup_printf("in %ldh", (long)(ahead / 3600));
        return g_strdup_printf("in %ldd", (long)(ahead / 86400));
    }

    if (diff_s < 0) diff_s = 0;
    if (diff_s < 60) return g_strdup("just now");
    if (diff_s < 3600) return g_strdup_printf("%ldm ago", (long)(diff_s / 60));
    if (diff_s < 86400) return g_strdup_printf("%ldh ago", (long)(diff_s / 3600));
    return g_strdup_printf("%ldd ago", (long)(diff_s / 86400));
}

static void on_edit_job_dialog_response(GObject *source, GAsyncResult *result, gpointer user_data) {
    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(source);
    (void)user_data;

    const gchar *response_id = adw_alert_dialog_choose_finish(dialog, result);
    if (g_strcmp0(response_id, "save") != 0) return;

    const gchar *job_id = g_object_get_data(G_OBJECT(dialog), "job-id");
    GtkWidget *name_entry = g_object_get_data(G_OBJECT(dialog), "name-entry");
    GtkWidget *schedule_entry = g_object_get_data(G_OBJECT(dialog), "schedule-entry");
    GtkWidget *desc_entry = g_object_get_data(G_OBJECT(dialog), "desc-entry");
    GtkWidget *agent_entry = g_object_get_data(G_OBJECT(dialog), "agent-entry");
    GtkWidget *prompt_entry = g_object_get_data(G_OBJECT(dialog), "prompt-entry");
    GtkWidget *target_combo = g_object_get_data(G_OBJECT(dialog), "target-combo");
    GtkWidget *wake_combo = g_object_get_data(G_OBJECT(dialog), "wake-combo");
    
    if (!job_id || !name_entry || !schedule_entry) return;

    const gchar *name = gtk_editable_get_text(GTK_EDITABLE(name_entry));
    const gchar *schedule = gtk_editable_get_text(GTK_EDITABLE(schedule_entry));
    const gchar *desc = desc_entry ? gtk_editable_get_text(GTK_EDITABLE(desc_entry)) : NULL;
    const gchar *agent = agent_entry ? gtk_editable_get_text(GTK_EDITABLE(agent_entry)) : NULL;
    const gchar *prompt = prompt_entry ? gtk_editable_get_text(GTK_EDITABLE(prompt_entry)) : NULL;

    if (!name || *name == '\0' || !schedule || *schedule == '\0') return;

    gint target_idx = target_combo ? adw_combo_row_get_selected(ADW_COMBO_ROW(target_combo)) : 0;
    const gchar *target_str = "new";
    if (target_idx == 1) target_str = "main";
    else if (target_idx == 2) target_str = "current";
    else if (target_idx == 3) target_str = "isolated";

    gint wake_idx = wake_combo ? adw_combo_row_get_selected(ADW_COMBO_ROW(wake_combo)) : 0;
    const gchar *wake_str = wake_idx == 1 ? "now" : "next-heartbeat";

    /* Build JSON params for cron.update with full patch */
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "id");
    json_builder_add_string_value(b, job_id);
    
    json_builder_set_member_name(b, "patch");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "name");
    json_builder_add_string_value(b, name);

    if (desc && *desc != '\0') {
        json_builder_set_member_name(b, "description");
        json_builder_add_string_value(b, desc);
    }
    if (agent && *agent != '\0') {
        json_builder_set_member_name(b, "agentId");
        json_builder_add_string_value(b, agent);
    }
    
    /* schedule patch - contract requires 'kind' and 'expr' for cron type */
    json_builder_set_member_name(b, "schedule");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "kind");
    json_builder_add_string_value(b, "cron");
    json_builder_set_member_name(b, "expr");
    json_builder_add_string_value(b, schedule);
    json_builder_end_object(b);

    /* sessionTarget - contract requires string directly */
    json_builder_set_member_name(b, "sessionTarget");
    json_builder_add_string_value(b, target_str);

    /* wakeMode - contract requires string directly */
    json_builder_set_member_name(b, "wakeMode");
    json_builder_add_string_value(b, wake_str);

    /* payload - include if prompt provided */
    if (prompt && *prompt != '\0') {
        json_builder_set_member_name(b, "payload");
        json_builder_begin_object(b);
        json_builder_set_member_name(b, "kind");
        json_builder_add_string_value(b, "agentTurn");
        json_builder_set_member_name(b, "message");
        json_builder_add_string_value(b, prompt);
        json_builder_end_object(b);
    }
    
    json_builder_end_object(b); /* end patch */
    json_builder_end_object(b);

    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    if (cron_status_label)
        gtk_label_set_text(GTK_LABEL(cron_status_label), "Updating job\u2026");

    g_autofree gchar *req = mutation_cron_update(params, on_mutation_done, NULL);
    json_node_unref(params);
    
    if (!req && cron_status_label) {
        gtk_label_set_text(GTK_LABEL(cron_status_label), "Failed to send request");
    }
}

static void on_edit_job(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *job_id = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-id");
    const gchar *job_name = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-name");
    const gchar *job_schedule = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-schedule");
    const gchar *job_agent = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-agent");
    const gchar *job_target = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-target");
    const gchar *job_wake = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-wake");
    const gchar *job_prompt = (const gchar *)g_object_get_data(G_OBJECT(btn), "job-prompt");

    if (!job_id) return;

    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(adw_alert_dialog_new("Edit Cron Job", NULL));
    adw_alert_dialog_add_responses(dialog, "cancel", "Cancel", "save", "Save", NULL);
    adw_alert_dialog_set_response_appearance(dialog, "save", ADW_RESPONSE_SUGGESTED);
    adw_alert_dialog_set_default_response(dialog, "save");
    adw_alert_dialog_set_close_response(dialog, "cancel");

    GtkWidget *vbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(vbox, 12);
    gtk_widget_set_margin_end(vbox, 12);
    gtk_widget_set_margin_top(vbox, 12);
    gtk_widget_set_margin_bottom(vbox, 12);

    GtkWidget *name_entry = gtk_entry_new();
    if (job_name) gtk_editable_set_text(GTK_EDITABLE(name_entry), job_name);
    gtk_entry_set_placeholder_text(GTK_ENTRY(name_entry), "Job Name");
    gtk_box_append(GTK_BOX(vbox), name_entry);

    GtkWidget *desc_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(desc_entry), "Description (optional)");
    gtk_box_append(GTK_BOX(vbox), desc_entry);

    GtkWidget *schedule_entry = gtk_entry_new();
    if (job_schedule) gtk_editable_set_text(GTK_EDITABLE(schedule_entry), job_schedule);
    gtk_entry_set_placeholder_text(GTK_ENTRY(schedule_entry), "Cron Expression");
    gtk_box_append(GTK_BOX(vbox), schedule_entry);

    GtkWidget *agent_entry = gtk_entry_new();
    if (job_agent) gtk_editable_set_text(GTK_EDITABLE(agent_entry), job_agent);
    gtk_entry_set_placeholder_text(GTK_ENTRY(agent_entry), "Agent ID (optional)");
    gtk_box_append(GTK_BOX(vbox), agent_entry);

    GtkWidget *prompt_entry = gtk_entry_new();
    if (job_prompt) gtk_editable_set_text(GTK_EDITABLE(prompt_entry), job_prompt);
    gtk_entry_set_placeholder_text(GTK_ENTRY(prompt_entry), "Prompt to run (optional)");
    gtk_box_append(GTK_BOX(vbox), prompt_entry);

    /* Target session combo - map current value to index */
    GtkStringList *target_model = gtk_string_list_new((const char * const[]){
        "New Session", "Main Session", "Current Session", "Isolated Session", NULL
    });
    GtkWidget *target_combo = adw_combo_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(target_combo), "Target Session");
    adw_combo_row_set_model(ADW_COMBO_ROW(target_combo), G_LIST_MODEL(target_model));
    /* Select based on current value */
    gint target_idx = 0; /* default "new" */
    if (job_target) {
        if (g_strcmp0(job_target, "main") == 0) target_idx = 1;
        else if (g_strcmp0(job_target, "current") == 0) target_idx = 2;
        else if (g_strcmp0(job_target, "isolated") == 0) target_idx = 3;
    }
    adw_combo_row_set_selected(ADW_COMBO_ROW(target_combo), target_idx);
    gtk_box_append(GTK_BOX(vbox), target_combo);

    /* Wake mode combo - map current value to index */
    GtkStringList *wake_model = gtk_string_list_new((const char * const[]){
        "Next Heartbeat", "Now", NULL
    });
    GtkWidget *wake_combo = adw_combo_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(wake_combo), "Wake Mode");
    adw_combo_row_set_model(ADW_COMBO_ROW(wake_combo), G_LIST_MODEL(wake_model));
    /* Select based on current value */
    gint wake_idx = 0; /* default "next-heartbeat" */
    if (job_wake && g_strcmp0(job_wake, "now") == 0) wake_idx = 1;
    adw_combo_row_set_selected(ADW_COMBO_ROW(wake_combo), wake_idx);
    gtk_box_append(GTK_BOX(vbox), wake_combo);

    adw_alert_dialog_set_extra_child(dialog, vbox);

    g_object_set_data_full(G_OBJECT(dialog), "job-id", g_strdup(job_id), g_free);
    g_object_set_data(G_OBJECT(dialog), "name-entry", name_entry);
    g_object_set_data(G_OBJECT(dialog), "desc-entry", desc_entry);
    g_object_set_data(G_OBJECT(dialog), "schedule-entry", schedule_entry);
    g_object_set_data(G_OBJECT(dialog), "agent-entry", agent_entry);
    g_object_set_data(G_OBJECT(dialog), "prompt-entry", prompt_entry);
    g_object_set_data(G_OBJECT(dialog), "target-combo", target_combo);
    g_object_set_data(G_OBJECT(dialog), "wake-combo", wake_combo);

    GtkWidget *toplevel = GTK_WIDGET(gtk_widget_get_root(GTK_WIDGET(btn)));
    adw_alert_dialog_choose(dialog, toplevel, NULL, on_edit_job_dialog_response, NULL);
}

static void on_create_job_dialog_response(GObject *source, GAsyncResult *result, gpointer user_data) {
    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(source);
    (void)user_data;

    const gchar *response_id = adw_alert_dialog_choose_finish(dialog, result);
    if (g_strcmp0(response_id, "save") != 0) return;

    GtkWidget *name_entry = g_object_get_data(G_OBJECT(dialog), "name-entry");
    GtkWidget *schedule_entry = g_object_get_data(G_OBJECT(dialog), "schedule-entry");
    GtkWidget *prompt_entry = g_object_get_data(G_OBJECT(dialog), "prompt-entry");
    GtkWidget *desc_entry = g_object_get_data(G_OBJECT(dialog), "desc-entry");
    GtkWidget *agent_entry = g_object_get_data(G_OBJECT(dialog), "agent-entry");
    GtkWidget *target_combo = g_object_get_data(G_OBJECT(dialog), "target-combo");
    GtkWidget *wake_combo = g_object_get_data(G_OBJECT(dialog), "wake-combo");
    
    if (!name_entry || !schedule_entry || !prompt_entry) return;

    const gchar *name = gtk_editable_get_text(GTK_EDITABLE(name_entry));
    const gchar *schedule = gtk_editable_get_text(GTK_EDITABLE(schedule_entry));
    const gchar *prompt = gtk_editable_get_text(GTK_EDITABLE(prompt_entry));
    const gchar *desc = desc_entry ? gtk_editable_get_text(GTK_EDITABLE(desc_entry)) : NULL;
    const gchar *agent = agent_entry ? gtk_editable_get_text(GTK_EDITABLE(agent_entry)) : NULL;

    if (!name || *name == '\0' || !schedule || *schedule == '\0' || !prompt || *prompt == '\0') return;

    gint target_idx = target_combo ? adw_combo_row_get_selected(ADW_COMBO_ROW(target_combo)) : 0;
    const gchar *target_str = "new";
    if (target_idx == 1) target_str = "main";
    else if (target_idx == 2) target_str = "current";
    else if (target_idx == 3) target_str = "isolated";

    gint wake_idx = wake_combo ? adw_combo_row_get_selected(ADW_COMBO_ROW(wake_combo)) : 0;
    const gchar *wake_str = wake_idx == 1 ? "now" : "next-heartbeat";

    /* Build JSON params for cron.add */
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    
    json_builder_set_member_name(b, "name");
    json_builder_add_string_value(b, name);

    if (desc && *desc != '\0') {
        json_builder_set_member_name(b, "description");
        json_builder_add_string_value(b, desc);
    }
    if (agent && *agent != '\0') {
        json_builder_set_member_name(b, "agentId");
        json_builder_add_string_value(b, agent);
    }
    
    json_builder_set_member_name(b, "enabled");
    json_builder_add_boolean_value(b, TRUE);
    
    /* schedule - contract requires 'kind' and 'expr' for cron type */
    json_builder_set_member_name(b, "schedule");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "kind");
    json_builder_add_string_value(b, "cron");
    json_builder_set_member_name(b, "expr");
    json_builder_add_string_value(b, schedule);
    json_builder_end_object(b);

    /* sessionTarget - contract requires string directly, not nested object */
    json_builder_set_member_name(b, "sessionTarget");
    json_builder_add_string_value(b, target_str);

    /* wakeMode - contract requires string directly */
    json_builder_set_member_name(b, "wakeMode");
    json_builder_add_string_value(b, wake_str);

    /* payload - contract requires 'kind' not 'type' */
    json_builder_set_member_name(b, "payload");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "kind");
    json_builder_add_string_value(b, "agentTurn");
    json_builder_set_member_name(b, "message");
    json_builder_add_string_value(b, prompt);
    json_builder_end_object(b);

    json_builder_end_object(b);

    JsonNode *params = json_builder_get_root(b);
    g_object_unref(b);

    if (cron_status_label)
        gtk_label_set_text(GTK_LABEL(cron_status_label), "Creating job\u2026");

    g_autofree gchar *req = mutation_cron_add(params, on_mutation_done, NULL);
    json_node_unref(params);
    
    if (!req && cron_status_label) {
        gtk_label_set_text(GTK_LABEL(cron_status_label), "Failed to send request");
    }
}

static void on_create_job(GtkButton *btn, gpointer user_data) {
    (void)user_data;

    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(adw_alert_dialog_new("Create Cron Job", NULL));
    adw_alert_dialog_add_responses(dialog, "cancel", "Cancel", "save", "Create", NULL);
    adw_alert_dialog_set_response_appearance(dialog, "save", ADW_RESPONSE_SUGGESTED);
    adw_alert_dialog_set_default_response(dialog, "save");
    adw_alert_dialog_set_close_response(dialog, "cancel");

    GtkWidget *vbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(vbox, 12);
    gtk_widget_set_margin_end(vbox, 12);
    gtk_widget_set_margin_top(vbox, 12);
    gtk_widget_set_margin_bottom(vbox, 12);

    GtkWidget *name_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(name_entry), "Job Name (e.g. Daily Summary)");
    gtk_box_append(GTK_BOX(vbox), name_entry);

    GtkWidget *desc_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(desc_entry), "Description (optional)");
    gtk_box_append(GTK_BOX(vbox), desc_entry);

    GtkWidget *schedule_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(schedule_entry), "Cron Expression (e.g. 0 9 * * *)");
    gtk_box_append(GTK_BOX(vbox), schedule_entry);

    GtkWidget *prompt_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(prompt_entry), "Prompt to run");
    gtk_box_append(GTK_BOX(vbox), prompt_entry);

    GtkWidget *agent_entry = gtk_entry_new();
    gtk_entry_set_placeholder_text(GTK_ENTRY(agent_entry), "Agent ID (optional)");
    gtk_box_append(GTK_BOX(vbox), agent_entry);

    GtkStringList *target_model = gtk_string_list_new((const char * const[]){
        "New Session", "Main Session", "Current Session", "Isolated Session", NULL
    });
    GtkWidget *target_combo = adw_combo_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(target_combo), "Target Session");
    adw_combo_row_set_model(ADW_COMBO_ROW(target_combo), G_LIST_MODEL(target_model));
    gtk_box_append(GTK_BOX(vbox), target_combo);

    GtkStringList *wake_model = gtk_string_list_new((const char * const[]){
        "Next Heartbeat", "Now", NULL
    });
    GtkWidget *wake_combo = adw_combo_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(wake_combo), "Wake Mode");
    adw_combo_row_set_model(ADW_COMBO_ROW(wake_combo), G_LIST_MODEL(wake_model));
    gtk_box_append(GTK_BOX(vbox), wake_combo);

    adw_alert_dialog_set_extra_child(dialog, vbox);

    g_object_set_data(G_OBJECT(dialog), "name-entry", name_entry);
    g_object_set_data(G_OBJECT(dialog), "desc-entry", desc_entry);
    g_object_set_data(G_OBJECT(dialog), "schedule-entry", schedule_entry);
    g_object_set_data(G_OBJECT(dialog), "prompt-entry", prompt_entry);
    g_object_set_data(G_OBJECT(dialog), "agent-entry", agent_entry);
    g_object_set_data(G_OBJECT(dialog), "target-combo", target_combo);
    g_object_set_data(G_OBJECT(dialog), "wake-combo", wake_combo);

    GtkWidget *toplevel = GTK_WIDGET(gtk_widget_get_root(GTK_WIDGET(btn)));
    adw_alert_dialog_choose(dialog, toplevel, NULL, on_create_job_dialog_response, NULL);
}

/* ── Cron job card builder ───────────────────────────────────────── */

static void build_cron_card(GatewayCronJob *job) {
    GtkWidget *frame = gtk_frame_new(NULL);
    gtk_widget_set_margin_top(frame, 6);
    gtk_widget_set_margin_bottom(frame, 2);

    GtkWidget *card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_start(card, 12);
    gtk_widget_set_margin_end(card, 12);
    gtk_widget_set_margin_top(card, 10);
    gtk_widget_set_margin_bottom(card, 10);

    /* ── Header: dot + name + schedule type + last run status ── */
    GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);

    GtkWidget *dot = gtk_label_new(job->enabled ? "\u25CF" : "\u25CB");
    gtk_widget_add_css_class(dot, job->enabled ? "success" : "dim-label");
    gtk_box_append(GTK_BOX(hdr), dot);

    GtkWidget *name_lbl = gtk_label_new(job->name ? job->name : job->id);
    gtk_widget_add_css_class(name_lbl, "heading");
    gtk_label_set_xalign(GTK_LABEL(name_lbl), 0.0);
    gtk_label_set_ellipsize(GTK_LABEL(name_lbl), PANGO_ELLIPSIZE_END);
    gtk_widget_set_hexpand(name_lbl, TRUE);
    gtk_box_append(GTK_BOX(hdr), name_lbl);

    if (job->schedule_type) {
        GtkWidget *sched = gtk_label_new(job->schedule_type);
        gtk_widget_add_css_class(sched, "dim-label");
        gtk_box_append(GTK_BOX(hdr), sched);
    }

    if (job->last_run_status) {
        GtkWidget *status_badge = gtk_label_new(job->last_run_status);
        const gchar *cls = "dim-label";
        if (g_strcmp0(job->last_run_status, "ok") == 0) cls = "success";
        else if (g_strcmp0(job->last_run_status, "error") == 0) cls = "error";
        gtk_widget_add_css_class(status_badge, cls);
        gtk_box_append(GTK_BOX(hdr), status_badge);
    }

    gtk_box_append(GTK_BOX(card), hdr);

    /* ── Description ── */
    if (job->description) {
        GtkWidget *desc = gtk_label_new(job->description);
        gtk_widget_add_css_class(desc, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(desc), 0.0);
        gtk_label_set_wrap(GTK_LABEL(desc), TRUE);
        gtk_label_set_max_width_chars(GTK_LABEL(desc), 80);
        gtk_box_append(GTK_BOX(card), desc);
    }

    /* ── Schedule + timing info ── */
    GtkWidget *info_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 16);
    gtk_widget_set_margin_top(info_box, 2);

    if (job->schedule_value) {
        g_autofree gchar *sched_text = g_strdup_printf("Schedule: %s", job->schedule_value);
        GtkWidget *sv = gtk_label_new(sched_text);
        gtk_widget_add_css_class(sv, "dim-label");
        gtk_widget_add_css_class(sv, "monospace");
        gtk_box_append(GTK_BOX(info_box), sv);
    }

    if (job->next_run_at_ms > 0) {
        g_autofree gchar *next = format_relative_time_ms(job->next_run_at_ms);
        g_autofree gchar *next_text = g_strdup_printf("Next: %s", next);
        GtkWidget *nl = gtk_label_new(next_text);
        gtk_widget_add_css_class(nl, "dim-label");
        gtk_box_append(GTK_BOX(info_box), nl);
    }

    if (job->last_run_at_ms > 0) {
        g_autofree gchar *last = format_relative_time_ms(job->last_run_at_ms);
        g_autofree gchar *last_text = g_strdup_printf("Last: %s", last);
        GtkWidget *ll = gtk_label_new(last_text);
        gtk_widget_add_css_class(ll, "dim-label");
        gtk_box_append(GTK_BOX(info_box), ll);
    }

    if (job->last_duration_ms > 0) {
        g_autofree gchar *dur_text = g_strdup_printf("(%ldms)", (long)job->last_duration_ms);
        GtkWidget *dl = gtk_label_new(dur_text);
        gtk_widget_add_css_class(dl, "dim-label");
        gtk_box_append(GTK_BOX(info_box), dl);
    }

    gtk_box_append(GTK_BOX(card), info_box);

    /* ── Last error ── */
    if (job->last_error) {
        GtkWidget *err = gtk_label_new(job->last_error);
        gtk_widget_add_css_class(err, "error");
        gtk_label_set_xalign(GTK_LABEL(err), 0.0);
        gtk_label_set_wrap(GTK_LABEL(err), TRUE);
        gtk_label_set_max_width_chars(GTK_LABEL(err), 80);
        gtk_box_append(GTK_BOX(card), err);
    }

    /* ── Action buttons ── */
    GtkWidget *actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    gtk_widget_set_margin_top(actions, 6);

    /* Enable / Disable toggle */
    const gchar *toggle_label = job->enabled ? "Disable" : "Enable";
    GtkWidget *btn_toggle = gtk_button_new_with_label(toggle_label);
    gtk_widget_add_css_class(btn_toggle, "flat");
    if (!job->enabled) gtk_widget_add_css_class(btn_toggle, "suggested-action");
    g_object_set_data_full(G_OBJECT(btn_toggle), "job-id", g_strdup(job->id), g_free);
    g_object_set_data(G_OBJECT(btn_toggle), "job-enabled", GINT_TO_POINTER(job->enabled));
    g_signal_connect(btn_toggle, "clicked", G_CALLBACK(on_toggle_enable), NULL);
    gtk_box_append(GTK_BOX(actions), btn_toggle);

    /* Trigger Now */
    GtkWidget *btn_trigger = gtk_button_new_with_label("Trigger Now");
    gtk_widget_add_css_class(btn_trigger, "flat");
    g_object_set_data_full(G_OBJECT(btn_trigger), "job-id", g_strdup(job->id), g_free);
    g_signal_connect(btn_trigger, "clicked", G_CALLBACK(on_trigger), NULL);
    gtk_box_append(GTK_BOX(actions), btn_trigger);

    /* Edit */
    GtkWidget *btn_edit = gtk_button_new_with_label("Edit");
    gtk_widget_add_css_class(btn_edit, "flat");
    g_object_set_data_full(G_OBJECT(btn_edit), "job-id", g_strdup(job->id), g_free);
    g_object_set_data_full(G_OBJECT(btn_edit), "job-name", g_strdup(job->name ? job->name : job->id), g_free);
    g_object_set_data_full(G_OBJECT(btn_edit), "job-schedule", g_strdup(job->schedule_value ? job->schedule_value : ""), g_free);
    g_object_set_data_full(G_OBJECT(btn_edit), "job-agent", g_strdup(job->agent_id ? job->agent_id : ""), g_free);
    g_object_set_data_full(G_OBJECT(btn_edit), "job-target", g_strdup(job->session_target ? job->session_target : "new"), g_free);
    g_object_set_data_full(G_OBJECT(btn_edit), "job-wake", g_strdup(job->wake_mode ? job->wake_mode : "next-heartbeat"), g_free);
    g_object_set_data_full(G_OBJECT(btn_edit), "job-prompt", g_strdup(job->payload_message ? job->payload_message : ""), g_free);
    g_signal_connect(btn_edit, "clicked", G_CALLBACK(on_edit_job), NULL);
    gtk_box_append(GTK_BOX(actions), btn_edit);

    /* Open Transcript */
    if (job->transcript_session_key) {
        GtkWidget *btn_log = gtk_button_new_with_label("Log");
        gtk_widget_add_css_class(btn_log, "flat");
        g_object_set_data_full(G_OBJECT(btn_log), "session-key", g_strdup(job->transcript_session_key), g_free);
        g_signal_connect(btn_log, "clicked", G_CALLBACK(on_open_transcript), NULL);
        gtk_box_append(GTK_BOX(actions), btn_log);
    }

    /* Delete */
    GtkWidget *btn_del = gtk_button_new_with_label("Delete");
    gtk_widget_add_css_class(btn_del, "flat");
    gtk_widget_add_css_class(btn_del, "destructive-action");
    g_object_set_data_full(G_OBJECT(btn_del), "job-id", g_strdup(job->id), g_free);
    g_object_set_data_full(G_OBJECT(btn_del), "job-name",
        g_strdup(job->name ? job->name : job->id), g_free);
    g_signal_connect(btn_del, "clicked", G_CALLBACK(on_delete), NULL);
    gtk_box_append(GTK_BOX(actions), btn_del);

    gtk_box_append(GTK_BOX(card), actions);

    gtk_frame_set_child(GTK_FRAME(frame), card);
    gtk_box_append(GTK_BOX(cron_list_box), frame);
}

static void cron_rebuild_status_banner(void) {
    if (!cron_scheduler_banner) return;
    section_box_clear(cron_scheduler_banner);

    if (!cron_status_cache) return;

    GtkWidget *card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_add_css_class(card, "card");
    gtk_widget_set_margin_bottom(card, 16);
    gtk_widget_set_margin_start(card, 12);
    gtk_widget_set_margin_end(card, 12);

    /* Header */
    GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    GtkWidget *dot = gtk_label_new(cron_status_cache->enabled ? "\u25CF" : "\u25CB");
    gtk_widget_add_css_class(dot, cron_status_cache->enabled ? "success" : "dim-label");
    gtk_box_append(GTK_BOX(hdr), dot);

    GtkWidget *title = gtk_label_new("Scheduler Status");
    gtk_widget_add_css_class(title, "heading");
    gtk_box_append(GTK_BOX(hdr), title);
    gtk_box_append(GTK_BOX(card), hdr);

    /* Store path */
    if (cron_status_cache->store_path) {
        g_autofree gchar *path_txt = g_strdup_printf("Store: %s", cron_status_cache->store_path);
        GtkWidget *lbl = gtk_label_new(path_txt);
        gtk_widget_add_css_class(lbl, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
        gtk_box_append(GTK_BOX(card), lbl);
    }

    /* Next wake */
    if (cron_status_cache->next_wake_at_ms > 0) {
        g_autofree gchar *wake = format_relative_time_ms(cron_status_cache->next_wake_at_ms);
        g_autofree gchar *wake_txt = g_strdup_printf("Next wake: %s", wake);
        GtkWidget *lbl = gtk_label_new(wake_txt);
        gtk_widget_add_css_class(lbl, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
        gtk_box_append(GTK_BOX(card), lbl);
    }

    gtk_box_append(GTK_BOX(cron_scheduler_banner), card);
}

static void cron_rebuild_runs_list(void) {
    if (!cron_runs_box) return;
    section_box_clear(cron_runs_box);

    if (!cron_runs_cache || cron_runs_cache->n_entries == 0) {
        GtkWidget *empty = gtk_label_new("No recent runs.");
        gtk_widget_add_css_class(empty, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(empty), 0.0);
        gtk_box_append(GTK_BOX(cron_runs_box), empty);
        return;
    }

    for (gint i = 0; i < cron_runs_cache->n_entries; i++) {
        GatewayCronRunEntry *run = &cron_runs_cache->entries[i];
        
        GtkWidget *row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
        gtk_widget_set_margin_bottom(row, 4);

        /* Dot */
        const gchar *dot_text = "\u25CF";
        const gchar *dot_class = "dim-label";
        if (g_strcmp0(run->status, "ok") == 0) dot_class = "success";
        else if (g_strcmp0(run->status, "error") == 0) dot_class = "error";
        
        GtkWidget *dot = gtk_label_new(dot_text);
        gtk_widget_add_css_class(dot, dot_class);
        gtk_box_append(GTK_BOX(row), dot);

        /* Job ID / time */
        g_autofree gchar *ts = format_relative_time_ms(run->timestamp_ms);
        g_autofree gchar *title = g_strdup_printf("%s (%s)", run->job_id ? run->job_id : "?", ts);
        GtkWidget *title_lbl = gtk_label_new(title);
        gtk_box_append(GTK_BOX(row), title_lbl);

        /* Summary or Error */
        if (g_strcmp0(run->status, "error") == 0 && run->error) {
            GtkWidget *err_lbl = gtk_label_new(run->error);
            gtk_widget_add_css_class(err_lbl, "error");
            gtk_box_append(GTK_BOX(row), err_lbl);
        } else if (run->summary) {
            GtkWidget *sum_lbl = gtk_label_new(run->summary);
            gtk_widget_add_css_class(sum_lbl, "dim-label");
            gtk_box_append(GTK_BOX(row), sum_lbl);
        }

        gtk_box_append(GTK_BOX(cron_runs_box), row);
    }
}

/* ── List rebuild ────────────────────────────────────────────────── */

static void cron_rebuild_list(void) {
    if (!cron_list_box) return;

    section_box_clear(cron_list_box);

    if (!cron_data_cache || cron_data_cache->n_jobs == 0) {
        GtkWidget *empty = gtk_label_new("No cron jobs.");
        gtk_widget_add_css_class(empty, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(empty), 0.0);
        gtk_box_append(GTK_BOX(cron_list_box), empty);
        return;
    }

    for (gint i = 0; i < cron_data_cache->n_jobs; i++) {
        build_cron_card(&cron_data_cache->jobs[i]);
    }

    /* Pagination note */
    if (cron_data_cache->has_more) {
        g_autofree gchar *more_text = g_strdup_printf(
            "Showing %d of %d total jobs. Open the dashboard for full list.",
            cron_data_cache->n_jobs, cron_data_cache->total);
        GtkWidget *more = gtk_label_new(more_text);
        gtk_widget_add_css_class(more, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(more), 0.0);
        gtk_widget_set_margin_top(more, 8);
        gtk_box_append(GTK_BOX(cron_list_box), more);
    }
}

static void on_cron_status_rpc_response(const GatewayRpcResponse *response, gpointer user_data) {
    guint generation = GPOINTER_TO_UINT(user_data);
    cron_status_fetch_in_flight = FALSE;
    if (!cron_scheduler_banner) return;
    
    /* H1: Ignore stale responses from previous refresh cycles */
    if (generation != cron_refresh_generation) return;
    
    if (response->ok) {
        gateway_cron_status_free(cron_status_cache);
        cron_status_cache = gateway_data_parse_cron_status(response->payload);
        cron_rebuild_status_banner();
    }
}

static void on_cron_runs_rpc_response(const GatewayRpcResponse *response, gpointer user_data) {
    guint generation = GPOINTER_TO_UINT(user_data);
    cron_runs_fetch_in_flight = FALSE;
    if (!cron_runs_box) return;
    
    /* H1: Ignore stale responses from previous refresh cycles */
    if (generation != cron_refresh_generation) return;
    
    if (response->ok) {
        gateway_cron_runs_data_free(cron_runs_cache);
        cron_runs_cache = gateway_data_parse_cron_runs(response->payload);
        cron_rebuild_runs_list();
    }
}

/* ── RPC callback ────────────────────────────────────────────────── */

static void on_cron_rpc_response(const GatewayRpcResponse *response, gpointer user_data) {
    guint generation = GPOINTER_TO_UINT(user_data);
    cron_fetch_in_flight = FALSE;

    if (!cron_list_box) return;

    /* H1: Ignore stale responses from previous refresh cycles */
    if (generation != cron_refresh_generation) return;

    if (!response->ok) {
        if (cron_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Error: %s",
                response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(cron_status_label), msg);
        }
        return;
    }

    section_mark_fresh(&cron_last_fetch_us);
    gateway_cron_data_free(cron_data_cache);
    cron_data_cache = gateway_data_parse_cron(response->payload);

    if (cron_status_label) {
        if (cron_data_cache) {
            gint enabled = 0;
            for (gint i = 0; i < cron_data_cache->n_jobs; i++) {
                if (cron_data_cache->jobs[i].enabled) enabled++;
            }
            g_autofree gchar *msg = g_strdup_printf("%d job%s (%d enabled, %d total)",
                cron_data_cache->n_jobs,
                cron_data_cache->n_jobs == 1 ? "" : "s",
                enabled, cron_data_cache->total);
            gtk_label_set_text(GTK_LABEL(cron_status_label), msg);
        } else {
            gtk_label_set_text(GTK_LABEL(cron_status_label), "Failed to parse response");
        }
    }

    cron_rebuild_list();
}

/* ── Force refresh (after mutation) ──────────────────────────────── */

static void cron_force_refresh(void) {
    section_mark_stale(&cron_last_fetch_us);
    cron_fetch_in_flight = FALSE;
    cron_status_fetch_in_flight = FALSE;
    cron_runs_fetch_in_flight = FALSE;

    if (!cron_list_box) return;
    if (!gateway_rpc_is_ready()) return;

    /* H1: Increment generation to invalidate in-flight responses */
    cron_refresh_generation++;
    guint current_gen = cron_refresh_generation;

    cron_fetch_in_flight = TRUE;
    g_autofree gchar *req_id1 = gateway_rpc_request(
        "cron.list", NULL, 0, on_cron_rpc_response, GUINT_TO_POINTER(current_gen));
    if (!req_id1) cron_fetch_in_flight = FALSE;

    cron_status_fetch_in_flight = TRUE;
    g_autofree gchar *req_id2 = gateway_rpc_request(
        "cron.status", NULL, 0, on_cron_status_rpc_response, GUINT_TO_POINTER(current_gen));
    if (!req_id2) cron_status_fetch_in_flight = FALSE;

    cron_runs_fetch_in_flight = TRUE;
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "limit");
    json_builder_add_int_value(b, 10);
    json_builder_end_object(b);
    JsonNode *runs_params = json_builder_get_root(b);
    g_object_unref(b);
    
    g_autofree gchar *req_id3 = gateway_rpc_request(
        "cron.runs", runs_params, 0, on_cron_runs_rpc_response, GUINT_TO_POINTER(current_gen));
    if (!req_id3) cron_runs_fetch_in_flight = FALSE;
    json_node_unref(runs_params);
}

/* ── SectionController callbacks ─────────────────────────────────── */

static GtkWidget* cron_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
    gtk_box_append(GTK_BOX(page), hdr);

    GtkWidget *title = gtk_label_new("Scheduler");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_widget_set_hexpand(title, TRUE);
    gtk_box_append(GTK_BOX(hdr), title);

    GtkWidget *btn_create = gtk_button_new_with_label("Create Job");
    gtk_widget_add_css_class(btn_create, "suggested-action");
    gtk_widget_set_valign(btn_create, GTK_ALIGN_CENTER);
    g_signal_connect(btn_create, "clicked", G_CALLBACK(on_create_job), NULL);
    gtk_box_append(GTK_BOX(hdr), btn_create);

    cron_status_label = gtk_label_new("Loading\u2026");
    gtk_widget_add_css_class(cron_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(cron_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), cron_status_label);

    /* Dashboard handoff button */
    GtkWidget *btn = gtk_button_new_with_label("Open in Dashboard");
    gtk_widget_add_css_class(btn, "flat");
    gtk_widget_set_halign(btn, GTK_ALIGN_START);
    g_signal_connect(btn, "clicked", G_CALLBACK(on_open_dashboard), NULL);
    gtk_box_append(GTK_BOX(page), btn);

    GtkWidget *sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep, 4);
    gtk_widget_set_margin_bottom(sep, 4);
    gtk_box_append(GTK_BOX(page), sep);

    cron_scheduler_banner = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_box_append(GTK_BOX(page), cron_scheduler_banner);

    cron_list_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_box_append(GTK_BOX(page), cron_list_box);

    GtkWidget *runs_title = gtk_label_new("Recent Runs");
    gtk_widget_add_css_class(runs_title, "heading");
    gtk_label_set_xalign(GTK_LABEL(runs_title), 0.0);
    gtk_widget_set_margin_top(runs_title, 24);
    gtk_widget_set_margin_bottom(runs_title, 8);
    gtk_box_append(GTK_BOX(page), runs_title);

    cron_runs_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_box_append(GTK_BOX(page), cron_runs_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void cron_refresh(void) {
    if (!cron_list_box || cron_fetch_in_flight) return;
    if (!section_is_stale(&cron_last_fetch_us)) return;
    if (!gateway_rpc_is_ready()) {
        if (cron_status_label)
            gtk_label_set_text(GTK_LABEL(cron_status_label), "Gateway not connected");
        return;
    }

    /* H1: Use current generation so responses are not treated as stale */
    guint current_gen = cron_refresh_generation;

    cron_fetch_in_flight = TRUE;
    g_autofree gchar *req_id1 = gateway_rpc_request(
        "cron.list", NULL, 0, on_cron_rpc_response, GUINT_TO_POINTER(current_gen));
    if (!req_id1) {
        cron_fetch_in_flight = FALSE;
        if (cron_status_label)
            gtk_label_set_text(GTK_LABEL(cron_status_label), "Failed to send request");
    }

    cron_status_fetch_in_flight = TRUE;
    g_autofree gchar *req_id2 = gateway_rpc_request(
        "cron.status", NULL, 0, on_cron_status_rpc_response, GUINT_TO_POINTER(current_gen));
    if (!req_id2) cron_status_fetch_in_flight = FALSE;

    cron_runs_fetch_in_flight = TRUE;
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "limit");
    json_builder_add_int_value(b, 10);
    json_builder_end_object(b);
    JsonNode *runs_params = json_builder_get_root(b);
    g_object_unref(b);
    
    g_autofree gchar *req_id3 = gateway_rpc_request(
        "cron.runs", runs_params, 0, on_cron_runs_rpc_response, GUINT_TO_POINTER(current_gen));
    if (!req_id3) cron_runs_fetch_in_flight = FALSE;
    json_node_unref(runs_params);
}

static void cron_destroy(void) {
    cron_list_box = NULL;
    cron_status_label = NULL;
    cron_scheduler_banner = NULL;
    cron_runs_box = NULL;
    cron_fetch_in_flight = FALSE;
    cron_status_fetch_in_flight = FALSE;
    cron_runs_fetch_in_flight = FALSE;
    
    gateway_cron_data_free(cron_data_cache);
    cron_data_cache = NULL;
    
    gateway_cron_status_free(cron_status_cache);
    cron_status_cache = NULL;
    
    gateway_cron_runs_data_free(cron_runs_cache);
    cron_runs_cache = NULL;
    
    cron_last_fetch_us = 0;
}

static void cron_invalidate(void) {
    section_mark_stale(&cron_last_fetch_us);
}

/* ── Public ──────────────────────────────────────────────────────── */

static const SectionController cron_controller = {
    .build      = cron_build,
    .refresh    = cron_refresh,
    .destroy    = cron_destroy,
    .invalidate = cron_invalidate,
};

const SectionController* section_cron_get(void) {
    return &cron_controller;
}
