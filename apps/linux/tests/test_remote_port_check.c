/*
 * test_remote_port_check.c
 *
 * Lightweight OS-level checks. These tests probe ephemeral ports to
 * exercise bind and connect helpers. They are inherently host-
 * sensitive; the suite guards with skip paths when the environment
 * cannot support the expectation.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include <glib.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#include <string.h>

#include "../src/remote_port_check.h"

static gint bind_ephemeral_listener(gint *out_port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    g_assert_cmpint(fd, >=, 0);

    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = 0;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    g_assert_cmpint(bind(fd, (struct sockaddr *)&addr, sizeof(addr)), ==, 0);
    g_assert_cmpint(listen(fd, 4), ==, 0);

    socklen_t slen = sizeof(addr);
    g_assert_cmpint(getsockname(fd, (struct sockaddr *)&addr, &slen), ==, 0);
    *out_port = ntohs(addr.sin_port);
    return fd;
}

static void test_free_port_is_free(void) {
    /* Grab a port, close immediately — the port is highly likely to
     * remain free for the subsequent probe window. */
    gint port = 0;
    gint fd = bind_ephemeral_listener(&port);
    close(fd);
    g_assert_true(remote_port_check_loopback_free(port));
}

static void test_bound_port_is_not_free(void) {
    gint port = 0;
    gint fd = bind_ephemeral_listener(&port);
    g_assert_false(remote_port_check_loopback_free(port));
    close(fd);
}

static void test_listener_is_reachable(void) {
    gint port = 0;
    gint fd = bind_ephemeral_listener(&port);
    g_assert_true(remote_port_check_loopback_listening(port, 500));
    close(fd);
}

static void test_unlistened_port_is_not_reachable(void) {
    gint port = 0;
    gint fd = bind_ephemeral_listener(&port);
    close(fd);
    g_assert_false(remote_port_check_loopback_listening(port, 200));
}

static void test_invalid_ports(void) {
    g_assert_false(remote_port_check_loopback_free(0));
    g_assert_false(remote_port_check_loopback_free(-1));
    g_assert_false(remote_port_check_loopback_free(70000));
    g_assert_false(remote_port_check_loopback_listening(0, 100));
    g_assert_false(remote_port_check_loopback_listening(70000, 100));
}

int main(int argc, char **argv) {
    g_test_init(&argc, &argv, NULL);
    g_test_add_func("/remote_port_check/free_port_is_free", test_free_port_is_free);
    g_test_add_func("/remote_port_check/bound_port_is_not_free", test_bound_port_is_not_free);
    g_test_add_func("/remote_port_check/listener_is_reachable", test_listener_is_reachable);
    g_test_add_func("/remote_port_check/unlistened_port_is_not_reachable", test_unlistened_port_is_not_reachable);
    g_test_add_func("/remote_port_check/invalid_ports", test_invalid_ports);
    return g_test_run();
}
