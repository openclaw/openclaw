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
void gateway_client_request_dependency_refresh(void);
void gateway_client_invalidate_dependencies(gboolean invalidate_models,
                                            gboolean invalidate_agents,
                                            gboolean invalidate_config_audit);

/*
 * Push the locally-persisted Heartbeats intent (`product_state`) to
 * the gateway via the `set-heartbeats` RPC. Safe to call repeatedly;
 * a no-op when WS is not connected.
 *
 * The gateway client invokes this automatically on every WS-connected
 * transition so that operator intent survives gateway restarts and
 * scope upgrades. Other modules may call it after a UI mutation has
 * already updated `product_state`.
 */
void gateway_client_resync_heartbeats_intent(void);

#include "gateway_config.h"
GatewayConfig* gateway_client_get_config(void);

#endif /* OPENCLAW_LINUX_GATEWAY_CLIENT_H */
