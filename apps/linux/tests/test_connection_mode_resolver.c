/*
 * test_connection_mode_resolver.c
 *
 * Exhaustive matrix for the pure-logic effective-mode resolver.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>

#include "../src/connection_mode_resolver.h"

static void test_config_mode_local_wins(void) {
    EffectiveConnectionMode r = connection_mode_resolve(
        "local", TRUE, PRODUCT_CONNECTION_MODE_REMOTE, TRUE);
    g_assert_cmpint(r.mode, ==, PRODUCT_CONNECTION_MODE_LOCAL);
    g_assert_cmpint(r.source, ==, EFFECTIVE_MODE_SRC_CONFIG_MODE);
}

static void test_config_mode_remote_wins(void) {
    EffectiveConnectionMode r = connection_mode_resolve(
        "remote", FALSE, PRODUCT_CONNECTION_MODE_LOCAL, TRUE);
    g_assert_cmpint(r.mode, ==, PRODUCT_CONNECTION_MODE_REMOTE);
    g_assert_cmpint(r.source, ==, EFFECTIVE_MODE_SRC_CONFIG_MODE);
}

static void test_config_mode_case_insensitive(void) {
    EffectiveConnectionMode r = connection_mode_resolve(
        "  Remote  ", FALSE, PRODUCT_CONNECTION_MODE_LOCAL, TRUE);
    g_assert_cmpint(r.mode, ==, PRODUCT_CONNECTION_MODE_REMOTE);
}

static void test_config_remote_url_implies_remote(void) {
    EffectiveConnectionMode r = connection_mode_resolve(
        NULL, TRUE, PRODUCT_CONNECTION_MODE_LOCAL, TRUE);
    g_assert_cmpint(r.mode, ==, PRODUCT_CONNECTION_MODE_REMOTE);
    g_assert_cmpint(r.source, ==, EFFECTIVE_MODE_SRC_CONFIG_REMOTE_URL);
}

static void test_product_state_explicit_wins_over_onboarding(void) {
    EffectiveConnectionMode r = connection_mode_resolve(
        NULL, FALSE, PRODUCT_CONNECTION_MODE_REMOTE, FALSE);
    g_assert_cmpint(r.mode, ==, PRODUCT_CONNECTION_MODE_REMOTE);
    g_assert_cmpint(r.source, ==, EFFECTIVE_MODE_SRC_PRODUCT_STATE);
}

static void test_onboarding_fallback_local(void) {
    EffectiveConnectionMode r = connection_mode_resolve(
        NULL, FALSE, PRODUCT_CONNECTION_MODE_UNSPECIFIED, FALSE);
    g_assert_cmpint(r.mode, ==, PRODUCT_CONNECTION_MODE_LOCAL);
    g_assert_cmpint(r.source, ==, EFFECTIVE_MODE_SRC_ONBOARDING);
}

static void test_unknown_config_mode_falls_through(void) {
    EffectiveConnectionMode r = connection_mode_resolve(
        "wat", FALSE, PRODUCT_CONNECTION_MODE_REMOTE, TRUE);
    g_assert_cmpint(r.mode, ==, PRODUCT_CONNECTION_MODE_REMOTE);
    g_assert_cmpint(r.source, ==, EFFECTIVE_MODE_SRC_PRODUCT_STATE);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/cm_resolver/config_mode_local_wins", test_config_mode_local_wins);
    g_test_add_func("/cm_resolver/config_mode_remote_wins", test_config_mode_remote_wins);
    g_test_add_func("/cm_resolver/config_mode_case_insensitive", test_config_mode_case_insensitive);
    g_test_add_func("/cm_resolver/config_remote_url_implies_remote", test_config_remote_url_implies_remote);
    g_test_add_func("/cm_resolver/product_state_explicit_wins_over_onboarding", test_product_state_explicit_wins_over_onboarding);
    g_test_add_func("/cm_resolver/onboarding_fallback_local", test_onboarding_fallback_local);
    g_test_add_func("/cm_resolver/unknown_config_mode_falls_through", test_unknown_config_mode_falls_through);
    return g_test_run();
}
