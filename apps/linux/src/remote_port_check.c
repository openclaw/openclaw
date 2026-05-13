/*
 * remote_port_check.c
 *
 * Loopback bind/connect probes used to decide whether a port is safe
 * to request from ssh, or whether a previously-adopted tunnel is still
 * serving.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "remote_port_check.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

static gboolean try_bind_v4(gint port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return FALSE;

    int one = 1;
    (void)setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    int rc = bind(fd, (struct sockaddr *)&addr, sizeof(addr));
    close(fd);
    return rc == 0;
}

static gboolean try_bind_v6(gint port) {
    int fd = socket(AF_INET6, SOCK_STREAM, 0);
    if (fd < 0) {
        /* No IPv6 stack: treat as success (IPv4 decision dominates). */
        return TRUE;
    }

    int one = 1;
    (void)setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    /* Only bind the v6 slot of a dual stack, leaving v4 to try_bind_v4(). */
    (void)setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &one, sizeof(one));

    struct sockaddr_in6 addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin6_family = AF_INET6;
    addr.sin6_port = htons((uint16_t)port);
    addr.sin6_addr = in6addr_loopback;

    int rc = bind(fd, (struct sockaddr *)&addr, sizeof(addr));
    close(fd);
    return rc == 0;
}

gboolean remote_port_check_loopback_free(gint port) {
    if (port <= 0 || port > 65535) return FALSE;
    return try_bind_v4(port) && try_bind_v6(port);
}

gboolean remote_port_check_loopback_listening(gint port, gint timeout_ms) {
    if (port <= 0 || port > 65535) return FALSE;
    if (timeout_ms < 0) timeout_ms = 0;

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return FALSE;

    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
        close(fd);
        return FALSE;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    int rc = connect(fd, (struct sockaddr *)&addr, sizeof(addr));
    gboolean connected = FALSE;
    if (rc == 0) {
        connected = TRUE;
    } else if (errno == EINPROGRESS) {
        struct pollfd pfd = { .fd = fd, .events = POLLOUT, .revents = 0 };
        int pr = poll(&pfd, 1, timeout_ms);
        if (pr > 0 && (pfd.revents & POLLOUT)) {
            int err = 0;
            socklen_t slen = sizeof(err);
            if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &slen) == 0 && err == 0) {
                connected = TRUE;
            }
        }
    }

    close(fd);
    return connected;
}

gint remote_port_check_pick_loopback_port(void) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 0;

    int one = 1;
    (void)setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = 0; /* let the kernel pick */
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return 0;
    }

    struct sockaddr_in got;
    socklen_t got_len = sizeof(got);
    if (getsockname(fd, (struct sockaddr *)&got, &got_len) != 0) {
        close(fd);
        return 0;
    }
    close(fd);
    return (gint)ntohs(got.sin_port);
}
