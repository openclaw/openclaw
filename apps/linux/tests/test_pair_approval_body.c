/*
 * test_pair_approval_body.c
 *
 * Headless unit tests for `oc_pair_approval_build_body_markup()` —
 * the pure Pango-markup body builder used by the device-pair approval
 * dialog.
 *
 * The approval dialog sets `body-use-markup=TRUE`, so any unescaped
 * dynamic field is a UI-spoofing / rendering-integrity hazard. These
 * tests assert the escaping contract directly:
 *
 *   - `<`, `>`, `&`, `'`, `"` in every dynamic field are replaced with
 *     their entity references (`&lt;`, `&gt;`, `&amp;`, `&#39;`, `&quot;`).
 *   - raw markup from hostile input (e.g. `<b>evil</b>`) never appears
 *     verbatim in the output.
 *   - the static app-authored wrapper tags (`<b>…</b>`) are still raw
 *     markup on the display_name line.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "../src/device_pair_approval_window.h"

#include <glib.h>
#include <string.h>

/* Small helper that asserts the builder output contains `needle` and
 * does NOT contain `forbidden`, with a nice failure message. */
static void assert_contains(const gchar *haystack, const gchar *needle) {
    if (!haystack || !strstr(haystack, needle)) {
        g_error("expected substring %s not found in:\n%s",
                needle, haystack ? haystack : "(null)");
    }
}

static void assert_not_contains(const gchar *haystack, const gchar *forbidden) {
    if (haystack && strstr(haystack, forbidden)) {
        g_error("forbidden substring %s appeared in:\n%s",
                forbidden, haystack);
    }
}

/*
 * Every character with special meaning in Pango markup is escaped when
 * carried in any dynamic field.
 */
static void test_dynamic_fields_are_markup_escaped(void) {
    const gchar *scopes[] = {"<i>operator.admin</i>", NULL};
    g_autoptr(OcPairRequestInfo) info = oc_pair_request_info_new(
        "req-42",
        "foo & bar",        /* client_id */
        "linux<script>",    /* platform */
        "<b>evil</b>",      /* display_name */
        "\"quoted\" host",  /* host_address */
        NULL,               /* requester_device_id (unused here) */
        scopes);

    g_autofree gchar *body = oc_pair_approval_build_body_markup(info);
    g_assert_nonnull(body);

    /* No raw hostile markup survives. */
    assert_not_contains(body, "<b>evil</b>");
    assert_not_contains(body, "<script>");
    assert_not_contains(body, "<i>operator.admin</i>");

    /* Escaped entities are present instead. */
    assert_contains(body, "&lt;b&gt;evil&lt;/b&gt;");
    assert_contains(body, "foo &amp; bar");
    assert_contains(body, "linux&lt;script&gt;");
    assert_contains(body, "&lt;i&gt;operator.admin&lt;/i&gt;");
    /* g_markup_escape_text emits &quot; for '"'. */
    assert_contains(body, "&quot;quoted&quot; host");
}

/*
 * The app-authored `<b>…</b>` wrapper on display_name is still raw
 * markup — the escaping contract applies only to interpolated dynamic
 * content, not the template.
 */
static void test_static_wrappers_remain_raw_markup(void) {
    const gchar *scopes[] = {"operator.read", NULL};
    g_autoptr(OcPairRequestInfo) info = oc_pair_request_info_new(
        "req-1", "client", "linux", "Operator Mac", "10.0.0.1",
        NULL /* requester_device_id */, scopes);

    g_autofree gchar *body = oc_pair_approval_build_body_markup(info);
    /* The static bold wrapper remains literal markup. */
    assert_contains(body, "<b>Operator Mac</b>");
    /* Benign scope still appears verbatim — there's nothing to escape. */
    assert_contains(body, "operator.read");
    /* Labels are still plain text prefixes. */
    assert_contains(body, "Client: client");
    assert_contains(body, "Platform: linux");
    assert_contains(body, "From: 10.0.0.1");
}

/*
 * Missing / empty dynamic fields are simply omitted from the body —
 * no section header is rendered for them. This guards against accidental
 * label-only rows like "Client: " with empty values.
 */
static void test_missing_fields_are_omitted(void) {
    g_autoptr(OcPairRequestInfo) info = oc_pair_request_info_new(
        "req-empty", NULL, NULL, NULL, NULL, NULL, NULL);

    g_autofree gchar *body = oc_pair_approval_build_body_markup(info);
    g_assert_nonnull(body);
    assert_not_contains(body, "Client:");
    assert_not_contains(body, "Platform:");
    assert_not_contains(body, "From:");
    assert_not_contains(body, "Scopes:");
    /* And crucially: no stray `<b></b>` wrapper around an empty name. */
    assert_not_contains(body, "<b></b>");
}

/*
 * NULL info → empty body, never a crash. The approval dialog reaches
 * this path during shutdown edge cases.
 */
static void test_null_info_returns_empty_body(void) {
    g_autofree gchar *body = oc_pair_approval_build_body_markup(NULL);
    g_assert_nonnull(body);
    g_assert_cmpstr(body, ==, "");
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/pair_approval_body/dynamic_fields_are_markup_escaped",
                    test_dynamic_fields_are_markup_escaped);
    g_test_add_func("/pair_approval_body/static_wrappers_remain_raw_markup",
                    test_static_wrappers_remain_raw_markup);
    g_test_add_func("/pair_approval_body/missing_fields_are_omitted",
                    test_missing_fields_are_omitted);
    g_test_add_func("/pair_approval_body/null_info_returns_empty_body",
                    test_null_info_returns_empty_body);
    return g_test_run();
}
