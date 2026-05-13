/*
 * test_model_catalog_match.c
 *
 * Regression tests for `model_catalog_entry_matches_configured_default()`
 * in `src/display_model.c`.
 *
 * The bug this guards against: Config stores the operator-selected
 * default as a provider-prefixed string (`"ollama/gpt-oss:20b"`), while
 * `models.list` returns catalog entries whose `id` is bare
 * (`"gpt-oss:20b"`) and whose provider lives on a separate `provider`
 * field. The original raw `g_strcmp0(id, default_model_id)` never hit,
 * so the chat gate permanently reported SELECTED_MODEL_UNRESOLVED and
 * the Chat window showed "Selected model unavailable" despite the
 * catalog being fresh and containing the right entry.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/display_model.h"

#include <glib.h>

/* ── Positive cases ── */

static void test_bare_default_matches_bare_catalog_id(void) {
    g_assert_true(model_catalog_entry_matches_configured_default(
        "gpt-oss:20b", "gpt-oss:20b", "ollama"));
}

static void test_provider_prefixed_default_matches_bare_catalog_id(void) {
    /* The actual Issue 2 scenario: Config has "ollama/gpt-oss:20b"; the
     * catalog entry's `id` is "gpt-oss:20b" with `provider=ollama`. */
    g_assert_true(model_catalog_entry_matches_configured_default(
        "ollama/gpt-oss:20b", "gpt-oss:20b", "ollama"));
}

static void test_provider_with_nested_slash_in_model_id(void) {
    /* Model id with a slash in it (e.g. "some-vendor/model-a") still
     * matches when the full "<provider>/<id>" composite does. */
    g_assert_true(model_catalog_entry_matches_configured_default(
        "ollama/some-vendor/model-a",
        "some-vendor/model-a",
        "ollama"));
}

/* ── Negative cases ── */

static void test_different_provider_prefix_is_rejected(void) {
    /* "openai/gpt-oss:20b" must NOT match an ollama-hosted entry. */
    g_assert_false(model_catalog_entry_matches_configured_default(
        "openai/gpt-oss:20b", "gpt-oss:20b", "ollama"));
}

static void test_different_bare_id_is_rejected(void) {
    g_assert_false(model_catalog_entry_matches_configured_default(
        "gemma", "gpt-oss:20b", "ollama"));
}

static void test_null_configured_default_is_rejected(void) {
    g_assert_false(model_catalog_entry_matches_configured_default(
        NULL, "gpt-oss:20b", "ollama"));
    g_assert_false(model_catalog_entry_matches_configured_default(
        "", "gpt-oss:20b", "ollama"));
}

static void test_null_or_empty_catalog_id_is_rejected(void) {
    g_assert_false(model_catalog_entry_matches_configured_default(
        "ollama/gpt-oss:20b", NULL, "ollama"));
    g_assert_false(model_catalog_entry_matches_configured_default(
        "ollama/gpt-oss:20b", "", "ollama"));
}

/*
 * When the catalog entry has no provider field, the composite match
 * is impossible and the bare-id comparison is the only path. A
 * provider-prefixed default must not match in that case: we can't
 * prove the provider side of the identity.
 */
static void test_missing_catalog_provider_still_allows_bare_match(void) {
    g_assert_true(model_catalog_entry_matches_configured_default(
        "gpt-oss:20b", "gpt-oss:20b", NULL));
    g_assert_false(model_catalog_entry_matches_configured_default(
        "ollama/gpt-oss:20b", "gpt-oss:20b", NULL));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/model_catalog_match/bare_default_matches_bare_catalog_id",
                    test_bare_default_matches_bare_catalog_id);
    g_test_add_func("/model_catalog_match/provider_prefixed_default_matches_bare_catalog_id",
                    test_provider_prefixed_default_matches_bare_catalog_id);
    g_test_add_func("/model_catalog_match/provider_with_nested_slash_in_model_id",
                    test_provider_with_nested_slash_in_model_id);
    g_test_add_func("/model_catalog_match/different_provider_prefix_is_rejected",
                    test_different_provider_prefix_is_rejected);
    g_test_add_func("/model_catalog_match/different_bare_id_is_rejected",
                    test_different_bare_id_is_rejected);
    g_test_add_func("/model_catalog_match/null_configured_default_is_rejected",
                    test_null_configured_default_is_rejected);
    g_test_add_func("/model_catalog_match/null_or_empty_catalog_id_is_rejected",
                    test_null_or_empty_catalog_id_is_rejected);
    g_test_add_func("/model_catalog_match/missing_catalog_provider_still_allows_bare_match",
                    test_missing_catalog_provider_still_allows_bare_match);
    return g_test_run();
}
