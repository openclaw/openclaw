/*
 * test_shell_sections.c
 *
 * Focused coverage for the Linux companion shell section registry.
 *
 * Verifies embedded-section mapping, metadata contract, and controller
 * lookup without pulling in section implementation internals.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>

#include "../src/app_window.h"
#include "../src/section_controller.h"
#include "../src/shell_sections.h"

static const SectionController dummy_controller = {0};

#define DEFINE_SECTION_GETTER(name) \
    const SectionController* name(void) { return &dummy_controller; }

DEFINE_SECTION_GETTER(section_dashboard_get)
DEFINE_SECTION_GETTER(section_agents_get)
DEFINE_SECTION_GETTER(section_usage_get)
DEFINE_SECTION_GETTER(section_general_get)
DEFINE_SECTION_GETTER(section_config_get)
DEFINE_SECTION_GETTER(section_channels_get)
DEFINE_SECTION_GETTER(section_skills_get)
DEFINE_SECTION_GETTER(section_workflows_get)
DEFINE_SECTION_GETTER(section_control_room_get)
DEFINE_SECTION_GETTER(section_environment_get)
DEFINE_SECTION_GETTER(section_diagnostics_get)
DEFINE_SECTION_GETTER(section_logs_get)
DEFINE_SECTION_GETTER(section_instances_get)
DEFINE_SECTION_GETTER(section_debug_get)
DEFINE_SECTION_GETTER(section_sessions_get)
DEFINE_SECTION_GETTER(section_cron_get)

static void test_embedded_mapping(void) {
    g_assert_true(shell_sections_is_embedded(SECTION_DASHBOARD));
    g_assert_false(shell_sections_is_embedded(SECTION_CHAT));
    g_assert_true(shell_sections_is_embedded(SECTION_ABOUT));
}

static void test_metadata_contract(void) {
    const ShellSectionMeta *dashboard = shell_sections_meta(SECTION_DASHBOARD);
    const ShellSectionMeta *diagnostics = shell_sections_meta(SECTION_DIAGNOSTICS);
    const ShellSectionMeta *about = shell_sections_meta(SECTION_ABOUT);

    g_assert_nonnull(dashboard);
    g_assert_cmpstr(dashboard->id, ==, "dashboard");
    g_assert_cmpstr(dashboard->title, ==, "Dashboard");

    g_assert_nonnull(diagnostics);
    g_assert_cmpstr(diagnostics->id, ==, "diagnostics");
    g_assert_cmpstr(diagnostics->icon_name, ==, "utilities-system-monitor-symbolic");

    g_assert_nonnull(about);
    g_assert_cmpstr(about->id, ==, "about");
}

static void test_controller_lookup(void) {
    g_assert_nonnull(shell_sections_controller(SECTION_DASHBOARD));
    g_assert_nonnull(shell_sections_controller(SECTION_GENERAL));
    g_assert_nonnull(shell_sections_controller(SECTION_CONFIG));
    g_assert_nonnull(shell_sections_controller(SECTION_DIAGNOSTICS));
    g_assert_nonnull(shell_sections_controller(SECTION_ENVIRONMENT));
    g_assert_nonnull(shell_sections_controller(SECTION_DEBUG));
    g_assert_nonnull(shell_sections_controller(SECTION_AGENTS));
    g_assert_nonnull(shell_sections_controller(SECTION_INSTANCES));
    g_assert_null(shell_sections_controller(SECTION_CHAT));
    g_assert_null(shell_sections_controller(SECTION_ABOUT));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/shell_sections/embedded_mapping", test_embedded_mapping);
    g_test_add_func("/shell_sections/metadata_contract", test_metadata_contract);
    g_test_add_func("/shell_sections/controller_lookup", test_controller_lookup);

    return g_test_run();
}
