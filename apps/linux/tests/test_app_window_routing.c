/*
 * test_app_window_routing.c
 *
 * Pure-C regression for the sidebar row → AppSection tag encoding used
 * by `build_sidebar_row()` / `on_sidebar_row_activated()` /
 * `app_window_navigate_to()` in `src/app_window.c`.
 *
 * The specific bug this guards against: the enum value for
 * `SECTION_DASHBOARD` is 0. The original implementation stashed the
 * section onto each sidebar row via
 *
 *     g_object_set_data(box, "oc_section", GINT_TO_POINTER((gint)section))
 *
 * which, for Dashboard, stored a literal NULL. The activation handler
 * then bailed out with `if (!tag) return` and the Dashboard row never
 * navigated — users saw whatever section was on screen before
 * (typically Agents) even after clicking Dashboard.
 *
 * The shipping fix is a shifted encoding (`section + 1` on store,
 * `- 1` on read). These tests enforce that contract directly without
 * standing up GTK or a real main window.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/app_window.h"

#include <glib.h>

/*
 * Dashboard (enum 0) must round-trip through encode/decode and must
 * NOT be indistinguishable from the "no data" sentinel.
 */
static void test_dashboard_enum_zero_round_trips(void) {
    gpointer tag = app_window_section_tag_encode(SECTION_DASHBOARD);
    g_assert_nonnull(tag);   /* MUST NOT be NULL — this is the bug. */

    AppSection out;
    g_assert_true(app_window_section_tag_decode(tag, &out));
    g_assert_cmpint(out, ==, SECTION_DASHBOARD);
}

/*
 * Every valid section round-trips.
 */
static void test_all_sections_round_trip(void) {
    for (int i = 0; i < SECTION_COUNT; i++) {
        AppSection s = (AppSection)i;
        gpointer tag = app_window_section_tag_encode(s);
        g_assert_nonnull(tag);

        AppSection out = (AppSection)-1;
        g_assert_true(app_window_section_tag_decode(tag, &out));
        g_assert_cmpint(out, ==, s);
    }
}

/*
 * A NULL tag (the "no data set" sentinel returned by g_object_get_data
 * when a key was never stored) must decode to FALSE so the activation
 * handler can distinguish it from a real section.
 */
static void test_null_tag_is_rejected(void) {
    AppSection out = SECTION_AGENTS;  /* seed with a non-default value */
    g_assert_false(app_window_section_tag_decode(NULL, &out));
}

/*
 * Encoded values must be distinct from one another AND distinct from NULL.
 */
static void test_encoded_tags_are_distinct_and_non_null(void) {
    gpointer seen[SECTION_COUNT];
    for (int i = 0; i < SECTION_COUNT; i++) {
        seen[i] = app_window_section_tag_encode((AppSection)i);
        g_assert_nonnull(seen[i]);
    }
    for (int i = 0; i < SECTION_COUNT; i++) {
        for (int j = i + 1; j < SECTION_COUNT; j++) {
            g_assert_true(seen[i] != seen[j]);
        }
    }
}

/*
 * Out-of-range encoded values must be rejected.
 */
static void test_out_of_range_decoded_tag_is_rejected(void) {
    AppSection out = SECTION_DASHBOARD;
    /* section_count + 1 after the +1 shift is still out of range. */
    gpointer bogus = GINT_TO_POINTER(SECTION_COUNT + 1);
    g_assert_false(app_window_section_tag_decode(bogus, &out));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/app_window_routing/dashboard_enum_zero_round_trips",
                    test_dashboard_enum_zero_round_trips);
    g_test_add_func("/app_window_routing/all_sections_round_trip",
                    test_all_sections_round_trip);
    g_test_add_func("/app_window_routing/null_tag_is_rejected",
                    test_null_tag_is_rejected);
    g_test_add_func("/app_window_routing/encoded_tags_are_distinct_and_non_null",
                    test_encoded_tags_are_distinct_and_non_null);
    g_test_add_func("/app_window_routing/out_of_range_decoded_tag_is_rejected",
                    test_out_of_range_decoded_tag_is_rejected);
    return g_test_run();
}
