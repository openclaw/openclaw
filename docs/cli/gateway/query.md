---
summary: "Query a running Gateway: health, usage-cost, stability, diagnostics export, status, probe, call, suspend, and resume"
read_when:
  - Checking whether a Gateway is healthy, ready, or reachable
  - Exporting Gateway diagnostics or a support bundle
  - Calling a Gateway RPC method or suspending a Gateway
title: "Query a running Gateway"
sidebarTitle: "Query"
---

The WebSocket RPC query subcommands and their shared options. Part of the [`openclaw gateway`](/cli/gateway) reference.

## Query a running Gateway

All query commands use WebSocket RPC.

<Tabs>
  <Tab title="Output modes">
    - Default: human-readable (colored in TTY).
    - `--json`: machine-readable JSON (no styling/spinner).
    - `--no-color` (or `NO_COLOR=1`): disable ANSI while keeping human layout.

  </Tab>
  <Tab title="Shared options">
    - `--url <url>`: Gateway WebSocket URL.
    - `--token <token>`: Gateway token.
    - `--password <password>`: Gateway password.
    - `--timeout <ms>`: timeout/budget (default varies per command; see each command below).
    - `--expect-final`: wait for a "final" response (agent calls).

  </Tab>
</Tabs>

<Note>
When you set `--url`, the CLI does not fall back to config or environment credentials. Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.
</Note>

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
openclaw gateway health --port 18789
```

`/healthz` is a liveness probe: it returns as soon as the server can answer HTTP. `/readyz` is stricter and stays red while startup plugin sidecars, channels, or configured hooks are still settling. Local or authenticated detailed `/readyz` responses include an `eventLoop` diagnostic block (delay, utilization, CPU-core ratio, `degraded` flag).

<ParamField path="--port <port>" type="number">
  Target a local loopback Gateway on this port. Overrides `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_PORT` for this call.
</ParamField>

### `gateway usage-cost`

Fetch usage-cost summaries from session logs.

```bash
openclaw gateway usage-cost
openclaw gateway usage-cost --days 7
openclaw gateway usage-cost --agent work --json
openclaw gateway usage-cost --all-agents
openclaw gateway usage-cost --json
```

Human-readable output warns that totals may be incomplete when the usage cache is
refreshing, partial, or stale. The command returns the available snapshot from
one request; run it again later to check for refreshed totals. JSON output preserves
the `cacheStatus` object so scripts can inspect the same state.

<ParamField path="--days <days>" type="number" default="30">
  Number of days to include.
</ParamField>
<ParamField path="--agent <id>" type="string">
  Scope the summary to one configured agent id.
</ParamField>
<ParamField path="--all-agents" type="boolean">
  Aggregate across all configured agents. Cannot combine with `--agent`.
</ParamField>

### `gateway stability`

Fetch the recent diagnostic stability recorder from a running Gateway.

```bash
openclaw gateway stability
openclaw gateway stability --type payload.large
openclaw gateway stability --bundle latest
openclaw gateway stability --bundle latest --export
openclaw gateway stability --json
```

<ParamField path="--limit <limit>" type="number" default="25">
  Maximum recent events to include (max `1000`).
</ParamField>
<ParamField path="--type <type>" type="string">
  Filter by diagnostic event type, e.g. `payload.large` or `diagnostic.memory.pressure`.
</ParamField>
<ParamField path="--since-seq <seq>" type="number">
  Include only events after a diagnostic sequence number.
</ParamField>
<ParamField path="--bundle [path]" type="string">
  Read a persisted stability bundle instead of calling the running Gateway. `--bundle latest` (or bare `--bundle`) picks the newest bundle under the state directory; you can also pass a bundle JSON path directly.
</ParamField>
<ParamField path="--export" type="boolean">
  Write a shareable support diagnostics zip instead of printing stability details.
</ParamField>
<ParamField path="--output <path>" type="string">
  Output path for `--export`.
</ParamField>

<AccordionGroup>
  <Accordion title="Privacy and bundle behavior">
    - Records keep operational metadata: event names, counts, byte sizes, memory readings, queue/session state, approval ids, channel/plugin names, and redacted session summaries. They exclude chat text, webhook bodies, tool outputs, raw request/response bodies, tokens, cookies, secret values, hostnames, and raw session ids. Set `diagnostics.enabled: false` to disable the recorder entirely.
    - Fatal Gateway exits, shutdown timeouts, and restart startup failures write the same diagnostic snapshot to `~/.openclaw/logs/stability/openclaw-stability-*.json` when the recorder has events. Inspect the newest bundle with `openclaw gateway stability --bundle latest`; `--limit`, `--type`, and `--since-seq` apply to bundle output too.

  </Accordion>
</AccordionGroup>

### `gateway diagnostics export`

Write a local diagnostics zip designed for bug reports. For the privacy model and bundle contents, see [Diagnostics Export](/gateway/diagnostics).

```bash
openclaw gateway diagnostics export
openclaw gateway diagnostics export --output openclaw-diagnostics.zip
openclaw gateway diagnostics export --json
```

<ParamField path="--output <path>" type="string">
  Output zip path. Defaults to a support export under the state directory.
</ParamField>
<ParamField path="--log-lines <count>" type="number" default="5000">
  Maximum sanitized log lines to include.
</ParamField>
<ParamField path="--log-bytes <bytes>" type="number" default="1000000">
  Maximum log bytes to inspect.
</ParamField>
<ParamField path="--url <url>" type="string">
  Gateway WebSocket URL for the health snapshot.
</ParamField>
<ParamField path="--token <token>" type="string">
  Gateway token for the health snapshot.
</ParamField>
<ParamField path="--password <password>" type="string">
  Gateway password for the health snapshot.
</ParamField>
<ParamField path="--timeout <ms>" type="number" default="3000">
  Status/health snapshot timeout.
</ParamField>
<ParamField path="--no-stability-bundle" type="boolean">
  Skip persisted stability bundle lookup.
</ParamField>
<ParamField path="--json" type="boolean">
  Print the written path, size, and manifest as JSON.
</ParamField>

The export bundles: `manifest.json` (file inventory), `summary.md` (Markdown summary), `diagnostics.json` (top-level config/logs/discovery/stability/status/health summary), `config/sanitized.json`, `status/gateway-status.json`, `health/gateway-health.json`, `logs/openclaw-sanitized.jsonl`, and `stability/latest.json` when a bundle exists.

It is designed to be shared. It keeps operational details useful for debugging — safe log fields, subsystem names, status codes, durations, configured modes, ports, plugin/provider ids, non-secret feature settings, and redacted operational log messages — and omits or redacts chat text, webhook bodies, tool outputs, credentials, cookies, account/message identifiers, prompt/instruction text, hostnames, and secret values. When a log message looks like user/chat/tool payload text (e.g. "user said", "chat text", "tool output", "webhook body"), the export keeps only the fact that a message was omitted plus its byte count.

### `gateway status`

Shows the Gateway service (launchd/systemd/schtasks) plus an optional connectivity/auth probe.

```bash
openclaw gateway status
openclaw gateway status --json
openclaw gateway status --require-rpc
openclaw gateway status --port 19001
```

<ParamField path="--url <url>" type="string">
  Probe this explicit WebSocket URL instead of the service-derived target. Cannot combine with `--port`.
</ParamField>
<ParamField path="--port <port>" type="number">
  Select a local Gateway port using the invoking CLI config for auth and TLS. Accepts `gateway --port 19001 status` and `gateway status --port 19001`; an explicit status port wins. Native service details remain visible as diagnostics but do not select the probe target.
</ParamField>
<ParamField path="--token <token>" type="string">
  Token auth for the probe.
</ParamField>
<ParamField path="--password <password>" type="string">
  Password auth for the probe.
</ParamField>
<ParamField path="--timeout <ms>" type="number" default="10000">
  Probe timeout.
</ParamField>
<ParamField path="--no-probe" type="boolean">
  Skip the connectivity probe (service-only view).
</ParamField>
<ParamField path="--deep" type="boolean">
  Scan system-level services too.
</ParamField>
<ParamField path="--require-rpc" type="boolean">
  Upgrade the connectivity probe to a read probe and exit non-zero if it fails. Cannot combine with `--no-probe`.
</ParamField>

<AccordionGroup>
  <Accordion title="Status semantics">
    - Stays available for diagnostics even when the local CLI config is missing or invalid.
    - Default output proves service state, WebSocket connect, and the auth capability visible at handshake time — not read/write/admin operations.
    - Probes are non-mutating for first-time device auth: they reuse an existing cached device token when one exists, but never create a new CLI device identity or read-only pairing record just to check status.
    - Resolves configured auth SecretRefs for probe auth when possible. If a required SecretRef is unresolved, `--json` reports `rpc.authWarning` when probe connectivity/auth fails; pass `--token`/`--password` explicitly or fix the secret source. Unresolved-auth warnings are suppressed once the probe succeeds.
    - JSON output includes `gateway.version` when the running Gateway reports it; `--require-rpc` can fall back to the `status.runtimeVersion` RPC payload if the handshake probe cannot supply version metadata.
    - Use `--require-rpc` in scripts/automation when a listening service is not enough and you need read-scope RPC to be healthy too.
    - `--deep` scans for extra launchd/systemd/schtasks installs; when multiple gateway-like services are found, human output prints cleanup hints (usually run one gateway per machine) and reports a recent supervisor restart handoff when relevant.
    - `--deep` confirms exact npm targets before suggesting repairs for official-plugin version drift. Unpublished versions or registry failures are reported without an update command; retry deep status after registry access or the release cohort is restored. Ordinary status and readiness checks do not query npm for drift repairs.
    - `--deep` also runs config validation in plugin-aware mode (`pluginValidation: "full"`) and surfaces plugin manifest warnings (e.g. missing channel config metadata). Default `gateway status` keeps the fast read-only path that skips plugin validation.
    - On Linux, status reports the effective service currently loaded by systemd, including loaded drop-ins. If the unit or a drop-in changed on disk, `Systemd reload: pending` means you must run `systemctl --user daemon-reload` (or `sudo systemctl daemon-reload` for a system service) before those changes take effect.
    - Human output includes the resolved file log path plus CLI-vs-service config paths/validity to help diagnose profile or state-dir drift.
    - Install and reinstall guidance follows the invoking shell's installation rules, not the stored service environment or probe target. Nix mode, external supervision, noncanonical installation identity, and Linux sudo/user-manager mismatches show the install refusal instead of an unusable command. A diagnostic-only target is not itself a refusal. Nix mode blocks installation, not starting an existing service.
    - Human output includes `Gateway heap:` with configured service heap controls and a separate install-time recommendation based on memory visible to the CLI. JSON output exposes the same report as `service.gatewayHeap`. Neither is a measurement of the running Gateway's V8 heap ceiling; use runtime memory diagnostics for that.

  </Accordion>
  <Accordion title="Linux systemd auth-drift checks">
    - Service auth drift checks read both `Environment=` and `EnvironmentFile=` from the unit (including `%h`, quoted paths, multiple files, and optional `-` files).
    - Resolves `gateway.auth.token` SecretRefs using merged runtime env (service command env first, then process env fallback).
    - Token-drift checks skip config token resolution when token auth is not effectively active (`gateway.auth.mode` explicitly `password`/`none`/`trusted-proxy`, or mode unset where password can win and no token candidate can win).

  </Accordion>
</AccordionGroup>

### `gateway probe`

The "debug everything" command. It always probes:

- your configured remote gateway (if set), and
- localhost (loopback), **even if remote is configured**.

Passing `--url` adds that explicit target ahead of both. Human output labels targets `URL (explicit)`, `Remote (configured)` / `Remote (configured, inactive)`, and `Local loopback`.

<Note>
If multiple probe targets are reachable, all are printed. An SSH tunnel, TLS/proxy URL, and configured remote URL can point at the same gateway even with different transport ports; `multiple_gateways` is reserved for distinct or identity-ambiguous reachable gateways. Running multiple gateways is supported for isolated profiles (e.g. a rescue bot), but most installs run a single gateway.
</Note>

```bash
openclaw gateway probe
openclaw gateway probe --json
openclaw gateway probe --port 18789
```

<ParamField path="--port <port>" type="number">
  Use this port for the local loopback probe target and SSH tunnel remote port. Without `--url`, this selects only the local loopback target instead of configured gateway environment URL, environment port, or remote targets.
</ParamField>

<AccordionGroup>
  <Accordion title="Interpretation">
    - `Reachable: yes` means at least one target accepted a WebSocket connect.
    - `Capability: read-only|write-capable|admin-capable|pairing-pending|connect-only` reports what the probe could prove about auth, separate from reachability.
    - `Read probe: ok` means read-scope detail RPC calls (`health`/`status`/`system-presence`/`config.get`) also succeeded.
    - `Read probe: limited - missing scope: operator.read` means connect succeeded but read-scope RPC is limited. Reported as **degraded** reachability, not full failure.
    - `Read probe: failed` after `Connect: ok` means the WebSocket connected but follow-up read diagnostics timed out or failed — also **degraded**, not unreachable.
    - Like `gateway status`, probe reuses existing cached device auth but does not create first-time device identity or pairing state.
    - Exit code is non-zero only when no probed target is reachable.

  </Accordion>
  <Accordion title="JSON output">
    Top level:

    - `ok`: at least one target is reachable.
    - `degraded`: at least one target accepted a connection but did not complete full detail RPC diagnostics.
    - `capability`: best capability seen across reachable targets (`read_only`, `write_capable`, `admin_capable`, `pairing_pending`, `connected_no_operator_scope`, or `unknown`).
    - `primaryTargetId`: best target to treat as the active winner, in order: explicit URL, SSH tunnel, configured remote, local loopback.
    - `warnings[]`: best-effort warning records with `code`, `message`, optional `targetIds`.
    - `network`: local loopback/tailnet URL hints derived from current config and host networking.
    - `discovery.timeoutMs` / `discovery.count`: the actual discovery budget/result count used for this probe pass.

    Per target (`targets[].connect`): `ok` (reachability + degraded classification), `rpcOk` (full detail RPC success), `scopeLimited` (detail RPC failed on missing operator scope).

    Per target (`targets[].auth`): `role` and `scopes` reported in `hello-ok` when available, plus the surfaced `capability` classification.

  </Accordion>
  <Accordion title="Common warning codes">
    - `ssh_tunnel_failed`: SSH tunnel setup failed; the command fell back to direct probes.
    - `multiple_gateways`: distinct gateway identities were reachable, or OpenClaw could not prove reachable targets are the same gateway. An SSH tunnel, proxy URL, or configured remote URL to the same gateway does not trigger this.
    - `auth_secretref_unresolved`: a configured auth SecretRef could not be resolved for a failed target.
    - `probe_scope_limited`: WebSocket connect succeeded, but the read probe was limited by missing `operator.read`.
    - `local_tls_runtime_unavailable`: local Gateway TLS is enabled but OpenClaw could not load the local certificate fingerprint.

  </Accordion>
</AccordionGroup>

#### Remote over SSH (Mac app parity)

The macOS app "Remote over SSH" mode uses a local port-forward so a loopback-only remote gateway becomes reachable at `ws://127.0.0.1:<port>`.

CLI equivalent:

```bash
openclaw gateway probe --ssh user@gateway-host
```

<ParamField path="--ssh <target>" type="string">
  `user@host` or `user@host:port` (port defaults to `22`).
</ParamField>

OpenClaw launches only an SSH client found in OS-managed system directories. On native Windows,
install the **OpenSSH Client** optional feature; Windows places it under
`%SystemRoot%\System32\OpenSSH`.

<ParamField path="--ssh-identity <path>" type="string">
  Identity file.
</ParamField>
<ParamField path="--ssh-auto" type="boolean">
  Pick the first discovered gateway host as SSH target from the resolved discovery endpoint (`local.` plus the configured wide-area domain, if any). TXT-only hints are ignored.
</ParamField>

Config defaults (optional): `gateway.remote.sshTarget`, `gateway.remote.sshIdentity`.

### `gateway call <method>`

Low-level RPC helper.

```bash
openclaw gateway call status
openclaw gateway call health --port 18999
openclaw gateway call logs.tail --params '{"limit": 200}'
```

<ParamField path="--params <json>" type="string" default="{}">
  JSON object string for params.
</ParamField>
<ParamField path="--url <url>" type="string">
  Gateway WebSocket URL.
</ParamField>
<ParamField path="--port <port>" type="number">
  Target a local loopback Gateway on this port. Overrides `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_PORT` for this call. Cannot combine with `--url`.
</ParamField>
<ParamField path="--token <token>" type="string">
  Gateway token.
</ParamField>
<ParamField path="--password <password>" type="string">
  Gateway password.
</ParamField>
<ParamField path="--timeout <ms>" type="number" default="10000">
  Timeout budget.
</ParamField>
<ParamField path="--expect-final" type="boolean">
  Mainly for agent-style RPCs that stream intermediate events before a final payload.
</ParamField>
<ParamField path="--json" type="boolean">
  Machine-readable JSON output.
</ParamField>

`openclaw.setup.detect` uses a 40-second default so the Gateway can finish its
bounded AI-access scan. An explicit `--timeout` still takes precedence.

<Note>
`--params` must be valid JSON, and each method validates its own param shape (extra/misnamed fields are rejected). Use `--port` for a custom-port local Gateway; explicit `--url` targets still require explicit credentials.
</Note>

### `gateway suspend`

Prepare an idle Gateway for a cooperative host freeze or snapshot. Without
`--wait`, active work returns a nonzero exit with blocker details. With
`--wait`, the CLI retries until the bounded deadline using one stable request
ID. The value must be a non-negative number of seconds; an empty value is rejected.
Use `--wait 0` for a single attempt without polling.

```bash
openclaw gateway suspend
openclaw gateway suspend --request-id snapshot-2026-08-11 --wait 30
openclaw gateway suspend --port 18999 --json
```

The ready output includes the suspension ID, lease expiry, and the matching
resume command. Common RPC options such as `--url`, `--token`, `--password`,
`--timeout`, `--json`, and `--port` are supported.

### `gateway resume <suspensionId>`

Release a prepared suspension after thaw or when the host operation is
abandoned.

```bash
openclaw gateway resume <suspensionId>
openclaw gateway resume <suspensionId> --port 18999 --json
```

An already expired or resumed lease is a successful no-op. A different active
suspension ID is rejected.
