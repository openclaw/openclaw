#include "section_about.h"

#include <adwaita.h>

#include "state.h"

#ifndef OPENCLAW_APP_VERSION
#define OPENCLAW_APP_VERSION "dev"
#endif

#ifndef OPENCLAW_GIT_COMMIT
#define OPENCLAW_GIT_COMMIT "unknown"
#endif

#ifndef OPENCLAW_BUILD_TIMESTAMP
#define OPENCLAW_BUILD_TIMESTAMP ""
#endif

static void about_open_uri(const gchar *uri) {
    if (!uri || uri[0] == '\0') {
        return;
    }

    g_app_info_launch_default_for_uri(uri, NULL, NULL);
}

static void on_about_link_row_activated(AdwActionRow *row, gpointer user_data) {
    (void)user_data;
    const gchar *uri = (const gchar *)g_object_get_data(G_OBJECT(row), "uri");
    about_open_uri(uri);
}

static gchar* about_version_text(void) {
    if (g_strcmp0(OPENCLAW_GIT_COMMIT, "unknown") == 0 || OPENCLAW_GIT_COMMIT[0] == '\0') {
        return g_strdup_printf("Version %s", OPENCLAW_APP_VERSION);
    }

#ifndef NDEBUG
    return g_strdup_printf("Version %s (%s DEBUG)", OPENCLAW_APP_VERSION, OPENCLAW_GIT_COMMIT);
#else
    return g_strdup_printf("Version %s (%s)", OPENCLAW_APP_VERSION, OPENCLAW_GIT_COMMIT);
#endif
}

static gchar* about_build_text(void) {
    if (OPENCLAW_BUILD_TIMESTAMP[0] == '\0') {
        return NULL;
    }

    g_autoptr(GDateTime) parsed = g_date_time_new_from_iso8601(OPENCLAW_BUILD_TIMESTAMP, NULL);
    if (!parsed) {
        return g_strdup_printf("Built %s", OPENCLAW_BUILD_TIMESTAMP);
    }

    return g_date_time_format(parsed, "Built %b %-d, %Y %H:%M %Z");
}

static GtkWidget* about_link_row(const gchar *icon_name,
                                 const gchar *title,
                                 const gchar *subtitle,
                                 const gchar *uri) {
    GtkWidget *row = adw_action_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(row), title);
    adw_action_row_set_subtitle(ADW_ACTION_ROW(row), subtitle);
    gtk_list_box_row_set_activatable(GTK_LIST_BOX_ROW(row), TRUE);
    gtk_list_box_row_set_selectable(GTK_LIST_BOX_ROW(row), FALSE);
    g_object_set_data_full(G_OBJECT(row), "uri", g_strdup(uri), g_free);
    g_signal_connect(row, "activated", G_CALLBACK(on_about_link_row_activated), NULL);

    GtkWidget *icon = gtk_image_new_from_icon_name(icon_name);
    gtk_widget_set_valign(icon, GTK_ALIGN_CENTER);
    adw_action_row_add_prefix(ADW_ACTION_ROW(row), icon);

    return row;
}

static GtkWidget* about_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = adw_preferences_page_new();
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 24);
    gtk_widget_set_margin_bottom(page, 24);

    GtkWidget *identity_group = adw_preferences_group_new();
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(identity_group));

    GtkWidget *identity = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    gtk_widget_set_halign(identity, GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(identity, 8);
    gtk_widget_set_margin_bottom(identity, 8);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(identity_group), identity);

    GtkIconTheme *theme = gdk_display_get_default()
        ? gtk_icon_theme_get_for_display(gdk_display_get_default())
        : NULL;
    const gchar *app_icon = (theme && gtk_icon_theme_has_icon(theme, "ai.openclaw.Companion"))
        ? "ai.openclaw.Companion"
        : "applications-system-symbolic";
    GtkWidget *icon = gtk_image_new_from_icon_name(app_icon);
    gtk_image_set_pixel_size(GTK_IMAGE(icon), 96);
    gtk_widget_set_margin_bottom(icon, 6);
    gtk_box_append(GTK_BOX(identity), icon);

    GtkWidget *title = gtk_label_new("OpenClaw");
    gtk_widget_add_css_class(title, "title-1");
    gtk_box_append(GTK_BOX(identity), title);

    GtkWidget *subtitle = gtk_label_new("Linux Companion App");
    gtk_widget_add_css_class(subtitle, "title-3");
    gtk_box_append(GTK_BOX(identity), subtitle);

    g_autofree gchar *version_text = about_version_text();
    GtkWidget *version = gtk_label_new(version_text);
    gtk_widget_add_css_class(version, "dim-label");
    gtk_box_append(GTK_BOX(identity), version);

    g_autofree gchar *build_text = about_build_text();
    if (build_text) {
        GtkWidget *build = gtk_label_new(build_text);
        gtk_widget_add_css_class(build, "dim-label");
        gtk_box_append(GTK_BOX(identity), build);
    }

    GtkWidget *summary = gtk_label_new("Companion app for the OpenClaw gateway — runtime status, config, and local service management.");
    gtk_widget_add_css_class(summary, "dim-label");
    gtk_label_set_wrap(GTK_LABEL(summary), TRUE);
    gtk_label_set_justify(GTK_LABEL(summary), GTK_JUSTIFY_CENTER);
    gtk_label_set_xalign(GTK_LABEL(summary), 0.5);
    gtk_widget_set_margin_top(summary, 4);
    gtk_box_append(GTK_BOX(identity), summary);

    HealthState *health = state_get_health();
    const char *gateway_version = (health && health->gateway_version) ? health->gateway_version : "Unknown";
    g_autofree gchar *gateway_text = g_strdup_printf("Gateway version: %s", gateway_version);
    GtkWidget *gateway_label = gtk_label_new(gateway_text);
    gtk_widget_add_css_class(gateway_label, "dim-label");
    gtk_label_set_xalign(GTK_LABEL(gateway_label), 0.5);
    gtk_widget_set_margin_top(gateway_label, 4);
    gtk_box_append(GTK_BOX(identity), gateway_label);

    GtkWidget *links_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(links_group), "Links");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(links_group));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(links_group),
                              about_link_row("text-x-script-symbolic",
                                             "GitHub",
                                             "github.com/openclaw/openclaw",
                                             "https://github.com/openclaw/openclaw"));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(links_group),
                              about_link_row("globe-symbolic",
                                             "Website",
                                             "openclaw.ai",
                                             "https://openclaw.ai"));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(links_group),
                              about_link_row("help-browser-symbolic",
                                             "Documentation",
                                             "docs.openclaw.ai",
                                             "https://docs.openclaw.ai"));
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(links_group),
                              about_link_row("mail-send-symbolic",
                                             "Email",
                                             "hello@openclaw.ai",
                                             "mailto:hello@openclaw.ai"));

    GtkWidget *updates_group = adw_preferences_group_new();
    adw_preferences_group_set_title(ADW_PREFERENCES_GROUP(updates_group), "Updates");
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(updates_group));
    GtkWidget *updates_row = adw_action_row_new();
    adw_preferences_row_set_title(ADW_PREFERENCES_ROW(updates_row), "Linux updates");
    adw_action_row_set_subtitle(ADW_ACTION_ROW(updates_row),
                                "Automatic updates are not yet available on Linux.");
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(updates_group), updates_row);

    GtkWidget *footer_group = adw_preferences_group_new();
    adw_preferences_page_add(ADW_PREFERENCES_PAGE(page), ADW_PREFERENCES_GROUP(footer_group));
    GtkWidget *copyright = gtk_label_new("© 2025 OpenClaw Contributors — MIT License.");
    gtk_widget_add_css_class(copyright, "dim-label");
    gtk_widget_set_margin_top(copyright, 16);
    gtk_label_set_xalign(GTK_LABEL(copyright), 0.5);
    adw_preferences_group_add(ADW_PREFERENCES_GROUP(footer_group), copyright);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static void about_refresh(void) {
}

static void about_destroy(void) {
}

static void about_invalidate(void) {
}

static const SectionController about_controller = {
    .build = about_build,
    .refresh = about_refresh,
    .destroy = about_destroy,
    .invalidate = about_invalidate,
};

const SectionController* section_about_get(void) {
    return &about_controller;
}
