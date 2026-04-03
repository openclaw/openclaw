/*
 * section_skills.c
 *
 * Skills section controller for the OpenClaw Linux Companion App.
 *
 * Complete native skill management: list, enable/disable, install,
 * update, set environment variables, and display requirements/config
 * checks. RPC fetch via skills.status, mutations via skills.enable,
 * skills.install, skills.update, skills.setEnv.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "section_skills.h"
#include "gateway_rpc.h"
#include "gateway_data.h"
#include "gateway_mutations.h"
#include <adwaita.h>

/* ── State ───────────────────────────────────────────────────────── */

static GtkWidget *skills_list_box = NULL;
static GtkWidget *skills_status_label = NULL;
static GtkWidget *skills_filter_dropdown = NULL;
static GatewaySkillsData *skills_data_cache = NULL;
static gboolean skills_fetch_in_flight = FALSE;
static gint64 skills_last_fetch_us = 0;
static gint current_filter = 0; /* 0: All, 1: Ready, 2: Needs Setup, 3: Disabled */

/* Forward declarations */
static void skills_rebuild_list(void);
static void skills_force_refresh(void);

/* ── Mutation callbacks ──────────────────────────────────────────── */

static void on_mutation_done(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    if (!skills_status_label) return;

    if (!response->ok) {
        g_autofree gchar *msg = g_strdup_printf("Error: %s",
            response->error_msg ? response->error_msg : "unknown");
        gtk_label_set_text(GTK_LABEL(skills_status_label), msg);
    }

    /* Invalidate and re-fetch to restore button states */
    skills_force_refresh();
}

/* ── Action handlers ─────────────────────────────────────────────── */

static void on_toggle_enable(GtkButton *btn, gpointer user_data) {
    (void)btn;
    const gchar *key = (const gchar *)g_object_get_data(G_OBJECT(btn), "skill-key");
    gboolean currently_enabled = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(btn), "skill-enabled"));
    (void)user_data;
    if (!key) return;

    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    g_autofree gchar *req = mutation_skills_enable(key, !currently_enabled, on_mutation_done, NULL);
    if (!req) {
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (skills_status_label)
            gtk_label_set_text(GTK_LABEL(skills_status_label), "Failed to send request");
    }
}

static void on_install(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(G_OBJECT(btn), "skill-key");
    const gchar *name = (const gchar *)g_object_get_data(G_OBJECT(btn), "skill-name");
    const gchar *install_id = (const gchar *)g_object_get_data(G_OBJECT(btn), "install-id");
    if (!key || !name) return;

    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    if (skills_status_label)
        gtk_label_set_text(GTK_LABEL(skills_status_label), "Installing\u2026");

    g_autofree gchar *req = mutation_skills_install(name, install_id, on_mutation_done, NULL);
    if (!req) {
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (skills_status_label)
            gtk_label_set_text(GTK_LABEL(skills_status_label), "Failed to send install request");
    }
}

static void on_update(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(G_OBJECT(btn), "skill-key");
    if (!key) return;

    gtk_widget_set_sensitive(GTK_WIDGET(btn), FALSE);
    if (skills_status_label)
        gtk_label_set_text(GTK_LABEL(skills_status_label), "Updating\u2026");

    g_autofree gchar *req = mutation_skills_update(key, on_mutation_done, NULL);
    if (!req) {
        gtk_widget_set_sensitive(GTK_WIDGET(btn), TRUE);
        if (skills_status_label)
            gtk_label_set_text(GTK_LABEL(skills_status_label), "Failed to send update request");
    }
}

/* Env / API Key dialog response handler */
static void on_env_dialog_response(GObject *source, GAsyncResult *result, gpointer user_data) {
    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(source);
    (void)user_data;

    const gchar *response_id = adw_alert_dialog_choose_finish(dialog, result);
    if (g_strcmp0(response_id, "save") != 0) return;

    GtkWidget *entry = g_object_get_data(G_OBJECT(dialog), "env-entry");
    const gchar *key = g_object_get_data(G_OBJECT(dialog), "skill-key");
    const gchar *env_name = g_object_get_data(G_OBJECT(dialog), "env-name");
    gboolean is_api_key = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(dialog), "is-api-key"));
    if (!entry || !key || !env_name) return;

    const gchar *value = gtk_editable_get_text(GTK_EDITABLE(entry));
    if (!value || *value == '\0') return;

    if (skills_status_label)
        gtk_label_set_text(GTK_LABEL(skills_status_label), is_api_key ? "Setting API key\u2026" : "Setting environment\u2026");

    g_autofree gchar *req = NULL;
    if (is_api_key) {
        req = mutation_skills_update_api_key(key, value, on_mutation_done, NULL);
    } else {
        req = mutation_skills_update_env(key, env_name, value, on_mutation_done, NULL);
    }
    
    if (!req && skills_status_label) {
        gtk_label_set_text(GTK_LABEL(skills_status_label), "Failed to send request");
    }
}

static void on_open_homepage(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *url = (const gchar *)g_object_get_data(G_OBJECT(btn), "url");
    if (url) g_app_info_launch_default_for_uri(url, NULL, NULL);
}

static void on_set_env(GtkButton *btn, gpointer user_data) {
    (void)user_data;
    const gchar *key = (const gchar *)g_object_get_data(G_OBJECT(btn), "skill-key");
    const gchar *env_name = (const gchar *)g_object_get_data(G_OBJECT(btn), "env-name");
    const gchar *skill_name = (const gchar *)g_object_get_data(G_OBJECT(btn), "skill-name");
    gboolean is_api_key = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(btn), "is-api-key"));
    if (!key || !env_name) return;

    g_autofree gchar *title = g_strdup_printf(is_api_key ? "Set API Key" : "Set %s", env_name);
    g_autofree gchar *body = g_strdup_printf(
        "Enter the value for %s (used by %s):",
        env_name, skill_name ? skill_name : key);

    AdwAlertDialog *dialog = ADW_ALERT_DIALOG(adw_alert_dialog_new(title, body));
    adw_alert_dialog_add_responses(dialog, "cancel", "Cancel", "save", "Save", NULL);
    adw_alert_dialog_set_response_appearance(dialog, "save", ADW_RESPONSE_SUGGESTED);
    adw_alert_dialog_set_default_response(dialog, "save");
    adw_alert_dialog_set_close_response(dialog, "cancel");

    GtkWidget *entry = gtk_password_entry_new();
    gtk_password_entry_set_show_peek_icon(GTK_PASSWORD_ENTRY(entry), TRUE);
    gtk_widget_set_margin_start(entry, 12);
    gtk_widget_set_margin_end(entry, 12);
    adw_alert_dialog_set_extra_child(dialog, entry);

    /* Stash references for the response handler (dialog keeps them alive) */
    g_object_set_data_full(G_OBJECT(dialog), "skill-key", g_strdup(key), g_free);
    g_object_set_data_full(G_OBJECT(dialog), "env-name", g_strdup(env_name), g_free);
    g_object_set_data(G_OBJECT(dialog), "env-entry", entry);
    g_object_set_data(G_OBJECT(dialog), "is-api-key", GINT_TO_POINTER(is_api_key));

    GtkWidget *toplevel = GTK_WIDGET(gtk_widget_get_root(GTK_WIDGET(btn)));
    adw_alert_dialog_choose(dialog, toplevel, NULL,
                            on_env_dialog_response, NULL);
}

/* ── Skill card builder ──────────────────────────────────────────── */

static void build_skill_card(GatewaySkill *sk) {
    GtkWidget *frame = gtk_frame_new(NULL);
    gtk_widget_set_margin_top(frame, 6);
    gtk_widget_set_margin_bottom(frame, 2);

    GtkWidget *card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_start(card, 12);
    gtk_widget_set_margin_end(card, 12);
    gtk_widget_set_margin_top(card, 10);
    gtk_widget_set_margin_bottom(card, 10);

    /* ── Header row: dot + name + source + status badges ── */
    GtkWidget *hdr = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);

    /* Status dot */
    const gchar *dot_text, *dot_class;
    if (sk->disabled) {
        dot_text = "\u25CB"; dot_class = "dim-label";
    } else if (sk->installed && sk->enabled) {
        dot_text = "\u25CF"; dot_class = "success";
    } else if (sk->enabled && !sk->installed) {
        dot_text = "\u25CE"; dot_class = "warning";
    } else {
        dot_text = "\u25CB"; dot_class = "dim-label";
    }
    GtkWidget *dot = gtk_label_new(dot_text);
    gtk_widget_add_css_class(dot, dot_class);
    gtk_box_append(GTK_BOX(hdr), dot);

    /* Skill name */
    GtkWidget *name_lbl = gtk_label_new(sk->name ? sk->name : sk->key);
    gtk_widget_add_css_class(name_lbl, "heading");
    gtk_label_set_xalign(GTK_LABEL(name_lbl), 0.0);
    gtk_widget_set_hexpand(name_lbl, TRUE);
    gtk_label_set_ellipsize(GTK_LABEL(name_lbl), PANGO_ELLIPSIZE_END);
    gtk_box_append(GTK_BOX(hdr), name_lbl);

    /* Source badge */
    if (sk->source) {
        GtkWidget *src = gtk_label_new(sk->source);
        gtk_widget_add_css_class(src, "dim-label");
        gtk_box_append(GTK_BOX(hdr), src);
    }

    /* Bundled / managed badge */
    if (sk->bundled) {
        GtkWidget *b = gtk_label_new("bundled");
        gtk_widget_add_css_class(b, "dim-label");
        gtk_box_append(GTK_BOX(hdr), b);
    } else if (sk->managed) {
        GtkWidget *b = gtk_label_new("managed");
        gtk_widget_add_css_class(b, "dim-label");
        gtk_box_append(GTK_BOX(hdr), b);
    }

    gtk_box_append(GTK_BOX(card), hdr);

    /* ── Description ── */
    if (sk->description) {
        GtkWidget *desc = gtk_label_new(sk->description);
        gtk_widget_add_css_class(desc, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(desc), 0.0);
        gtk_label_set_wrap(GTK_LABEL(desc), TRUE);
        gtk_label_set_max_width_chars(GTK_LABEL(desc), 80);
        gtk_box_append(GTK_BOX(card), desc);
    }

    /* ── Missing requirements ── */
    gboolean has_missing = (sk->n_missing_bins > 0 || sk->n_missing_env > 0 || sk->n_missing_config > 0);
    if (has_missing) {
        GtkWidget *miss_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
        gtk_widget_set_margin_top(miss_box, 4);

        GtkWidget *miss_title = gtk_label_new("Missing requirements:");
        gtk_widget_add_css_class(miss_title, "warning");
        gtk_label_set_xalign(GTK_LABEL(miss_title), 0.0);
        gtk_box_append(GTK_BOX(miss_box), miss_title);

        for (gint j = 0; j < sk->n_missing_bins; j++) {
            g_autofree gchar *txt = g_strdup_printf("  \u2022 Binary: %s", sk->missing_bins[j]);
            GtkWidget *lbl = gtk_label_new(txt);
            gtk_widget_add_css_class(lbl, "warning");
            gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
            gtk_box_append(GTK_BOX(miss_box), lbl);
        }
        for (gint j = 0; j < sk->n_missing_env; j++) {
            g_autofree gchar *txt = g_strdup_printf("  \u2022 Env: %s", sk->missing_env[j]);
            GtkWidget *lbl = gtk_label_new(txt);
            gtk_widget_add_css_class(lbl, "warning");
            gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
            gtk_box_append(GTK_BOX(miss_box), lbl);
        }
        for (gint j = 0; j < sk->n_missing_config; j++) {
            g_autofree gchar *txt = g_strdup_printf("  \u2022 Config: %s", sk->missing_config[j]);
            GtkWidget *lbl = gtk_label_new(txt);
            gtk_widget_add_css_class(lbl, "warning");
            gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
            gtk_box_append(GTK_BOX(miss_box), lbl);
        }

        gtk_box_append(GTK_BOX(card), miss_box);
    }

    /* ── Config checks ── */
    if (sk->n_config_checks > 0) {
        GtkWidget *chk_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 1);
        gtk_widget_set_margin_top(chk_box, 4);

        for (gint j = 0; j < sk->n_config_checks; j++) {
            GatewaySkillConfigCheck *chk = &sk->config_checks[j];
            const gchar *icon = chk->satisfied ? "\u2713" : "\u2717";
            const gchar *cls  = chk->satisfied ? "success" : "error";

            g_autofree gchar *txt = g_strdup_printf("%s %s%s%s", icon, chk->path,
                chk->value_str ? " = " : "",
                chk->value_str ? chk->value_str : "");
            GtkWidget *lbl = gtk_label_new(txt);
            gtk_widget_add_css_class(lbl, cls);
            gtk_label_set_xalign(GTK_LABEL(lbl), 0.0);
            gtk_box_append(GTK_BOX(chk_box), lbl);
        }

        gtk_box_append(GTK_BOX(card), chk_box);
    }

    /* ── Action buttons row ── */
    GtkWidget *actions = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    gtk_widget_set_margin_top(actions, 6);

    /* Enable / Disable toggle */
    if (!sk->always) {
        gboolean is_enabled = sk->enabled && !sk->disabled;
        const gchar *toggle_label = is_enabled ? "Disable" : "Enable";
        GtkWidget *btn_toggle = gtk_button_new_with_label(toggle_label);
        gtk_widget_add_css_class(btn_toggle, "flat");
        if (!is_enabled) gtk_widget_add_css_class(btn_toggle, "suggested-action");
        g_object_set_data_full(G_OBJECT(btn_toggle), "skill-key", g_strdup(sk->key), g_free);
        g_object_set_data(G_OBJECT(btn_toggle), "skill-enabled", GINT_TO_POINTER(is_enabled));
        g_signal_connect(btn_toggle, "clicked", G_CALLBACK(on_toggle_enable), NULL);
        gtk_box_append(GTK_BOX(actions), btn_toggle);
    }

    /* Install button (eligible + not installed) */
    if (sk->eligible && !sk->installed) {
        GtkWidget *btn_inst = gtk_button_new_with_label("Install");
        gtk_widget_add_css_class(btn_inst, "suggested-action");
        g_object_set_data_full(G_OBJECT(btn_inst), "skill-key", g_strdup(sk->key), g_free);
        g_object_set_data_full(G_OBJECT(btn_inst), "skill-name", g_strdup(sk->name ? sk->name : sk->key), g_free);
        /* Use first install option ID if available */
        if (sk->n_install_options > 0 && sk->install_options[0].id) {
            g_object_set_data_full(G_OBJECT(btn_inst), "install-id",
                g_strdup(sk->install_options[0].id), g_free);
        }
        g_signal_connect(btn_inst, "clicked", G_CALLBACK(on_install), NULL);
        gtk_box_append(GTK_BOX(actions), btn_inst);
    }

    /* Update button */
    if (sk->has_update) {
        GtkWidget *btn_upd = gtk_button_new_with_label("Update");
        gtk_widget_add_css_class(btn_upd, "suggested-action");
        g_object_set_data_full(G_OBJECT(btn_upd), "skill-key", g_strdup(sk->key), g_free);
        g_signal_connect(btn_upd, "clicked", G_CALLBACK(on_update), NULL);
        gtk_box_append(GTK_BOX(actions), btn_upd);
    }

    /* API Key / Env editing button */
    if (sk->primary_env) {
        /* Refined API key detection using common naming patterns */
        const gchar *env = sk->primary_env;
        gboolean is_api_key = 
            g_str_has_suffix(env, "_API_KEY") ||
            g_str_has_suffix(env, "_API_TOKEN") ||
            g_str_has_suffix(env, "_SECRET") ||
            g_str_has_suffix(env, "_ACCESS_KEY") ||
            g_str_has_suffix(env, "_AUTH_TOKEN") ||
            g_str_has_suffix(env, "_PASSWORD") ||
            g_str_has_suffix(env, "_KEY") ||
            g_str_has_prefix(env, "API_KEY") ||
            g_str_has_prefix(env, "API_TOKEN") ||
            g_str_has_prefix(env, "SECRET_") ||
            g_str_has_suffix(env, "_API_SECRET");
        
        g_autofree gchar *key_label = g_strdup_printf(is_api_key ? "Set API Key" : "Set %s", sk->primary_env);
        GtkWidget *btn_env = gtk_button_new_with_label(key_label);
        gtk_widget_add_css_class(btn_env, "flat");
        g_object_set_data_full(G_OBJECT(btn_env), "skill-key", g_strdup(sk->key), g_free);
        g_object_set_data_full(G_OBJECT(btn_env), "env-name", g_strdup(sk->primary_env), g_free);
        g_object_set_data_full(G_OBJECT(btn_env), "skill-name",
            g_strdup(sk->name ? sk->name : sk->key), g_free);
        g_object_set_data(G_OBJECT(btn_env), "is-api-key", GINT_TO_POINTER(is_api_key));
        g_signal_connect(btn_env, "clicked", G_CALLBACK(on_set_env), NULL);
        gtk_box_append(GTK_BOX(actions), btn_env);
    }

    /* Homepage link */
    if (sk->homepage) {
        GtkWidget *btn_web = gtk_button_new_with_label("Homepage");
        gtk_widget_add_css_class(btn_web, "flat");
        g_object_set_data_full(G_OBJECT(btn_web), "url", g_strdup(sk->homepage), g_free);
        g_signal_connect(btn_web, "clicked", G_CALLBACK(on_open_homepage), NULL);
        gtk_box_append(GTK_BOX(actions), btn_web);
    }

    gtk_box_append(GTK_BOX(card), actions);

    gtk_frame_set_child(GTK_FRAME(frame), card);
    gtk_box_append(GTK_BOX(skills_list_box), frame);
}

/* ── List rebuild ────────────────────────────────────────────────── */

static void skills_rebuild_list(void) {
    if (!skills_list_box) return;

    section_box_clear(skills_list_box);

    if (!skills_data_cache || skills_data_cache->n_skills == 0) {
        GtkWidget *empty = gtk_label_new("No skills available.");
        gtk_widget_add_css_class(empty, "dim-label");
        gtk_label_set_xalign(GTK_LABEL(empty), 0.0);
        gtk_box_append(GTK_BOX(skills_list_box), empty);
        return;
    }

    for (gint i = 0; i < skills_data_cache->n_skills; i++) {
        GatewaySkill *sk = &skills_data_cache->skills[i];
        
        gboolean match = FALSE;
        gboolean has_missing = (sk->n_missing_bins > 0 || sk->n_missing_env > 0 || sk->n_missing_config > 0);
        
        if (current_filter == 0) {
            match = TRUE; /* All */
        } else if (current_filter == 1) {
            match = sk->installed && !sk->disabled && !has_missing; /* Ready */
        } else if (current_filter == 2) {
            match = !sk->installed || has_missing; /* Needs Setup */
        } else if (current_filter == 3) {
            match = sk->disabled; /* Disabled */
        }
        
        if (match) {
            build_skill_card(sk);
        }
    }
}

/* ── RPC callback ────────────────────────────────────────────────── */

static void on_skills_rpc_response(const GatewayRpcResponse *response, gpointer user_data) {
    (void)user_data;
    skills_fetch_in_flight = FALSE;

    if (!skills_list_box) return;

    if (!response->ok) {
        if (skills_status_label) {
            g_autofree gchar *msg = g_strdup_printf("Error: %s",
                response->error_msg ? response->error_msg : "unknown");
            gtk_label_set_text(GTK_LABEL(skills_status_label), msg);
        }
        return;
    }

    section_mark_fresh(&skills_last_fetch_us);
    gateway_skills_data_free(skills_data_cache);
    skills_data_cache = gateway_data_parse_skills(response->payload);

    if (skills_status_label) {
        if (skills_data_cache) {
            gint enabled = 0;
            for (gint i = 0; i < skills_data_cache->n_skills; i++) {
                if (skills_data_cache->skills[i].enabled && !skills_data_cache->skills[i].disabled)
                    enabled++;
            }
            g_autofree gchar *msg = g_strdup_printf("%d skill%s (%d enabled)",
                skills_data_cache->n_skills,
                skills_data_cache->n_skills == 1 ? "" : "s",
                enabled);
            gtk_label_set_text(GTK_LABEL(skills_status_label), msg);
        } else {
            gtk_label_set_text(GTK_LABEL(skills_status_label), "Failed to parse response");
        }
    }

    skills_rebuild_list();
}

/* ── Force refresh (after mutation) ──────────────────────────────── */

static void skills_force_refresh(void) {
    section_mark_stale(&skills_last_fetch_us);
    skills_fetch_in_flight = FALSE;

    if (!skills_list_box) return;
    if (!gateway_rpc_is_ready()) return;

    skills_fetch_in_flight = TRUE;
    g_autofree gchar *req_id = gateway_rpc_request(
        "skills.status", NULL, 0, on_skills_rpc_response, NULL);
    if (!req_id) {
        skills_fetch_in_flight = FALSE;
    }
}

static void on_filter_changed(GObject *gobject, GParamSpec *pspec, gpointer user_data) {
    (void)pspec;
    (void)user_data;
    current_filter = adw_combo_row_get_selected(ADW_COMBO_ROW(gobject));
    skills_rebuild_list();
}

/* ── SectionController callbacks ─────────────────────────────────── */

static GtkWidget* skills_build(void) {
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

    GtkWidget *title = gtk_label_new("Skills");
    gtk_widget_add_css_class(title, "title-1");
    gtk_label_set_xalign(GTK_LABEL(title), 0.0);
    gtk_widget_set_hexpand(title, TRUE);
    gtk_box_append(GTK_BOX(hdr), title);

    GtkStringList *filter_model = gtk_string_list_new((const char * const[]){
        "All", "Ready", "Needs Setup", "Disabled", NULL
    });
    skills_filter_dropdown = adw_combo_row_new();
    adw_combo_row_set_model(ADW_COMBO_ROW(skills_filter_dropdown), G_LIST_MODEL(filter_model));
    adw_combo_row_set_selected(ADW_COMBO_ROW(skills_filter_dropdown), current_filter);
    g_signal_connect(skills_filter_dropdown, "notify::selected", G_CALLBACK(on_filter_changed), NULL);
    gtk_widget_set_valign(skills_filter_dropdown, GTK_ALIGN_CENTER);
    gtk_box_append(GTK_BOX(hdr), skills_filter_dropdown);

    skills_status_label = gtk_label_new("Loading\u2026");
    gtk_widget_add_css_class(skills_status_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(skills_status_label), 0.0);
    gtk_box_append(GTK_BOX(page), skills_status_label);

    GtkWidget *sep = gtk_separator_new(GTK_ORIENTATION_HORIZONTAL);
    gtk_widget_set_margin_top(sep, 4);
    gtk_widget_set_margin_bottom(sep, 4);
    gtk_box_append(GTK_BOX(page), sep);

    skills_list_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_box_append(GTK_BOX(page), skills_list_box);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void skills_refresh(void) {
    if (!skills_list_box || skills_fetch_in_flight) return;
    /* L7: Check readiness BEFORE freshness - disconnected state must win over cache */
    if (!gateway_rpc_is_ready()) {
        if (skills_status_label)
            gtk_label_set_text(GTK_LABEL(skills_status_label), "Gateway not connected");
        return;
    }
    if (!section_is_stale(&skills_last_fetch_us)) return;

    skills_fetch_in_flight = TRUE;
    g_autofree gchar *req_id = gateway_rpc_request(
        "skills.status", NULL, 0, on_skills_rpc_response, NULL);
    if (!req_id) {
        skills_fetch_in_flight = FALSE;
        if (skills_status_label)
            gtk_label_set_text(GTK_LABEL(skills_status_label), "Failed to send request");
    }
}

static void skills_destroy(void) {
    skills_list_box = NULL;
    skills_status_label = NULL;
    skills_filter_dropdown = NULL;
    skills_fetch_in_flight = FALSE;
    gateway_skills_data_free(skills_data_cache);
    skills_data_cache = NULL;
    skills_last_fetch_us = 0;
}

static void skills_invalidate(void) {
    section_mark_stale(&skills_last_fetch_us);
}

/* ── Public ──────────────────────────────────────────────────────── */

static const SectionController skills_controller = {
    .build      = skills_build,
    .refresh    = skills_refresh,
    .destroy    = skills_destroy,
    .invalidate = skills_invalidate,
};

const SectionController* section_skills_get(void) {
    return &skills_controller;
}
