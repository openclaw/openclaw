# Home Assistant plugin

WebSocket bridge from OpenClaw to Home Assistant. Owns the long-lived HA
connection, the entity allow-list, and the service deny-list. The kiosk
dashboard view consumes this plugin via the OpenClaw gateway.

Tracking plan: [`docs/plans/2026-05-10-002-feat-home-assistant-kiosk-dashboard-plan.md`](../../docs/plans/2026-05-10-002-feat-home-assistant-kiosk-dashboard-plan.md).
Cross-plan dependency: [`docs/plans/2026-05-10-001-feat-jarvis-the-butler-home-migration-plan.md`](../../docs/plans/2026-05-10-001-feat-jarvis-the-butler-home-migration-plan.md).

> **Status: bridge landed (Units 1 + 2 + 3 + 4).** This package now ships
> the manifest, config schema, defaults, the long-lived HA WebSocket
> client, the entity state store, the allow-list / deny-list gate, and
> the gateway bridge that exposes the kiosk-facing methods on the
> OpenClaw gateway WS. The remaining piece for v1 ship is wiring
> `register.runtime.ts` to actually instantiate the WS client with a
> resolved long-lived token from `~/.openclaw/credentials/` and call
> `attachHomeAssistantBridge` -- the bridge logic and primitives are
> all in place and exported through `./api.ts`.

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

## Gateway bridge (`gateway-bridge.ts`)

The kiosk view talks to this plugin entirely through the existing OpenClaw
gateway WebSocket. No new core protocol files were needed -- plugin
broadcasts already use the `plugin.*` namespace and `registerGatewayMethod`
accepts arbitrary string method names.

| Direction                 | Wire name                     | Scope            | Payload shape                                                                                                                                     |
| ------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ha:subscribe` request    | `home-assistant.subscribe`    | `operator.read`  | `{}` -> `{ snapshot: [{ entity_id, state }] }`. Captures the broadcast function and returns the current cached snapshot of allow-listed entities. |
| `ha:state` push           | `plugin.home-assistant.state` | (operator/admin) | `{ entity_id, prev, next }` for every state-store diff after subscribe.                                                                           |
| `ha:service-call` request | `home-assistant.serviceCall`  | `operator.write` | `{ domain, service, target, serviceData? }` -> `{ dispatched: true }` on success, structured error otherwise.                                     |

Validation order on `home-assistant.serviceCall`:

1. `target` present and non-empty -> else `invalid_params`.
2. `domain.service` passes `checkServiceCall` (deny-list + format checks)
   -> else `service-denied`.
3. `target` is in `allowList` -> else `entity-denied`.
4. Dispatch via `ws-client.callService(...)`. WS-client failures surface as
   `ha_call_failed`.

> **Plan deviation recorded.** The original plan called for adding `ha:state`
> and `ha:service-call` to `src/gateway/protocol/`. After inspecting the
> gateway, plugin broadcasts already use the `plugin.*` namespace
> (`src/gateway/server-broadcast.ts`) and method handlers register against
> arbitrary names (`OpenClawPluginApi.registerGatewayMethod`). No core
> protocol additions were needed; the bridge stays fully extension-local
> per `extensions/CLAUDE.md` boundary rules.

## v1 ship: wiring `register.runtime.ts`

The bridge is built and tested; the last step is wiring it on plugin
register. Pseudo-shape:

```ts
// extensions/home-assistant/register.runtime.ts (v1 ship)
const config = resolveHomeAssistantConfig(api);
if (!config) return;                // not configured -> no-op
const token = await resolveCredential(config.tokenRef);
const store = new HomeAssistantStateStore({ allowList: config.allowList });
const client = new HomeAssistantClient({ url: config.homeAssistantUrl, token, store, ... });
attachHomeAssistantBridge({ api, store, client, config });
client.start();
```

Credential resolution follows the existing channel/provider pattern under
`~/.openclaw/credentials/` -- not landed in this unit.

## Allow-list / deny-list gate (`allowlist.ts`)

- `isEntityAllowed(entityId, config)` -> boolean. Empty `allowList` denies
  everything (fail-closed). Whitespace-trimmed but case-sensitive: HA emits
  lowercase entity IDs, so mixed-case operator typos surface as a config
  error rather than silent coercion.
- `checkServiceCall({domain, service}, config)` -> structured allow/deny
  result. Deny carries `{kind: "service-denied", domain, service, detail}`
  for the bridge to echo back to the kiosk.
- v1 policy is **deny-list-authoritative**: a service is allowed unless the
  exact `<domain>.<service>` form is in `denyServiceList`. The HA-user-side
  deny-list documented in the Butler plan is the actual safety net; this
  gate is belt-and-braces.
- **Future hardening (deferred):** add `HomeAssistantConfig.allowServiceList`.
  When present + non-empty, the gate switches to deny-by-default. Deny-list
  precedence is preserved (deny wins). Tests under "future hardening guard"
  in `allowlist.test.ts` lock that contract.

## WS client overview (`ws-client.ts`)

```text
idle -> connecting -> authenticating -> subscribed
                                          | (heartbeat miss / drop)
                                          v
                                       degraded -- reconnect (1s..30s exp) --> connecting
```

- **Server-relayed transport.** The browser never holds the HA token; only
  this client does. Future Unit 4 publishes filtered state onto the OpenClaw
  gateway WS.
- **Reconnect.** Exponential backoff `min(maxDelayMs, baseDelayMs * 2^(n-1))`.
  Defaults: base 1s, cap 30s. Counter resets on successful subscribe.
- **Heartbeat.** Application-level `ping`/`pong` with id matching. Default
  interval 30s, timeout 10s. Pong timeout recycles the socket.
- **State store reset on resubscribe.** After a connection drop, the next
  successful subscribe flushes the store so downstream consumers see a clean
  refill rather than a stale cache.
- **Auth invalid is terminal.** `auth_invalid` transitions to `degraded`
  without scheduling a reconnect -- the operator must rotate the credential.
- **Injectable everything.** WS factory, store, clock, timers, and logger
  are all options so tests are deterministic and the same module works under
  Node 22 (`globalThis.WebSocket`) and the `ws` package.

## Tests

```sh
pnpm test extensions/home-assistant
```
