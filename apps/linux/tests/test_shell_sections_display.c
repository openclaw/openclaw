#include <glib.h>

#include "../src/app_window.h"
#include "../src/section_controller.h"
#include "../src/shell_sections.h"

static GtkWidget* dummy_build(void) {
    return NULL;
}

static void dummy_refresh(void) {
}

static void dummy_destroy(void) {
}

static void dummy_invalidate(void) {
}

static const SectionController dummy_controller = {
    .build = dummy_build,
    .refresh = dummy_refresh,
    .destroy = dummy_destroy,
    .invalidate = dummy_invalidate,
};

#define DEFINE_SECTION_GETTER(name) \
    const SectionController* name(void) { return &dummy_controller; }

DEFINE_SECTION_GETTER(section_dashboard_get)
DEFINE_SECTION_GETTER(section_agents_get)
DEFINE_SECTION_GETTER(section_about_get)
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

static void test_display_order_matches_expected_blocks(void) {
    const ShellSectionGroup expected_groups[] = {
        [SECTION_DASHBOARD] = SHELL_SECTION_GROUP_PARITY,
        [SECTION_AGENTS] = SHELL_SECTION_GROUP_EXTRAS_OPERATIONAL,
        [SECTION_ABOUT] = SHELL_SECTION_GROUP_PARITY,
        [SECTION_USAGE] = SHELL_SECTION_GROUP_EXTRAS_OPERATIONAL,
        [SECTION_GENERAL] = SHELL_SECTION_GROUP_PARITY,
        [SECTION_CONFIG] = SHELL_SECTION_GROUP_PARITY,
        [SECTION_CHANNELS] = SHELL_SECTION_GROUP_PARITY,
        [SECTION_SKILLS] = SHELL_SECTION_GROUP_PARITY,
        [SECTION_WORKFLOWS] = SHELL_SECTION_GROUP_EXTRAS_OPERATIONAL,
        [SECTION_CONTROL_ROOM] = SHELL_SECTION_GROUP_EXTRAS_OPERATIONAL,
        [SECTION_ENVIRONMENT] = SHELL_SECTION_GROUP_EXTRAS_DIAGNOSTIC,
        [SECTION_DIAGNOSTICS] = SHELL_SECTION_GROUP_EXTRAS_DIAGNOSTIC,
        [SECTION_LOGS] = SHELL_SECTION_GROUP_EXTRAS_DIAGNOSTIC,
        [SECTION_INSTANCES] = SHELL_SECTION_GROUP_PARITY,
        [SECTION_DEBUG] = SHELL_SECTION_GROUP_EXTRAS_DEBUG,
        [SECTION_SESSIONS] = SHELL_SECTION_GROUP_PARITY,
        [SECTION_CRON] = SHELL_SECTION_GROUP_PARITY,
    };
    const AppSection expected_order[] = {
        SECTION_DASHBOARD,
        SECTION_GENERAL,
        SECTION_CHANNELS,
        SECTION_CONFIG,
        SECTION_INSTANCES,
        SECTION_SESSIONS,
        SECTION_CRON,
        SECTION_SKILLS,
        SECTION_ABOUT,
        SECTION_AGENTS,
        SECTION_USAGE,
        SECTION_WORKFLOWS,
        SECTION_CONTROL_ROOM,
        SECTION_ENVIRONMENT,
        SECTION_DIAGNOSTICS,
        SECTION_LOGS,
        SECTION_DEBUG,
    };
    g_assert_cmpuint(shell_sections_display_count(), ==, G_N_ELEMENTS(expected_order));

    gboolean seen[SECTION_COUNT] = {FALSE};
    for (gsize i = 0; i < shell_sections_display_count(); i++) {
        const ShellSectionDisplayEntry *entry = shell_sections_display_at(i);
        g_assert_nonnull(entry);
        g_assert_cmpint(entry->section, ==, expected_order[i]);
        g_assert_true(shell_sections_is_embedded(entry->section));
        g_assert_false(seen[entry->section]);
        seen[entry->section] = TRUE;

        g_assert_cmpint(entry->group, ==, expected_groups[entry->section]);
    }

    g_assert_false(seen[SECTION_CHAT]);
    for (int i = 0; i < SECTION_COUNT; i++) {
        if (i == SECTION_CHAT) continue;
        g_assert_true(seen[i]);
    }
}

static void test_display_order_out_of_range_returns_null(void) {
    g_assert_null(shell_sections_display_at(shell_sections_display_count()));
}

static void test_display_entries_have_controllers(void) {
    for (gsize i = 0; i < shell_sections_display_count(); i++) {
        const ShellSectionDisplayEntry *entry = shell_sections_display_at(i);
        g_assert_nonnull(entry);
        g_assert_true(section_controller_has_required_callbacks(
            shell_sections_controller(entry->section)));
    }
}

static void test_group_heading_contract(void) {
    g_assert_null(shell_sections_group_heading(SHELL_SECTION_GROUP_PARITY));
    g_assert_cmpstr(shell_sections_group_heading(SHELL_SECTION_GROUP_EXTRAS_OPERATIONAL), ==, "Operational");
    g_assert_cmpstr(shell_sections_group_heading(SHELL_SECTION_GROUP_EXTRAS_DIAGNOSTIC), ==, "Diagnostics");
    g_assert_cmpstr(shell_sections_group_heading(SHELL_SECTION_GROUP_EXTRAS_DEBUG), ==, "Developer");
}

static void test_debug_pane_gate(void) {
    g_unsetenv("OPENCLAW_DEBUG_PANE");
    g_assert_false(shell_sections_debug_pane_enabled());

    g_setenv("OPENCLAW_DEBUG_PANE", "1", TRUE);
    g_assert_true(shell_sections_debug_pane_enabled());

    g_setenv("OPENCLAW_DEBUG_PANE", "true", TRUE);
    g_assert_true(shell_sections_debug_pane_enabled());

    g_setenv("OPENCLAW_DEBUG_PANE", "YES", TRUE);
    g_assert_true(shell_sections_debug_pane_enabled());

    g_setenv("OPENCLAW_DEBUG_PANE", "0", TRUE);
    g_assert_false(shell_sections_debug_pane_enabled());

    g_setenv("OPENCLAW_DEBUG_PANE", "banana", TRUE);
    g_assert_false(shell_sections_debug_pane_enabled());

    g_unsetenv("OPENCLAW_DEBUG_PANE");
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/shell_sections_display/order_matches_expected_blocks",
                    test_display_order_matches_expected_blocks);
    g_test_add_func("/shell_sections_display/out_of_range_returns_null",
                    test_display_order_out_of_range_returns_null);
    g_test_add_func("/shell_sections_display/entries_have_controllers",
                    test_display_entries_have_controllers);
    g_test_add_func("/shell_sections_display/group_heading_contract",
                    test_group_heading_contract);
    g_test_add_func("/shell_sections_display/debug_pane_gate",
                    test_debug_pane_gate);

    return g_test_run();
}
