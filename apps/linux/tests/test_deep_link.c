/*
 * test_deep_link.c
 *
 * Hermetic regression for the Linux companion's `openclaw://` URL
 * scheme parser. No GTK, no shell: the parser produces a pure-C
 * DeepLinkRoute value and the suite walks the recognised grammar.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/deep_link.h"

#include <glib.h>

static void assert_parses(const char *uri, DeepLinkRouteKind expected_kind) {
    DeepLinkRoute route = {0};
    g_assert_true(deep_link_parse(uri, &route));
    g_assert_cmpint(route.kind, ==, expected_kind);
    deep_link_route_clear(&route);
}

static void assert_rejects(const char *uri) {
    DeepLinkRoute route = {0};
    g_assert_false(deep_link_parse(uri, &route));
    g_assert_cmpint(route.kind, ==, DEEP_LINK_ROUTE_NONE);
    g_assert_null(route.section_id);
    deep_link_route_clear(&route);
}

static void test_rejects_null_and_empty(void) {
    DeepLinkRoute route = {0};
    g_assert_false(deep_link_parse(NULL, &route));
    g_assert_false(deep_link_parse("", &route));
    /* Missing `out_route` must not crash. */
    g_assert_false(deep_link_parse("openclaw://dashboard", NULL));
}

static void test_rejects_non_openclaw_scheme(void) {
    assert_rejects("https://dashboard");
    assert_rejects("http://openclaw.ai/dashboard");
    assert_rejects("file:///openclaw/dashboard");
}

static void test_dashboard_route(void) {
    assert_parses("openclaw://dashboard", DEEP_LINK_ROUTE_DASHBOARD);
}

static void test_dashboard_route_case_insensitive_host(void) {
    assert_parses("openclaw://Dashboard", DEEP_LINK_ROUTE_DASHBOARD);
    assert_parses("OPENCLAW://DASHBOARD", DEEP_LINK_ROUTE_DASHBOARD);
}

static void test_chat_route(void) {
    assert_parses("openclaw://chat", DEEP_LINK_ROUTE_CHAT);
    assert_parses("openclaw://chat/", DEEP_LINK_ROUTE_CHAT);
}

static void test_settings_root_route(void) {
    DeepLinkRoute route = {0};
    g_assert_true(deep_link_parse("openclaw://settings", &route));
    g_assert_cmpint(route.kind, ==, DEEP_LINK_ROUTE_SETTINGS);
    g_assert_null(route.section_id);
    deep_link_route_clear(&route);
}

static void test_settings_with_known_section_id(void) {
    DeepLinkRoute route = {0};
    g_assert_true(deep_link_parse("openclaw://settings/channels", &route));
    g_assert_cmpint(route.kind, ==, DEEP_LINK_ROUTE_SETTINGS);
    g_assert_cmpstr(route.section_id, ==, "channels");
    deep_link_route_clear(&route);
}

static void test_settings_with_hyphenated_section_id(void) {
    DeepLinkRoute route = {0};
    g_assert_true(deep_link_parse("openclaw://settings/control-room", &route));
    g_assert_cmpstr(route.section_id, ==, "control-room");
    deep_link_route_clear(&route);
}

static void test_settings_lowercases_section_id(void) {
    DeepLinkRoute route = {0};
    /* Upper-case is normalized by the parser so the dispatcher only
     * has to compare against lowercased shell-section ids. */
    g_assert_true(deep_link_parse("openclaw://settings/CHANNELS", &route));
    g_assert_cmpstr(route.section_id, ==, "channels");
    deep_link_route_clear(&route);
}

static void test_settings_rejects_extra_path_segments(void) {
    assert_rejects("openclaw://settings/channels/extra");
    assert_rejects("openclaw://settings//");
}

static void test_onboarding_route(void) {
    assert_parses("openclaw://onboarding", DEEP_LINK_ROUTE_ONBOARDING);
    assert_parses("openclaw://onboarding/", DEEP_LINK_ROUTE_ONBOARDING);
}

static void test_ignores_query_and_fragment(void) {
    assert_parses("openclaw://dashboard?foo=bar", DEEP_LINK_ROUTE_DASHBOARD);
    assert_parses("openclaw://dashboard#frag", DEEP_LINK_ROUTE_DASHBOARD);
    assert_parses("openclaw://dashboard?foo=bar#frag", DEEP_LINK_ROUTE_DASHBOARD);

    DeepLinkRoute route = {0};
    g_assert_true(deep_link_parse("openclaw://settings/channels?tab=1#x", &route));
    g_assert_cmpstr(route.section_id, ==, "channels");
    deep_link_route_clear(&route);
}

static void test_rejects_unknown_host(void) {
    /* macOS uses `agent` and `gateway` hosts for deep-link features
     * that are intentionally out of scope for Linux in this tranche. */
    assert_rejects("openclaw://agent?key=abc&message=hi");
    assert_rejects("openclaw://gateway?target=lan");
    assert_rejects("openclaw://something-else");
}

static void test_rejects_extra_path_segments_on_non_settings_hosts(void) {
    assert_rejects("openclaw://dashboard/extra");
    assert_rejects("openclaw://chat/session/abc");
    assert_rejects("openclaw://onboarding/step-one");
}

static void test_rejects_settings_with_invalid_section_token(void) {
    /* Reject tokens that cannot be valid shell-section ids — spaces,
     * punctuation, etc. A bare trailing slash on `settings/` is a
     * recognised synonym for the root route, so it is intentionally
     * NOT covered here. */
    assert_rejects("openclaw://settings/chan.nels");
    assert_rejects("openclaw://settings/_");
    assert_rejects("openclaw://settings/foo!bar");
}

static void test_settings_root_with_trailing_slash(void) {
    /* `openclaw://settings/` is the same recognised route as
     * `openclaw://settings`, mirroring the chat/dashboard handling. */
    DeepLinkRoute route = {0};
    g_assert_true(deep_link_parse("openclaw://settings/", &route));
    g_assert_cmpint(route.kind, ==, DEEP_LINK_ROUTE_SETTINGS);
    g_assert_null(route.section_id);
    deep_link_route_clear(&route);
}

static void test_route_clear_frees_section_id(void) {
    DeepLinkRoute route = {0};
    g_assert_true(deep_link_parse("openclaw://settings/channels", &route));
    g_assert_nonnull(route.section_id);
    deep_link_route_clear(&route);
    g_assert_null(route.section_id);
    g_assert_cmpint(route.kind, ==, DEEP_LINK_ROUTE_NONE);
    /* Clearing an already-cleared route must be safe. */
    deep_link_route_clear(&route);
    deep_link_route_clear(NULL);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/deep_link/rejects_null_and_empty", test_rejects_null_and_empty);
    g_test_add_func("/deep_link/rejects_non_openclaw_scheme", test_rejects_non_openclaw_scheme);
    g_test_add_func("/deep_link/dashboard_route", test_dashboard_route);
    g_test_add_func("/deep_link/dashboard_route_case_insensitive_host", test_dashboard_route_case_insensitive_host);
    g_test_add_func("/deep_link/chat_route", test_chat_route);
    g_test_add_func("/deep_link/settings_root_route", test_settings_root_route);
    g_test_add_func("/deep_link/settings_with_known_section_id", test_settings_with_known_section_id);
    g_test_add_func("/deep_link/settings_with_hyphenated_section_id", test_settings_with_hyphenated_section_id);
    g_test_add_func("/deep_link/settings_lowercases_section_id", test_settings_lowercases_section_id);
    g_test_add_func("/deep_link/settings_rejects_extra_path_segments", test_settings_rejects_extra_path_segments);
    g_test_add_func("/deep_link/onboarding_route", test_onboarding_route);
    g_test_add_func("/deep_link/ignores_query_and_fragment", test_ignores_query_and_fragment);
    g_test_add_func("/deep_link/rejects_unknown_host", test_rejects_unknown_host);
    g_test_add_func("/deep_link/rejects_extra_path_segments_on_non_settings_hosts",
                    test_rejects_extra_path_segments_on_non_settings_hosts);
    g_test_add_func("/deep_link/rejects_settings_with_invalid_section_token",
                    test_rejects_settings_with_invalid_section_token);
    g_test_add_func("/deep_link/settings_root_with_trailing_slash",
                    test_settings_root_with_trailing_slash);
    g_test_add_func("/deep_link/route_clear_frees_section_id", test_route_clear_frees_section_id);

    return g_test_run();
}
