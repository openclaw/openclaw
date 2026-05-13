/*
 * test_section_controllers_contract.c
 *
 * Real-controller contract audit for the Linux companion shell.
 *
 * Tranche D added a shared `SectionController` contract and a shared
 * `section_controller_has_required_callbacks()` predicate, but
 * enforcement in `test_shell_sections.c` runs against a dummy
 * controller, not the real production `section_*_get()` tables. This
 * test closes that loop by linking the actual section translation
 * units and asserting, for every embedded `AppSection`, that the
 * controller returned by `shell_sections_controller()` is non-NULL
 * and has all four required callbacks populated.
 *
 * It does NOT invoke any callback. It only inspects the static
 * controller tables, so no GTK display backend is required. The goal
 * is to regression-guard the specific class of bug that caused the
 * About-tab partial-controller crash (refresh/destroy/invalidate
 * silently NULL), which the dummy-based registry test cannot catch.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>

#include "../src/app_window.h"
#include "../src/section_controller.h"
#include "../src/shell_sections.h"

/*
 * `state.c` references `state_on_gateway_refresh_requested()` through an
 * idle source and the real implementation lives in `main.c`, which the
 * audit binary intentionally excludes so it can provide its own main().
 * The test never schedules that idle source, so a no-op stub is safe
 * and keeps the link closed. */
void state_on_gateway_refresh_requested(void) {
}

static void test_every_real_controller_has_required_callbacks(void) {
    for (int i = 0; i < SECTION_COUNT; i++) {
        AppSection section = (AppSection)i;
        const SectionController *controller = shell_sections_controller(section);

        if (section == SECTION_CHAT) {
            g_assert_null(controller);
            continue;
        }

        g_assert_nonnull(controller);
        g_assert_true(section_controller_has_required_callbacks(controller));
    }
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/section_controllers_contract/every_real_controller_has_required_callbacks",
                    test_every_real_controller_has_required_callbacks);
    return g_test_run();
}
