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

static void test_embedded_mapping(void) {
    g_assert_true(shell_sections_is_embedded(SECTION_DASHBOARD));
    g_assert_false(shell_sections_is_embedded(SECTION_CHAT));
    g_assert_true(shell_sections_is_embedded(SECTION_ABOUT));
    g_assert_false(shell_sections_is_embedded((AppSection)-1));
    g_assert_false(shell_sections_is_embedded(SECTION_COUNT));
}

static void test_metadata_contract(void) {
    for (int i = 0; i < SECTION_COUNT; i++) {
        const ShellSectionMeta *meta = shell_sections_meta((AppSection)i);
        g_assert_nonnull(meta);
        g_assert_nonnull(meta->id);
        g_assert_true(meta->id[0] != '\0');
        g_assert_nonnull(meta->title);
        g_assert_true(meta->title[0] != '\0');
        g_assert_nonnull(meta->icon_name);
        g_assert_true(meta->icon_name[0] != '\0');
    }

    g_assert_null(shell_sections_meta((AppSection)-1));
    g_assert_null(shell_sections_meta(SECTION_COUNT));
}

static void test_controller_lookup(void) {
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

    g_assert_null(shell_sections_controller((AppSection)-1));
    g_assert_null(shell_sections_controller(SECTION_COUNT));
}

static void test_display_registry_is_complete_and_unique(void) {
    gboolean seen[SECTION_COUNT] = {FALSE};

    for (gsize i = 0; i < shell_sections_display_count(); i++) {
        const ShellSectionDisplayEntry *entry = shell_sections_display_at(i);
        g_assert_nonnull(entry);
        g_assert_true(shell_sections_is_embedded(entry->section));
        g_assert_false(seen[entry->section]);
        seen[entry->section] = TRUE;

        const ShellSectionMeta *meta = shell_sections_meta(entry->section);
        const SectionController *controller = shell_sections_controller(entry->section);

        g_assert_nonnull(meta);
        g_assert_nonnull(meta->id);
        g_assert_true(meta->id[0] != '\0');
        g_assert_nonnull(meta->title);
        g_assert_true(meta->title[0] != '\0');
        g_assert_nonnull(meta->icon_name);
        g_assert_true(meta->icon_name[0] != '\0');
        g_assert_nonnull(controller);
        g_assert_true(section_controller_has_required_callbacks(controller));
    }

    g_assert_false(seen[SECTION_CHAT]);
    for (int i = 0; i < SECTION_COUNT; i++) {
        if (i == SECTION_CHAT) continue;
        g_assert_true(seen[i]);
    }
}

static void test_visibility_contract(void) {
    g_unsetenv("OPENCLAW_DEBUG_PANE");

    for (int i = 0; i < SECTION_COUNT; i++) {
        AppSection section = (AppSection)i;
        if (section == SECTION_CHAT || section == SECTION_DEBUG) {
            g_assert_false(shell_sections_is_visible(section));
        } else {
            g_assert_true(shell_sections_is_visible(section));
        }
    }

    g_setenv("OPENCLAW_DEBUG_PANE", "1", TRUE);
    for (int i = 0; i < SECTION_COUNT; i++) {
        AppSection section = (AppSection)i;
        if (section == SECTION_CHAT) {
            g_assert_false(shell_sections_is_visible(section));
        } else {
            g_assert_true(shell_sections_is_visible(section));
        }
    }

    g_unsetenv("OPENCLAW_DEBUG_PANE");
    g_assert_false(shell_sections_is_visible((AppSection)-1));
    g_assert_false(shell_sections_is_visible(SECTION_COUNT));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/shell_sections/embedded_mapping", test_embedded_mapping);
    g_test_add_func("/shell_sections/metadata_contract", test_metadata_contract);
    g_test_add_func("/shell_sections/controller_lookup", test_controller_lookup);
    g_test_add_func("/shell_sections/display_registry_is_complete_and_unique",
                    test_display_registry_is_complete_and_unique);
    g_test_add_func("/shell_sections/visibility_contract", test_visibility_contract);

    return g_test_run();
}
