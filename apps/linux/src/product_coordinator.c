/*
 * product_coordinator.c
 *
 * Product policy coordinator for the OpenClaw Linux Companion App.
 *
 * Orchestrates startup presentation, onboarding/main-window routing, and
 * connection-mode-driven product behavior while leaving runtime truth in
 * `state.c` and persisted intent in `product_state.c`.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "product_coordinator.h"

#include "device_pair_prompter.h"
#include "display_model.h"
#include "gateway_client.h"
#include "onboarding.h"
#include "product_state.h"
#include "state.h"

extern void tray_init(void);
extern void systemd_init(void);
extern void systemd_refresh(void);
extern void notify_init(void);

typedef enum {
    PRODUCT_STARTUP_PRESENTATION_NOOP = 0,
    PRODUCT_STARTUP_PRESENTATION_SHOW_ONBOARDING = 1,
} ProductStartupPresentationAction;

typedef struct {
    gboolean activated;
    guint startup_timer_id;
} ProductCoordinatorState;

static ProductCoordinatorState g_coordinator = {0};

static void product_coordinator_route_remote_guidance(void) {
    app_window_show();
    app_window_navigate_to(SECTION_GENERAL);
}

static void product_coordinator_boot_runtime_lanes(void) {
    state_init();
    product_state_init();
    notify_init();
    tray_init();
    systemd_init();
    systemd_refresh();
    gateway_client_init();
    device_pair_prompter_init(NULL);
}

static ProductStartupPresentationAction product_coordinator_decide_startup_presentation(
    AppState runtime_state,
    ProductConnectionMode effective_mode,
    guint onboarding_seen_version) {
    if (effective_mode == PRODUCT_CONNECTION_MODE_REMOTE) {
        return PRODUCT_STARTUP_PRESENTATION_NOOP;
    }

    OnboardingRoute route = onboarding_routing_decide(runtime_state,
                                                      (int)onboarding_seen_version,
                                                      ONBOARDING_CURRENT_VERSION);
    if (route == ONBOARDING_SKIP) return PRODUCT_STARTUP_PRESENTATION_NOOP;
    return PRODUCT_STARTUP_PRESENTATION_SHOW_ONBOARDING;
}

static gboolean product_coordinator_startup_timeout_cb(gpointer user_data) {
    (void)user_data;
    g_coordinator.startup_timer_id = 0;
    product_coordinator_reconcile_startup_presentation();
    return G_SOURCE_REMOVE;
}

void product_coordinator_activate(void) {
    if (g_coordinator.activated) return;

    g_coordinator.activated = TRUE;
    product_coordinator_boot_runtime_lanes();

    if (g_coordinator.startup_timer_id == 0) {
        g_coordinator.startup_timer_id = g_timeout_add_seconds(2,
                                                               product_coordinator_startup_timeout_cb,
                                                               NULL);
    }
}

void product_coordinator_reconcile_startup_presentation(void) {
    ProductStartupPresentationAction action = product_coordinator_decide_startup_presentation(
        state_get_current(),
        product_state_get_effective_connection_mode(),
        product_state_get_onboarding_seen_version());

    if (action == PRODUCT_STARTUP_PRESENTATION_SHOW_ONBOARDING) {
        onboarding_show();
    }
}

void product_coordinator_request_show_main(void) {
    if (product_state_get_effective_connection_mode() == PRODUCT_CONNECTION_MODE_REMOTE) {
        product_coordinator_route_remote_guidance();
        return;
    }

    app_window_show();
}

void product_coordinator_request_show_section(AppSection section) {
    if (product_state_get_effective_connection_mode() == PRODUCT_CONNECTION_MODE_REMOTE) {
        product_coordinator_route_remote_guidance();
        return;
    }

    app_window_show();
    app_window_navigate_to(section);
}

void product_coordinator_request_rerun_onboarding(void) {
    if (product_state_get_effective_connection_mode() == PRODUCT_CONNECTION_MODE_REMOTE) {
        product_coordinator_route_remote_guidance();
        return;
    }

    onboarding_show();
}

void product_coordinator_notify_onboarding_completed(void) {
    (void)product_state_set_onboarding_seen_version(ONBOARDING_CURRENT_VERSION);
    app_window_show();
}

gboolean product_coordinator_request_set_connection_mode(ProductConnectionMode mode) {
    if (!product_state_set_connection_mode(mode)) {
        return FALSE;
    }

    if (product_state_get_effective_connection_mode() == PRODUCT_CONNECTION_MODE_REMOTE) {
        product_coordinator_route_remote_guidance();
        return TRUE;
    }

    app_window_refresh_snapshot();

    if (product_state_get_onboarding_seen_version() < ONBOARDING_CURRENT_VERSION) {
        onboarding_show();
    }

    return TRUE;
}

void product_coordinator_test_reset(void) {
    if (g_coordinator.startup_timer_id != 0) {
        g_source_remove(g_coordinator.startup_timer_id);
        g_coordinator.startup_timer_id = 0;
    }
    g_coordinator.activated = FALSE;
}
