/*
 * test_format_utils.c
 * Description: Unit tests for shared UI formatting helpers.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>

#include "../src/format_utils.h"

static void test_format_size(void) {
    g_autofree gchar *a = format_size_bytes(512);
    g_autofree gchar *b = format_size_bytes(2048);
    g_autofree gchar *c = format_size_bytes(5 * 1024 * 1024ULL);

    g_assert_cmpstr(a, ==, "512 B");
    g_assert_true(g_str_has_suffix(b, "KB"));
    g_assert_true(g_str_has_suffix(c, "MB"));
}

static void test_format_money(void) {
    g_autofree gchar *a = format_money_usd(125.12);
    g_autofree gchar *b = format_money_usd(3.14159);
    g_autofree gchar *c = format_money_usd(0.123456);

    g_assert_cmpstr(a, ==, "125.12");
    g_assert_cmpstr(b, ==, "3.142");
    g_assert_cmpstr(c, ==, "0.1235");
}

static void test_format_count(void) {
    g_autofree gchar *a = format_compact_count(999);
    g_autofree gchar *b = format_compact_count(1200);
    g_autofree gchar *c = format_compact_count(40200);
    g_autofree gchar *d = format_compact_count(3100000);

    g_assert_cmpstr(a, ==, "999");
    g_assert_cmpstr(b, ==, "1.2k");
    g_assert_cmpstr(c, ==, "40k");
    g_assert_cmpstr(d, ==, "3.1M");
}

static void test_format_reset_time(void) {
    g_autofree gchar *a = format_reset_time_ms(100000, 200000);
    g_autofree gchar *b = format_reset_time_ms(3600000 + 120000, 0);
    g_autofree gchar *c = format_reset_time_ms(45000, 0);

    g_assert_cmpstr(a, ==, "reset due");
    g_assert_true(g_str_has_prefix(b, "resets in 1h"));
    g_assert_true(g_str_has_prefix(c, "resets in"));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);

    g_test_add_func("/format_utils/size", test_format_size);
    g_test_add_func("/format_utils/money", test_format_money);
    g_test_add_func("/format_utils/count", test_format_count);
    g_test_add_func("/format_utils/reset_time", test_format_reset_time);

    return g_test_run();
}
