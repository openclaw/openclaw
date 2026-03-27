/*
 * gateway_client.h
 *
 * Gateway client orchestrator for the OpenClaw Linux Companion App.
 *
 * Coordinates config resolution, HTTP health checking, and WebSocket
 * lifecycle into a unified runtime state published to the state machine.
 * After this module is initialized, the runtime source of truth for
 * gateway reachability and protocol status is the native HTTP/WebSocket
 * client, while systemd remains only the service lifecycle/control source.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_GATEWAY_CLIENT_H
#define OPENCLAW_LINUX_GATEWAY_CLIENT_H

#include <glib.h>

void gateway_client_init(void);
void gateway_client_refresh(void);
void gateway_client_shutdown(void);
gboolean gateway_client_is_connected(void);

#endif /* OPENCLAW_LINUX_GATEWAY_CLIENT_H */
