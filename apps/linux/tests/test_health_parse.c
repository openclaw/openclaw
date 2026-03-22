#include <glib.h>
#include "../src/health_helpers.h"

static void test_single_target_success(void) {
    ProbeState ps = {0};
    health_parse_probe_stdout("Connect: ok\nRPC: ok\n", &ps);
    g_assert_true(ps.reachable);
    g_assert_true(ps.connect_ok);
    g_assert_true(ps.rpc_ok);
    g_assert_cmpstr(ps.summary, ==, "Fully reachable");
    g_free(ps.summary);
}

static void test_single_target_connect_success_no_rpc(void) {
    ProbeState ps = {0};
    health_parse_probe_stdout("Connect: ok\nRPC: failed\n", &ps);
    g_assert_true(ps.reachable);
    g_assert_true(ps.connect_ok);
    g_assert_false(ps.rpc_ok);
    g_assert_cmpstr(ps.summary, !=, "Fully reachable");
    g_free(ps.summary);
}

static void test_single_target_failure(void) {
    ProbeState ps = {0};
    health_parse_probe_stdout("Connect: failed\n", &ps);
    g_assert_false(ps.reachable);
    g_assert_false(ps.connect_ok);
    g_assert_false(ps.rpc_ok);
    g_assert_cmpstr(ps.summary, ==, "Not reachable");
    g_free(ps.summary);
}

static void test_multi_target_mixed_output(void) {
    ProbeState ps = {0};
    health_parse_probe_stdout("Target 1:\nConnect: failed\nTarget 2:\nConnect: ok\nRPC: ok\n", &ps);
    g_assert_true(ps.reachable);
    g_assert_true(ps.connect_ok);
    g_assert_true(ps.rpc_ok);
    g_free(ps.summary);
}

static void test_multi_target_mixed_ordering(void) {
    ProbeState ps = {0};
    health_parse_probe_stdout("Target 1:\nConnect: ok\nRPC: failed\nTarget 2:\nConnect: ok\nRPC: ok\n", &ps);
    g_assert_true(ps.reachable);
    g_assert_true(ps.connect_ok);
    g_assert_true(ps.rpc_ok); // The successful RPC from Target 2 counts
    g_free(ps.summary);
}

static void test_timeout_detection(void) {
    ProbeState ps1 = {0};
    health_parse_probe_stdout("Connect: ok\nRPC: timeout\n", &ps1);
    g_assert_true(ps1.timed_out);
    g_assert_true(ps1.connect_ok);
    g_assert_cmpstr(ps1.summary, ==, "Connect OK, but RPC timed out");
    g_free(ps1.summary);
    
    ProbeState ps2 = {0};
    health_parse_probe_stdout("Connect: timed out\n", &ps2);
    g_assert_true(ps2.timed_out);
    g_free(ps2.summary);
}

static void test_timeout_wording_variants(void) {
    ProbeState ps1 = {0};
    health_parse_probe_stdout("Connect: timeout\n", &ps1);
    g_assert_true(ps1.timed_out);
    g_free(ps1.summary);
    
    ProbeState ps2 = {0};
    health_parse_probe_stdout("RPC: timed out\n", &ps2);
    g_assert_true(ps2.timed_out);
    g_free(ps2.summary);
}

static void test_ignoring_unrelated_lines(void) {
    ProbeState ps = {0};
    health_parse_probe_stdout("Starting probe...\nHere is some explanatory text\nConnect: ok\nRPC: ok\nDone.\n", &ps);
    g_assert_true(ps.reachable);
    g_assert_true(ps.connect_ok);
    g_assert_true(ps.rpc_ok);
    g_free(ps.summary);
}

static void test_ignoring_unrelated_rpc_connect_wording(void) {
    ProbeState ps = {0};
    health_parse_probe_stdout("previous RPC: ok result cached\nConnect: retry scheduled\n", &ps);
    g_assert_false(ps.reachable);
    g_assert_false(ps.connect_ok);
    g_assert_false(ps.rpc_ok);
    g_assert_cmpstr(ps.summary, ==, "Not reachable");
    g_free(ps.summary);
}

static void test_malformed_lines(void) {
    ProbeState ps = {0};
    health_parse_probe_stdout("Connect:\nRPC: \n: ok\n", &ps);
    g_assert_false(ps.reachable);
    g_assert_false(ps.connect_ok);
    g_assert_false(ps.rpc_ok);
    g_free(ps.summary);
}

static void test_whitespace_heavy_output(void) {
    ProbeState ps = {0};
    health_parse_probe_stdout("   \n  Connect: ok  \n\n\tRPC: ok\t\n", &ps);
    g_assert_true(ps.reachable);
    g_assert_true(ps.connect_ok);
    g_assert_true(ps.rpc_ok);
    g_free(ps.summary);
}

static void test_no_summary_lines_safety(void) {
    ProbeState ps1 = {0};
    health_parse_probe_stdout("", &ps1);
    g_assert_false(ps1.reachable);
    g_assert_false(ps1.connect_ok);
    g_assert_false(ps1.rpc_ok);
    g_assert_false(ps1.timed_out);
    g_assert_cmpstr(ps1.summary, ==, "Not reachable");
    g_free(ps1.summary);

    ProbeState ps2 = {0};
    health_parse_probe_stdout(NULL, &ps2);
    g_assert_false(ps2.reachable);
    g_assert_false(ps2.connect_ok);
    g_assert_false(ps2.rpc_ok);
    g_assert_false(ps2.timed_out);
    g_assert_cmpstr(ps2.summary, ==, "No output from probe");
    g_free(ps2.summary);
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    
    g_test_add_func("/health_parse/single_target_success", test_single_target_success);
    g_test_add_func("/health_parse/single_target_connect_success_no_rpc", test_single_target_connect_success_no_rpc);
    g_test_add_func("/health_parse/single_target_failure", test_single_target_failure);
    g_test_add_func("/health_parse/multi_target_mixed_output", test_multi_target_mixed_output);
    g_test_add_func("/health_parse/multi_target_mixed_ordering", test_multi_target_mixed_ordering);
    g_test_add_func("/health_parse/timeout_detection", test_timeout_detection);
    g_test_add_func("/health_parse/timeout_wording_variants", test_timeout_wording_variants);
    g_test_add_func("/health_parse/ignoring_unrelated_lines", test_ignoring_unrelated_lines);
    g_test_add_func("/health_parse/ignoring_unrelated_rpc_connect_wording", test_ignoring_unrelated_rpc_connect_wording);
    g_test_add_func("/health_parse/malformed_lines", test_malformed_lines);
    g_test_add_func("/health_parse/whitespace_heavy_output", test_whitespace_heavy_output);
    g_test_add_func("/health_parse/no_summary_lines_safety", test_no_summary_lines_safety);
    
    return g_test_run();
}
