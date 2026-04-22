#include "section_about.h"

#include <gtk/gtk.h>

#include "state.h"

static GtkWidget* about_build(void) {
    GtkWidget *scrolled = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scrolled),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);

    GtkWidget *page = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(page, 24);
    gtk_widget_set_margin_end(page, 24);
    gtk_widget_set_margin_top(page, 40);
    gtk_widget_set_margin_bottom(page, 24);
    gtk_widget_set_halign(page, GTK_ALIGN_CENTER);

    GtkWidget *title = gtk_label_new("OpenClaw");
    gtk_widget_add_css_class(title, "title-1");
    gtk_box_append(GTK_BOX(page), title);

    GtkWidget *subtitle = gtk_label_new("Linux Companion App");
    gtk_widget_add_css_class(subtitle, "title-3");
    gtk_box_append(GTK_BOX(page), subtitle);

    HealthState *health = state_get_health();
    const char *ver = (health && health->gateway_version) ? health->gateway_version : "Unknown";
    g_autofree gchar *ver_text = g_strdup_printf("Gateway Version: %s", ver);
    GtkWidget *version = gtk_label_new(ver_text);
    gtk_widget_add_css_class(version, "dim-label");
    gtk_widget_set_margin_top(version, 16);
    gtk_box_append(GTK_BOX(page), version);

    GtkWidget *docs_link = gtk_label_new(NULL);
    gtk_label_set_markup(GTK_LABEL(docs_link),
        "<a href=\"https://docs.openclaw.ai\">Documentation</a>");
    gtk_widget_set_margin_top(docs_link, 12);
    gtk_box_append(GTK_BOX(page), docs_link);

    GtkWidget *gh_link = gtk_label_new(NULL);
    gtk_label_set_markup(GTK_LABEL(gh_link),
        "<a href=\"https://github.com/openclaw/openclaw\">GitHub</a>");
    gtk_box_append(GTK_BOX(page), gh_link);

    GtkWidget *copyright = gtk_label_new("Copyright © 2025 OpenClaw Contributors");
    gtk_widget_add_css_class(copyright, "dim-label");
    gtk_widget_set_margin_top(copyright, 24);
    gtk_box_append(GTK_BOX(page), copyright);

    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scrolled), page);
    return scrolled;
}

static const SectionController about_controller = {
    .build = about_build,
    .refresh = NULL,
    .destroy = NULL,
    .invalidate = NULL,
};

const SectionController* section_about_get(void) {
    return &about_controller;
}
