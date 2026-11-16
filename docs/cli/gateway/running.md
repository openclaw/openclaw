---
summary: "`openclaw gateway` run options, startup behavior, and revealing the configured token"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - Debugging Gateway auth, bind modes, and connectivity
  - Reading the configured shared token on the Gateway host
title: "Run the Gateway"
sidebarTitle: "Running"
---

Starting the Gateway process and reading its configured token. Part of the [`openclaw gateway`](/cli/gateway) reference.

## Run the Gateway

```bash
openclaw gateway
openclaw gateway run   # equivalent, explicit form
```

<AccordionGroup>
  <Accordion title="Startup behavior">
    - Unexpected startup failures print a redacted `[openclaw] Reason:` without requiring debug mode, including in managed service logs. Use `--debug` or `OPENCLAW_DEBUG=1` to include stack traces.
    - Agent requests wait for the current startup model runtime publication, including when a config refresh replaces the initial publication while startup is still preparing authentication.
    - Deferred agent database preparation retries publication after an overlapping config or secrets refresh or a transient schema-admission change before admitting sessions, up to four attempts. Opening and migration separately retry classified SQLite lock failures with bounded backoff and fresh deletion and file-identity checks. Exhausted locks retain a degraded refusal with guidance to close competing processes and restart; genuine database failures remain terminal. Publication retries do not repeat opening or migration.
    - Worker placement recovery waits through transient SQLite lock contention with up to five attempts and capped backoff (about 37 seconds including SQLite's busy waits). If the lock persists, startup fails with guidance to run `openclaw doctor` or `openclaw gateway status --deep`. Other recovery errors fail immediately.
    - Refuses to start unless `gateway.mode=local` is set in `~/.openclaw/openclaw.json`. Use `--allow-unconfigured` for ad-hoc/dev runs; it bypasses the guard without writing or repairing config.
    - Startup automatically applies rule-based, prompt-free legacy-key migrations to eligible invalid single-file configs, including in non-interactive service runs. It writes only after full validation, including plugins, and keeps the previous config in the `.bak` ring. Configs using `$include`, Nix-managed configs, and configs written by a newer version are excluded. See [Legacy config key migrations](/gateway/doctor#detailed-behavior-and-rationale).
    - If automatic migration cannot make the config valid, an interactive terminal can offer to run `openclaw doctor --fix` and retry startup once after consent. Non-interactive runs print the command instead. If the repaired config is still invalid, startup remains stopped.
    - Configuration read failures, including unavailable storage during SQLite inspection, stop startup with exit code `1` so service supervision can retry. They do not trigger config repair. Invalid configuration and required offline migrations retain exit code `78`, which prevents systemd restart loops; resolve the reported problem before restarting.
    - Startup hardens user-owned shared-state database files to mode `0600` before opening SQLite. A database that remains read-only, full, or I/O-failing is reported as a storage failure with its path and recovery guidance. Fix ownership and permissions for the reported path, remount a read-only volume writable, or free disk space as directed. These failures keep exit code `1` and do not trigger another-Gateway contention waits or port diagnostics.
    - Before reading its shared-state snapshot, startup waits up to five minutes for a temporary schema owner in another OpenClaw process to finish. Explicit offline maintenance still blocks access, and exhausted contention remains a read failure with exit code `1`.
    - Startup does not load plugin Doctor modules just to collect advisory repair rules for valid config. Invalid config still includes plugin repair guidance; `openclaw doctor` inspects repair rules even when the config is valid.
    - Config recovery, shared-state readiness, and pending plugin migration reads share the current admission snapshot. Registry refresh rechecks admission while holding both migration and plugin lifecycle leases, then verifies the persisted replacement. Repairs still compare current state before writing. This does not change update migrations or stored data.
    - `openclaw onboard --mode local` and `openclaw setup` write `gateway.mode=local`. If the config file exists but `gateway.mode` is missing, that is treated as damaged/clobbered config and the Gateway refuses to guess `local` for you — re-run onboarding, set the key manually, or pass `--allow-unconfigured`.
    - Binding beyond loopback without auth is blocked.
    - `--bind` values `lan`, `tailnet`, and `custom` resolve over IPv4-only paths; IPv6-only bring-your-own-host setups need an IPv4 sidecar or proxy in front of the Gateway.
    - `SIGUSR2` triggers an in-process restart when authorized. `commands.restart` (default: enabled) gates externally-sent `SIGUSR2`; set it to `false` to block manual OS-signal restarts. The agent-facing `gateway` tool exposes owner-requested `restart`, `update.run`, and `update.cleanup`; cleanup keeps the Gateway serving. External-chat restarts and updates also honor `commands.restart`. These runtime-owned actions preserve owner/operator authorization and explicit tool restrictions. Other delegated setup changes follow effective permissions. See [Delegated setup and repair](/gateway/permission-modes#delegated-setup-and-repair).
    - `SIGUSR1` is reserved for Node's inspector, so attaching a debugger does not restart the Gateway. Prefer `openclaw gateway restart` for restarts; update manual restart scripts to send `SIGUSR2`.
    - `SIGINT`/`SIGTERM` stop the process but do not restore custom terminal state — if you wrap the CLI in a TUI or raw-mode input, restore the terminal yourself before exit.
    - A foreground Gateway does not follow the lifetime of the process that started it. OpenClaw's own launchers, such as Node runtime recovery, forward stop signals and stop their Gateway when they exit. A shell or wrapper script that does not forward signals leaves the Gateway serving after the wrapper is killed. Signal the Gateway process itself (process title `openclaw-gateway`), or forward signals from the wrapper (for example `exec openclaw gateway run`).

  </Accordion>
</AccordionGroup>

### Options

<a id="param-port"></a>

<ParamField path="--port <port>" type="number">
  WebSocket port (default from config/env; usually `18789`).
</ParamField>
<a id="param-bind"></a>

<ParamField path="--bind <mode>" type="string">
  Bind mode: `loopback` (default), `lan`, `tailnet`, `auto`, `custom`.
</ParamField>
<a id="param-token"></a>

<ParamField path="--token <token>" type="string">
  Shared token for `connect.params.auth.token`. Defaults to `OPENCLAW_GATEWAY_TOKEN` when set.
</ParamField>
<a id="param-auth"></a>

<ParamField path="--auth <mode>" type="string">
  Auth mode: `none`, `token`, `password`, `trusted-proxy`.
</ParamField>
<a id="param-password"></a>

<ParamField path="--password <password>" type="string">
  Password for `--auth password`.
</ParamField>
<ParamField path="--password-file <path>" type="string">
  Read the Gateway password from a file.
</ParamField>
<a id="param-tailscale"></a>

<ParamField path="--tailscale <mode>" type="string">
  Tailscale exposure: `off`, `serve`, `funnel`.
</ParamField>
<a id="param-allow-unconfigured"></a>

<ParamField path="--allow-unconfigured" type="boolean">
  Start without enforcing `gateway.mode=local`. Ad-hoc/dev bootstrap only; does not persist or repair config.
</ParamField>
<a id="param-dev"></a>

<ParamField path="--dev" type="boolean">
  Create a dev config + workspace if missing (skips `BOOTSTRAP.md`).
</ParamField>
<a id="param-ambient-channels"></a>

<ParamField path="--ambient-channels" type="boolean">
  Allow the Gateway to auto-configure channels from ambient environment variables for this process, including config reloads. By default, foreground, dev, and service Gateways require explicit `channels.<id>` configuration, such as `channels.discord.enabled=true`. Configured channels can still read credentials from environment variables. For managed services, add the channel config block; this flag is not persisted by service installation.
</ParamField>
<a id="param-dev-ambient-channels"></a>

<ParamField path="--dev-ambient-channels" type="boolean">
  Deprecated alias for `--ambient-channels`.
</ParamField>
<a id="param-reset"></a>

<ParamField path="--reset" type="boolean">
  Reset dev config, credentials, sessions, and workspace. Requires `--dev`.
</ParamField>
<a id="param-force"></a>

<ParamField path="--force" type="boolean">
  Kill any existing listener on the target port before starting. In a non-interactive shell, this refuses to kill a verified Gateway listener; use `--dev` or an isolated `--profile` with a free port instead.
</ParamField>
<a id="param-verbose"></a>

<ParamField path="--verbose" type="boolean">
  Verbose logging to stdout/stderr.
</ParamField>
<a id="param-cli-backend-logs"></a>

<ParamField path="--cli-backend-logs" type="boolean">
  Only show CLI backend logs in the console (also enables stdout/stderr).
</ParamField>
<a id="param-ws-log"></a>

<ParamField path="--ws-log <style>" type="string" default="auto">
  WebSocket log style: `auto`, `full`, `compact`.
</ParamField>
<a id="param-compact"></a>

<ParamField path="--compact" type="boolean">
  Alias for `--ws-log compact`.
</ParamField>
<a id="param-raw-stream"></a>

<ParamField path="--raw-stream" type="boolean">
  Log raw model stream events to JSONL.
</ParamField>
<ParamField path="--raw-stream-path <path>" type="string">
  Raw stream JSONL path.
</ParamField>

`--claude-cli-logs` is a deprecated alias for `--cli-backend-logs`.

For `--bind custom`, set `gateway.customBindHost` to an IPv4 address. Any address other than `127.0.0.1` or `0.0.0.0` also requires `127.0.0.1` on the same port for same-host clients; startup fails if either listener cannot bind. Wildcard `0.0.0.0` does not add a separate required alias. IPv6-only bring-your-own-host setups need an IPv4 sidecar or proxy in front of the Gateway.

## Reveal the configured token

Run this on the Gateway host when a client needs the configured shared token:

```bash
openclaw gateway auth-token --show
```

The command resolves `gateway.auth.token`, `OPENCLAW_GATEWAY_TOKEN`, and configured SecretRefs, then prints only the token. It requires an interactive terminal and refuses redirected or piped output so the credential does not silently enter command logs. Treat the terminal output as a secret.

If no persistent token is configured, run `openclaw doctor --generate-gateway-token`, restart the Gateway, and then rerun the command. On Windows PowerShell, a Restricted execution policy blocks npm's `openclaw.ps1` shim before Doctor starts; use [npm's `openclaw.cmd`](/platforms/windows#powershell-execution-policy) instead of changing the execution policy. Generic `openclaw config get` output remains redacted, including `--json`.

## Recover an unverifiable state lock

Gateways that share a state directory must share one owner. A Gateway in another
container or PID namespace cannot verify that the recorded process has exited.
It therefore keeps the lock even after its heartbeat stops. Heartbeat age alone
never authorizes takeover.

If startup reports an unverifiable owner, inspect the recorded holder:

```bash
openclaw gateway recover-lock
```

The output includes the holder PID, host/PID namespace, heartbeat age, and an exact
`openclaw gateway recover-lock --confirm <fingerprint>` command. First stop the
holder through its original service manager or container. Then run the displayed
command with the same state directory/profile as the failed startup, and start the
Gateway again. Recovery explicitly removes the inspected lock records and Gateway
owner lease. It refuses a locally verified live holder, a renewed heartbeat, or
any record replaced or changed since inspection. If it refuses because something
changed, inspect again; do not delete the lock files manually.

A process that exited in the same verifiable PID namespace still recovers
automatically. The explicit command is needed for crashed owners whose death
cannot be verified from the new process, including containers with separate PID
namespaces. `openclaw gateway recover-lock --json` exposes the inspection and
confirmation command for operator tooling.

Recovery supports SQLite global state and the selected PostgreSQL state family.
For PostgreSQL, inspection binds the original local anchor, remote store UUID and
namespace, and complete Gateway-owner lease record. Confirmation clears only that
unchanged lease under native custody and a bounded PostgreSQL transaction; it
does not migrate schemas or remove agent data. An unavailable store, incompatible
lease table, changed anchor or renewed lease remains refused. Inspection may read
a different application schema version through its verified stable lease contract;
confirmation requires this binary's current GLOBAL schema version before any cleanup.
