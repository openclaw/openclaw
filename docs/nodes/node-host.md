---
summary: "Start a headless or service node host, pair it, and use its system commands"
read_when:
  - Running commands on a machine other than the Gateway host
  - Installing the node host as a service or over an SSH tunnel
  - Checking node host identity state or system command behavior
title: "Run a node host"
sidebarTitle: "Node host"
---

## Remote node host (system.run)

Use a **node host** when your Gateway runs on one machine and you want commands to execute on another. The model still talks to the **gateway**; the gateway forwards `exec` calls to the **node host** when `host=node` is selected.

| Role         | Responsibility                                                                           |
| ------------ | ---------------------------------------------------------------------------------------- |
| Gateway host | Receives messages, runs the model, routes tool calls.                                    |
| Node host    | Executes `system.run`/`system.which` on the node machine.                                |
| Approvals    | Enforced on the node host via `~/.openclaw/state/openclaw.sqlite#exec_approvals_config`. |

Approval note:

- Approval-backed node runs bind exact request context. The exec path prepares a canonical `systemRunPlan` before approval; once granted, the gateway forwards that stored plan, not any later caller-edited command/cwd/session fields, and re-validates the working directory before running.
- For direct shell/runtime file executions, OpenClaw also best-effort binds one concrete local file operand and denies the run if that file changes before execution.
- If OpenClaw cannot identify exactly one concrete local file for an interpreter/runtime command, approval-backed execution is denied instead of pretending full runtime coverage. Use sandboxing, separate hosts, or an explicit trusted allowlist/full workflow for broader interpreter semantics.

### Gateway deployments that cannot host nodes

A Gateway can remain healthy for browser users while node hosting is unavailable. Run `openclaw doctor` on the Gateway before onboarding nodes, and check these preconditions:

- **Machine authentication:** Tailscale identity headers do not authenticate node-role connections. In `gateway.auth.mode: "trusted-proxy"`, a new node also cannot supply the proxy's user identity headers. To use a shared token, switch to token mode and configure `gateway.auth.token` with a SecretRef; trusted-proxy mode rejects mixed token configuration. A trusted-proxy Gateway can use `gateway.auth.password` only for clean loopback/direct callers. See [trusted-proxy mixed token configuration](/gateway/trusted-proxy-auth#mixed-token-configuration).
- **Node onboarding URL:** With only the default `gateway.bind: "loopback"` and no advertised endpoint, `openclaw devices join-code` reports: `Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.` Configure a reachable endpoint through Tailscale Serve, `gateway.remote.url`, or `plugins.entries.device-pair.config.publicUrl`. Remote join URLs require TLS; enabling LAN bind alone does not enable plaintext remote join URLs. Explicitly configured loopback endpoints can produce HTTP join URLs, but the joining machine must be able to reach that loopback endpoint, for example through a local tunnel. Plaintext LAN pairing can use a setup code directly.
- **Node onboarding support:** Join-code creation and `/j` redemption are core Gateway operations. They do not require enabling the `device-pair` plugin, even though its retained `publicUrl` configuration field can supply an endpoint. See [Join codes](/cli/devices#openclaw-devices-join-code) for the printed `npx openclaw connect <url>` command.
- **Device session runtime:** Paired-device runners support the embedded OpenClaw runtime and explicitly authorized Codex `remote-exec`; ACPX routes cannot dispatch to a paired device. Codex requires `codex.exec-server.stdio.v1` in `gateway.nodes.commands.allow` plus its normal pairing and invocation approvals. Runtime policy belongs on provider/model routes, not the ignored whole-agent runtime keys. Multi-agent rosters must also set `agents.ownership: "explicit"`. See [Codex paired-device placement](/plugins/codex-harness/placement#run-codex-on-a-paired-device) and [runtime policy](/gateway/config-agents/runtime-and-cli-backends#runtime-policy).
- **Edge routing:** When a reverse proxy or access edge fronts the Gateway, the node must satisfy edge auth on the join request, its main Gateway WebSocket, and the worker WebSocket. Keep WebSocket upgrade enabled for `/__openclaw__/worker`. You can instead exempt `/j/*` and `/__openclaw__/worker` from edge identity auth because both routes enforce their own short-lived credentials. See [worker protocol](/gateway/protocol/handshake#worker-role-and-closed-protocol).

For a Cloudflare Access-fronted Gateway:

1. In Cloudflare Zero Trust, create an Access service token. Copy its Client ID and Client Secret when Cloudflare displays them.
2. Add a **Service Auth** policy that accepts the token on the Access application protecting the Gateway. If `/j/*` and `/__openclaw__/worker` are separate Access applications, add the same policy to both.
3. On the node, provide the conventional environment fallback and connect:

   ```bash
   export CF_ACCESS_CLIENT_ID="<client-id>"
   export CF_ACCESS_CLIENT_SECRET="<client-secret>"
   openclaw connect https://gateway.example/j/<code> --service
   ```

The canonical node connection keys are `gateway.cloudflareAccess.clientId` and `gateway.cloudflareAccess.clientSecret`; both accept SecretInput values. The environment fallback above persists those keys as env SecretRefs, not copied plaintext. For installed nodes, OpenClaw stores the environment values in the managed service environment file rather than inline in launchd, systemd, or Task Scheduler definitions. Resolved values are bound to the configured Gateway origin and are not followed across redirects. OpenClaw rejects the pair before resolution on plaintext `http://` or `ws://` routes; credential-free loopback and private-network plaintext behavior is unchanged.

### Start a node host (foreground)

On the node machine:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

For one-paste setup, create a **Node host** setup link from the Control UI
Devices page, then run its copyable command on the node machine:

```bash
openclaw node run --pair "oc-pair://<setup-code>"
```

The link is single-use and expires after 10 minutes. It supplies the endpoint,
bootstrap token, TLS mode, and certificate pin when available. Explicit
gateway flags override the corresponding `--pair` values. Administrator-minted
bootstrap enrollment approves the device and its first declared command surface,
including `system.run` and `system.which` when declared. Later command,
capability, or permission expansion still creates an approval request.
Gateway command policy and the node host's [exec approvals](/tools/exec-approvals)
still apply. Local exec approvals default to `full` with `ask: "off"`; configure
them before using the link if that access is too broad. See
[Node pairing](/gateway/pairing#one-paste-node-pairing).

`node run` also accepts `--pair`, `--context-path` (Gateway WS context path), `--tls`, `--tls-fingerprint <sha256>`, and `--node-id` (override the legacy client instance ID; this does not reset pairing). On macOS, pass `--share-installed-apps` to advertise `device.apps`; sharing is off by default. Use `--no-share-installed-apps` to disable a previously saved opt-in.

### Remote gateway via SSH tunnel (loopback bind)

If the Gateway binds to loopback (`gateway.bind=loopback`, default in local mode), remote node hosts cannot connect directly. Create an SSH tunnel and point the node host at the local end of the tunnel.

Example (node host -> gateway host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Notes:

- `openclaw node run` supports token or password auth.
- Env vars are preferred: `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`.
- Config fallback is `gateway.auth.token` / `gateway.auth.password`.
- In local mode, node host intentionally ignores `gateway.remote.token` / `gateway.remote.password`.
- In remote mode, `gateway.remote.token` / `gateway.remote.password` are eligible per remote precedence rules.
- If active local `gateway.auth.*` SecretRefs are configured but unresolved, node-host auth fails closed.
- Node-host auth resolution only honors `OPENCLAW_GATEWAY_*` env vars.

### Start a node host (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node start
openclaw node restart
```

`node install` also accepts `--context-path`, `--tls`, `--tls-fingerprint`, `--node-id` (legacy client instance ID only), `--share-installed-apps` / `--no-share-installed-apps`, `--runtime <node|bun>` (default: `node`), and `--force` to reinstall. Bun requires version 1.4+ with WAL-reset-safe `node:sqlite` and is an explicit opt-in; Node remains recommended. `node status`, `node stop`, and `node uninstall` are also available.

### Pair + name

On the Gateway host, approve the device request:

```bash
openclaw devices list
openclaw devices approve <deviceRequestId>
```

If the node retries with changed auth details, re-run `openclaw devices list` and approve the current `requestId`.

Restart an installed node with `openclaw node restart`, or stop and rerun its
foreground `openclaw node run` command. A node paused on `PAIRING_REQUIRED`
does not resume automatically after manual approval. Its reconnect creates a
separate command-surface request. On the Gateway:

```bash
openclaw nodes pending
openclaw nodes approve <nodeRequestId>
openclaw nodes describe --node <id|name|ip>
```

The device and node request IDs are distinct. An initial unapproved surface has
no effective commands. SSH-verified and bootstrap enrollment can approve the
first surface automatically; trusted-network device approval alone does not.
Later expansions need approval, while previously approved commands that remain
declared and allowed can still run. [Gateway command policy](/nodes/command-policy)
and node-local exec approvals remain separate gates.

Naming options:

- `--display-name` on `openclaw node run` / `openclaw node install` (persists in the shared `nodeHost.config` SQLite machine-state value alongside the client instance ID and Gateway connection metadata).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway override).

### Headless identity state

The headless node keeps three separate state records in shared SQLite:

- `~/.openclaw/state/openclaw.sqlite` (`config_machine_state`, key `nodeHost.config`): the client instance ID, display name, and Gateway connection metadata.
- `~/.openclaw/state/openclaw.sqlite` (`device_identities`, key `primary`): the signed device keypair and derived cryptographic device ID.
- `~/.openclaw/state/openclaw.sqlite` (`device_auth_tokens`): paired device auth tokens keyed by cryptographic device ID and role.

For a signed node, the Gateway uses the cryptographic device ID for pairing and
node routing. The client instance ID is only connection metadata. Changing
`--node-id` or migrating a retired `node.json` therefore does not reset pairing. See
[Identity and pairing state](/cli/node#identity-and-pairing-state) for the
supported revoke-and-re-pair flow and upgrade notes.

Retired `identity/device.json` and `identity/device-auth.json` files are
Doctor-owned migration inputs. Stop the node host and run
`openclaw doctor --fix`; Doctor imports and verifies their rows in SQLite before
removing the old files.

## System commands (node host / mac node)

The macOS node and headless node host both expose `system.run.prepare`, `system.run`, `system.which`, and `system.execApprovals.get/set`; the macOS node also exposes `system.notify`.

Examples:

```bash
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
openclaw nodes invoke --node <idOrNameOrIp> --command system.which --params '{"bins":["git"]}'
```

Notes:

- `system.run` returns stdout/stderr/exit code in the payload.
- Shell execution now goes through the `exec` tool with `host=node`; `nodes` remains the direct-RPC surface for explicit node commands.
- `nodes invoke` does not expose `system.run` or `system.run.prepare`; those stay on the exec path only.
- The exec path reads the node policy and prepares a canonical `systemRunPlan`. Full/off execution resolves working-directory aliases without adding approval-only script checks. When caller or node policy requires approval binding, stricter path and script checks remain in place. Once an approval is granted, the gateway forwards that stored plan, not any later caller-edited command/cwd/session fields.
- `system.notify` respects notification permission state on the macOS app; supports `--priority <passive|active|timeSensitive>` and `--delivery <system|overlay|auto>`.
- Unrecognized node `platform` / `deviceFamily` metadata uses a conservative default allowlist that excludes `system.run` and `system.which`. If you intentionally need those commands for an unknown platform, add them explicitly via `gateway.nodes.commands.allow`.
- A `system.run` request supports `cwd`, an `env` map, `timeoutMs`, and `needsScreenRecording` — these are fields of the request payload carried on the exec path (see above), not `nodes invoke` CLI flags.
- For shell wrappers (`bash|sh|zsh ... -c/-lc`), request-scoped `env` values are reduced to an explicit allowlist (`TERM`, `LANG`, `LC_*`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`).
- For allow-always decisions in allowlist mode, known dispatch wrappers (`env`, `flock`, `nice`, `nohup`, `stdbuf`, `timeout`) persist inner executable paths instead of wrapper paths. If unwrapping is not safe, no allowlist entry is persisted automatically.
- On Windows node hosts in allowlist mode, shell-wrapper runs via `cmd.exe /c` require approval (allowlist entry alone does not auto-allow the wrapper form).
- Node hosts ignore `PATH` overrides in the `env` object and strip a large, maintained set of interpreter/shell startup variables (for example `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, `DYLD_*`, `LD_*`) before running a command. If you need extra PATH entries, configure the node host service environment (or install tools in standard locations) instead of passing `PATH` via `env`.
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals). Ask/allowlist/full behave the same as the headless node host; denied prompts return `SYSTEM_RUN_DENIED`.
- On headless node host, `system.run` is gated by the local SQLite exec approvals row; on macOS specifically, see the exec-host routing env vars under [Headless node host](#headless-node-host-cross-platform) below.

## Headless node host (cross-platform)

OpenClaw can run a **headless node host** (no UI) that connects to the Gateway WebSocket and exposes `system.run` / `system.which`. This is useful on Linux/Windows or for running a minimal node alongside a server.

Start it:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Notes:

- Device pairing and command-surface approval are still required; follow [Pair + name](/nodes/node-host#pair-+-name) through both stages.
- Client instance metadata, signed device identity, and pairing auth use separate state records; see [Headless identity state](#headless-identity-state).
- Exec approvals are enforced locally via
  `~/.openclaw/state/openclaw.sqlite#exec_approvals_config` (see [Exec approvals](/tools/exec-approvals)).
- On macOS, the headless node host executes `system.run` locally by default. Set `OPENCLAW_NODE_EXEC_HOST=app` to require the companion app exec host, with no local fallback. `OPENCLAW_NODE_EXEC_FALLBACK` does not change current routing.
- Add `--tls` / `--tls-fingerprint` when the Gateway WS uses TLS.

## Mac node mode

- The macOS menubar app connects to the Gateway WS server as a node (so `openclaw nodes …` works against this Mac).
- In remote mode, the app opens an SSH tunnel for the Gateway port and connects to `localhost`.
