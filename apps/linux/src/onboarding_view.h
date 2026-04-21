#pragma once

#include <gtk/gtk.h>

#include "display_model.h"

typedef struct {
    void (*finish_clicked)(GtkButton *button, gpointer user_data);
    void (*open_dashboard_clicked)(GtkButton *button, gpointer user_data);
    void (*close_clicked)(GtkButton *button, gpointer user_data);
} OnboardingViewCallbacks;

void onboarding_view_reset(void);
void onboarding_view_build_pages(GtkWidget *carousel,
                                 OnboardingRoute route,
                                 const OnboardingViewCallbacks *callbacks);
void onboarding_view_rebuild_pages(GtkWidget *carousel,
                                   OnboardingRoute route,
                                   const OnboardingViewCallbacks *callbacks);
void onboarding_view_refresh_live_content(void);
