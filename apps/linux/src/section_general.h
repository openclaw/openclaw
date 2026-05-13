#pragma once

#include <glib.h>

#include "section_controller.h"

const SectionController* section_general_get(void);

/*
 * Public funnels for the two everyday toggles introduced in Tranche E.
 *
 * Heartbeats: persists the choice via product_state and pushes the
 * `set-heartbeats` RPC. Safe to call when WS is disconnected — the
 * persisted value will be re-asserted on the next WS-ready transition.
 *
 * Browser Control: thin section-side compatibility wrapper around
 * `browser_control_state_request_set` that adds optimistic UI on top
 * of the shared mutator. Tray-driven toggles bypass this wrapper and
 * call `browser_control_state_request_set` directly so the tray does
 * not depend on the General section being mounted.
 */
void section_general_request_heartbeats(gboolean enabled);
void section_general_request_browser_control(gboolean enabled);

/*
 * Best-effort heartbeats probe used by the tray host so it can emit
 * `CHECK:HEARTBEATS:0|1` lines that match what the General section
 * would render. Browser Control state is read directly from
 * `browser_control_state_get` instead — there is no
 * section-mediated accessor for it.
 */
gboolean section_general_heartbeats_enabled(void);
