# Home Assistant plugin

WebSocket bridge from OpenClaw to Home Assistant. Owns the long-lived HA
connection, the entity allow-list, and the service deny-list. The kiosk
dashboard view consumes this plugin via the OpenClaw gateway.

Tracking plan: [`docs/plans/2026-05-10-002-feat-home-assistant-kiosk-dashboard-plan.md`](../../docs/plans/2026-05-10-002-feat-home-assistant-kiosk-dashboard-plan.md).
Cross-plan dependency: [`docs/plans/2026-05-10-001-feat-jarvis-the-butler-home-migration-plan.md`](../../docs/plans/2026-05-10-001-feat-jarvis-the-butler-home-migration-plan.md).

> **Status: scaffold (Unit 1).** This package currently ships only the plugin
> manifest, config schema, and credential-reference defaults. No HA WebSocket
> client, state store, or gateway bridge yet -- those land in Units 2, 3, and
> 4 of the kiosk plan.

## Configuration

| Field              | Required | Notes                                                                                                                                                                   |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `homeAssistantUrl` | yes      | Must start with `ws://` or `wss://`. Default: `ws://192.168.2.41:8123/api/websocket`.                                                                                   |
| `tokenRef`         | yes      | Credential reference, never the literal token. Default: `homeAssistant.jarvisKiosk`.                                                                                    |
| `allowList`        | no       | Entity IDs the kiosk is permitted to read. Defaults to `[]` (closed). Slots reference entries in this list.                                                             |
| `denyServiceList`  | no       | Services the kiosk must never call. Defaults to `lock.unlock`, `alarm_control_panel.alarm_disarm`, `cover.open_cover` (matches the Butler-plan HA-user-side deny-list). |
| `slots`            | no       | Map of kiosk slot names (`gauge.battery_soc`, `tile.gate_main`, ...) to allow-listed entity IDs.                                                                        |

The runtime parser enforces three cross-field invariants the manifest's JSON
Schema cannot express:

1. `homeAssistantUrl` must start with `ws://` or `wss://`.
2. Every entry in `denyServiceList` must look like `<domain>.<service>`.
3. Every slot value must reference an entity present in `allowList`.

## HA user (jarvis_kiosk)

The kiosk uses a dedicated non-admin Home Assistant user named `jarvis_kiosk`.
This is a sibling of the `jarvis_butler` user owned by the Jarvis Butler plan,
not a reuse. Two separate users so:

- The kiosk and the agent can rotate independently.
- A compromised tablet cannot use the agent's credentials.
- HA-user-side exposure (Settings -> Voice assistants -> Expose) is curated
  separately for the kiosk and the agent.

The HA-user-side deny-list (locks, alarm-disarm, garage-open) is the safety
net. The client-side `denyServiceList` in this plugin is defense in depth so
a forbidden tile never even issues the call.

## Credential storage

The literal long-lived access token lives under `~/.openclaw/credentials/`,
following the existing OpenClaw credential-storage convention. The plugin
config holds a reference (`tokenRef`), never the token itself. Token rotation
is a credentials-store update, no code change.

## Boundary

- Imports only from `openclaw/plugin-sdk/*` and this package's local barrels
  (`./api.ts`, `./config-schema.ts`, `./register.runtime.ts`,
  `./config-defaults.ts`).
- No deep imports into `src/**`, other extensions, or
  `src/plugin-sdk-internal/**`.
- Per `extensions/CLAUDE.md`: control-plane metadata (manifest + JSON Schema)
  is separated from runtime logic; future units add narrow `*.runtime.ts`
  modules.

## What lands in later units

- **Unit 2:** `ws-client.ts` + `state-store.ts` -- HA WebSocket connection
  lifecycle and entity state cache.
- **Unit 3:** `allowlist.ts` -- centralized allow-list / deny-list gate that
  every consumer (kiosk + future agent path) goes through.
- **Unit 4:** `gateway-bridge.ts` + `src/gateway/protocol/ha-events.ts` --
  bridges HA state and service calls onto the OpenClaw gateway WS via new
  additive `ha:state` and `ha:service-call` topics.

## Tests

```sh
pnpm test extensions/home-assistant
```
