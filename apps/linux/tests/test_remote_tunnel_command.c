/*
 * test_remote_tunnel_command.c
 *
 * Exercises the argv contract of the SSH control tunnel command
 * builder. These tests deliberately avoid any spawn side effects:
 * argv is the contract.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <string.h>

#include "../src/remote_tunnel_command.h"

static gboolean has_arg(gchar **argv, const gchar *s) {
    for (gchar **p = argv; *p; p++) {
        if (strcmp(*p, s) == 0) return TRUE;
    }
    return FALSE;
}

static gssize index_of(gchar **argv, const gchar *s) {
    for (gssize i = 0; argv[i]; i++) {
        if (strcmp(argv[i], s) == 0) return i;
    }
    return -1;
}

static void test_build_minimal(void) {
    RemoteTunnelCommandSpec spec = {
        .ssh_host = "host.example",
        .local_port = 18789,
        .remote_port = 18789,
    };
    g_auto(GStrv) argv = remote_tunnel_command_build(&spec);
    g_assert_nonnull(argv);
    g_assert_cmpstr(argv[0], ==, "/usr/bin/ssh");
    g_assert_true(has_arg(argv, "-N"));
    g_assert_true(has_arg(argv, "ExitOnForwardFailure=yes"));
    g_assert_true(has_arg(argv, "BatchMode=yes"));
    g_assert_true(has_arg(argv, "ServerAliveInterval=15"));
    g_assert_true(has_arg(argv, "StrictHostKeyChecking=accept-new"));

    /* -L <local>:127.0.0.1:<remote> */
    gssize l_idx = index_of(argv, "-L");
    g_assert_cmpint(l_idx, >, 0);
    g_assert_cmpstr(argv[l_idx + 1], ==, "18789:127.0.0.1:18789");

    /* target at the very end (no flags after the target) */
    gssize last = 0;
    while (argv[last + 1]) last++;
    g_assert_cmpstr(argv[last], ==, "host.example");
}

static void test_build_with_user_identity_port(void) {
    RemoteTunnelCommandSpec spec = {
        .ssh_user = "alice",
        .ssh_host = "host.example",
        .ssh_port = 2200,
        .ssh_identity = "/home/a/.ssh/id_ed25519",
        .local_port = 18790,
        .remote_port = 18789,
    };
    g_auto(GStrv) argv = remote_tunnel_command_build(&spec);
    g_assert_nonnull(argv);

    gssize p_idx = index_of(argv, "-p");
    g_assert_cmpint(p_idx, >, 0);
    g_assert_cmpstr(argv[p_idx + 1], ==, "2200");

    gssize i_idx = index_of(argv, "-i");
    g_assert_cmpint(i_idx, >, 0);
    g_assert_cmpstr(argv[i_idx + 1], ==, "/home/a/.ssh/id_ed25519");

    /* target at end is alice@host.example */
    gssize last = 0;
    while (argv[last + 1]) last++;
    g_assert_cmpstr(argv[last], ==, "alice@host.example");

    gssize l_idx = index_of(argv, "-L");
    g_assert_cmpstr(argv[l_idx + 1], ==, "18790:127.0.0.1:18789");
}

static void test_build_default_port_omits_p(void) {
    RemoteTunnelCommandSpec spec = {
        .ssh_host = "host.example",
        .ssh_port = 22,
        .local_port = 18789,
        .remote_port = 18789,
    };
    g_auto(GStrv) argv = remote_tunnel_command_build(&spec);
    g_assert_nonnull(argv);
    g_assert_false(has_arg(argv, "-p"));
}

static void test_build_rejects_missing_host(void) {
    RemoteTunnelCommandSpec spec = {
        .local_port = 18789,
        .remote_port = 18789,
    };
    g_assert_null(remote_tunnel_command_build(&spec));
}

static void test_build_rejects_leading_dash_host(void) {
    RemoteTunnelCommandSpec spec = {
        .ssh_host = "-oProxyJump=evil",
        .local_port = 18789,
        .remote_port = 18789,
    };
    g_assert_null(remote_tunnel_command_build(&spec));
}

static void test_build_rejects_invalid_ports(void) {
    RemoteTunnelCommandSpec spec = {
        .ssh_host = "host.example",
        .local_port = 0,
        .remote_port = 18789,
    };
    g_assert_null(remote_tunnel_command_build(&spec));

    spec.local_port = 18789;
    spec.remote_port = 70000;
    g_assert_null(remote_tunnel_command_build(&spec));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/remote_tunnel_command/build_minimal", test_build_minimal);
    g_test_add_func("/remote_tunnel_command/build_with_user_identity_port", test_build_with_user_identity_port);
    g_test_add_func("/remote_tunnel_command/build_default_port_omits_p", test_build_default_port_omits_p);
    g_test_add_func("/remote_tunnel_command/rejects_missing_host", test_build_rejects_missing_host);
    g_test_add_func("/remote_tunnel_command/rejects_leading_dash_host", test_build_rejects_leading_dash_host);
    g_test_add_func("/remote_tunnel_command/rejects_invalid_ports", test_build_rejects_invalid_ports);
    return g_test_run();
}
