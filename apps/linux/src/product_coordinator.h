#pragma once

#include "app_window.h"
#include "product_state.h"

void product_coordinator_activate(void);
void product_coordinator_reconcile_startup_presentation(void);
void product_coordinator_request_show_main(void);
void product_coordinator_request_show_section(AppSection section);
void product_coordinator_request_rerun_onboarding(void);
void product_coordinator_notify_onboarding_completed(void);
gboolean product_coordinator_request_set_connection_mode(ProductConnectionMode mode);

void product_coordinator_test_reset(void);
