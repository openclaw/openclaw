/*
 * test_markdown_render.c
 * Description: Unit tests for markdown rendering and escaping helpers.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>

#include "../src/markdown_render.h"

static void test_escape_chars(void) {
    g_autofree gchar *e = markdown_escape_pango("a < b & c > d \"x\" it's");
    g_assert_cmpstr(e, ==, "a &lt; b &amp; c &gt; d &quot;x&quot; it&apos;s");
}

static void test_plain_text(void) {
    g_autofree gchar *p = markdown_to_pango("hello world");
    g_assert_cmpstr(p, ==, "hello world");
}

static void test_bold_italic_code(void) {
    g_autofree gchar *p = markdown_to_pango("**bold** *italic* `code`");
    g_assert_nonnull(strstr(p, "<b>bold</b>"));
    g_assert_nonnull(strstr(p, "<i>italic</i>"));
    g_assert_nonnull(strstr(p, "<tt>code</tt>"));
}

static void test_heading_and_list(void) {
    g_autofree gchar *p = markdown_to_pango("# Title\n- item");
    g_assert_nonnull(strstr(p, "xx-large"));
    g_assert_nonnull(strstr(p, " • item"));
}

static void test_raw_html_sanitized(void) {
    g_autofree gchar *p = markdown_to_pango("<script>alert(1)</script>");
    g_assert_null(strstr(p, "<script>"));
    g_assert_nonnull(strstr(p, "&lt;script&gt;"));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/markdown_render/escape", test_escape_chars);
    g_test_add_func("/markdown_render/plain", test_plain_text);
    g_test_add_func("/markdown_render/inline", test_bold_italic_code);
    g_test_add_func("/markdown_render/heading_list", test_heading_and_list);
    g_test_add_func("/markdown_render/html_sanitized", test_raw_html_sanitized);

    return g_test_run();
}
