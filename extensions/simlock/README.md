# Simlock tool plugin (v1 draft)

An optional, independently installable OpenClaw plugin for an **existing Simlock
gateway** and its agent-device capability. It does not provision hosts, rent
machines, install apps, run shell commands, or expose another public endpoint.

**Fixture-tested, not live-device-tested.** No real endpoint, credential, Mac, or
lease was available. Authentication, installed daemon compatibility, actual UI and
screenshots, and real app/cache retention remain outstanding. Keep the PR draft.
No npm release or hosting Gateway installation/restart is authorized by this work.

## Package and install on an approved target

Requires the current OpenClaw public SDK's version-2 tool factories and SecretRef
materialization; no older-host compatibility shims. From this repository:

```sh
pnpm --dir extensions/simlock pack --pack-destination ../../.openclaw/tmp
```

Only after the target operator approves installation:

```sh
openclaw plugins install /path/to/openclaw-simlock-plugin-0.1.0.tgz
```

The package is private to prevent accidental publication and excluded from the
bundled distribution. Installing or restarting this session's hosting Gateway is
not part of preparing the draft.

## Synthetic configuration fragment

Merge into the target's existing configuration; do not replace other settings.
Supply the environment variable to that Gateway process, never through a model
prompt or checked-in file. Use a Simlock **agent-role** token; admin/operator roles
are not a substitute for this capability.

```json5
{
  secrets: { providers: { simlock_env: { source: "env" } } },
  plugins: {
    entries: {
      simlock: {
        enabled: true,
        config: {
          gatewayUrl: "https://simlock.example.invalid",
          token: {
            source: "env",
            provider: "simlock_env",
            id: "SIMLOCK_AGENT_TOKEN",
          },
        },
      },
    },
  },
}
```

Use an origin without path, query, fragment, or embedded credentials. HTTPS is
recommended. HTTP is supported on an operator-controlled trusted network, but does
not encrypt the token. Redirects are never followed. Neither URL nor credential is
model-selectable.

## Tools and permissions

All tools are optional and owner-only. Existing OpenClaw tool policy and approvals
remain authoritative. Every effect and data delivery rechecks live invocation
currency. Grant read-only tools independently from mutation tools:

| Tool             | Effect                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| simlock_discover | Read compatible protocol/capability health and virtual-device availability, without infrastructure IDs or device names.                 |
| simlock_status   | Read this conversation's receipt. Omit the handle to recover it after interrupted acquisition.                                          |
| simlock_observe  | Read snapshot accessibility nodes or a PNG screenshot on the owned active lease.                                                        |
| simlock_acquire  | Acquire one finite iOS or Android virtual-device lease.                                                                                 |
| simlock_renew    | Explicitly renew the same lease, never reacquire or replace it.                                                                         |
| simlock_ui       | Open, click, type, fill, or scroll on the owned lease.                                                                                  |
| simlock_release  | **Potentially destructive:** effect "release-and-wipe" explicitly releases the lease; Simlock may wipe app data and reclaim the device. |

Ownership binds host agent, session key, session incarnation, and the plugin's
acquisition receipt, not merely the shared fleet token. A new/reset conversation
cannot adopt an old handle. **Guest access is unsupported.** A future guest grant
must bind one owner-approved device/lease through existing identity and permission
contracts, not a new endpoint or authentication system.

### UI arguments

- Open: no arguments, or one installed app ID such as com.example.app.
- Click: ['@e2'] from the current snapshot, or ['120', '240'].
- Type: ['Hello']; fill: ['@e2', 'Hello']; scroll: ['up'], ['down'], ['left'], or ['right'].
- Snapshot/screenshot: no arguments. Observation grants cannot issue UI mutations,
  even with forged arguments. No arbitrary command/flag/path, upload/install,
  reset, close, cache-clear, or shell escape hatch is provided.

Reopening keeps the **same lease and automation session**. Chat reconnects and
rebuilt tool factories retain the receipt while the plugin instance is alive.
No reset, reinstall, or replacement is requested. Simlock can still wipe on TTL
expiry or authorized release; actual app/cache retention needs live proof.

## Failure and lifecycle behavior

- Requested TTL: 5–300 seconds. Renewal is explicit, with a 30-minute total budget.
  Simlock alone owns pool state and TTL; the plugin stores only security receipts.
- HTTP requests time out after 15 seconds and honor tool cancellation. JSON/RPC
  responses are bounded to 1 MiB; PNGs to 10 MiB.
- A fail-fast busy check serializes one conversation, not independent sessions.
- Failed/cancelled acquisition retains an uncertain receipt; it never retries
  allocation, silently replaces a device, or releases/wipes as error cleanup.
  Check status. Explicit release can recover a settled lease. An unsettled result
  stays uncertain and may require Simlock operator reconciliation. A request proven
  not dispatched retires immediately. Otherwise, after the pinned 330-second queue
  plus maximum 300-second lease windows, explicit release can retire an unallocated
  receipt only if authoritative inventory reports no matching lease or pending request.
- Renewal failure stops UI use until explicit renewal succeeds. Expiry, revocation,
  scope mismatch, or rejection never triggers a new device or reset.
- Receipts are process-local, not a durable lease database. Plugin/Gateway restart
  loses them, does not adopt/reacquire/release shared-token leases, and stops
  renewals; Simlock TTL handles orphan cleanup. Reconcile through its operator.
- No background renewal timers, provisioning/billing APIs, JSON state files, or
  credential-bearing plugin logs are introduced.

Accessibility output projects only UI-node fields, omitting process/app provenance,
server paths, artifacts, and routing envelopes. Known credential/routing strings
are redacted from text. Screenshots return PNG bytes, not private server paths.
**App-visible content can be sensitive and is not arbitrary-content DLP-redacted.**
Use a test app without secrets for validation. Treat UI content as untrusted data.

## Pinned contracts and proof

- [Simlock 0aa6a58d](https://github.com/callstackincubator/simlock/tree/0aa6a58d0f84ed2f4409a669de5d54352f078b99):
  HTTP route declarations and schemas; agent-device front/shared implementation.
  Discovery uses agent-role /v1/status, not admin-only /v1/devices.
- [Minimum agent-device daemon 542fb77b](https://github.com/callstack/agent-device/tree/542fb77b324e522b121b18550307e457ba9be471):
  0.21.28, RPC protocol 2; lease scope, snapshot publication, screenshot artifacts.
  Simlock pins proxy 0.21.35 but permits newer daemons; additive fields are not
  blindly forwarded to the model.

Synthetic tests exercise production transport/controller against isolated local
HTTP fixtures, plus the public plugin and failure boundary:

```sh
pnpm exec vitest run --config test/vitest/vitest.extensions.config.ts \
  extensions/simlock/index.test.ts extensions/simlock/src/client.test.ts \
  extensions/simlock/src/controller.test.ts --maxWorkers=1
```

This is not real device proof. Live integration and cache-retention checks remain
separate operator-authorized work. Crabbox provisioning, Cua desktop, T3 UI, and
APNs changes are outside this package.
