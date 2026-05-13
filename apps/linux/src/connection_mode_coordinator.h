/*
 * connection_mode_coordinator.h
 *
 * Orchestrates the mode-switch workflow.
 *
 * Mirrors macOS ConnectionModeCoordinator.apply() at a high level but
 * adapts the mechanics to the Linux companion's topology:
 *
 *   LOCAL           → stop SSH tunnel, start systemd gateway (if policy
 *                     allows), publish endpoint=idle.
 *   REMOTE + SSH    → stop systemd gateway, ensure SSH tunnel; tunnel
 *                     readiness drives endpoint publication.
 *   REMOTE + DIRECT → stop systemd gateway, stop SSH tunnel, publish
 *                     endpoint=ready with the parsed URL.
 *
 * The coordinator never starts/stops transports itself — gateway_client
 * subscribes to the endpoint and does that work. This keeps gateway_client
 * mode-agnostic and the coordinator declarative.
 *
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#ifndef OPENCLAW_LINUX_CONNECTION_MODE_COORDINATOR_H
#define OPENCLAW_LINUX_CONNECTION_MODE_COORDINATOR_H

#include <glib.h>

#include "gateway_config.h"
#include "gateway_remote_config.h"
#include "product_state.h"

void connection_mode_coordinator_init(void);
void connection_mode_coordinator_shutdown(void);

/*
 * Apply the effective mode based on a loaded GatewayConfig plus the
 * resolver output. Safe to call multiple times; only transitions that
 * change observable behavior emit tunnel/endpoint activity.
 *
 * Passing NULL config or an invalid config is a no-op that preserves
 * the current state (the caller typically gates on config->valid).
 */
void connection_mode_coordinator_apply(const GatewayConfig *config,
                                       ProductConnectionMode effective_mode);

/*
 * Request the coordinator to consider the remote endpoint newly "ready"
 * after a tunnel-state change. Internal use only — wired by the
 * coordinator itself via tunnel subscription.
 */

#endif /* OPENCLAW_LINUX_CONNECTION_MODE_COORDINATOR_H */
