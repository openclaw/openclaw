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
    - Refuses to start unless `gateway.mode=local` is set in `~/.openclaw/openclaw.json`. Use `--allow-unconfigured` for ad-hoc/dev runs; it bypasses the guard without writing or repairing config.
    - Startup automatically applies deterministic, prompt-free legacy-key migrations to eligible invalid single-file configs, including in non-interactive service runs. It writes only after full validation, including plugins, and keeps the previous config in the `.bak` ring. Configs using `$include`, Nix-managed configs, and configs written by a newer version are excluded. See [Legacy config key migrations](/gateway/doctor#detailed-behavior-and-rationale).
    - If automatic migration cannot make the config valid, an interactive terminal can offer to run `openclaw doctor --fix` and retry startup once after consent. Non-interactive runs print the command instead. If the repaired config is still invalid, startup remains stopped.
    - `openclaw onboard --mode local` and `openclaw setup` write `gateway.mode=local`. If the config file exists but `gateway.mode` is missing, that is treated as damaged/clobbered config and the Gateway refuses to guess `local` for you — re-run onboarding, set the key manually, or pass `--allow-unconfigured`.
    - Binding beyond loopback without auth is blocked.
    - `--bind` values `lan`, `tailnet`, and `custom` resolve over IPv4-only paths; IPv6-only bring-your-own-host setups need an IPv4 sidecar or proxy in front of the Gateway.
    - `SIGUSR2` triggers an in-process restart when authorized. `commands.restart` (default: enabled) gates externally-sent `SIGUSR2`; set it to `false` to block manual OS-signal restarts. The agent-facing `gateway` tool is read-only; agents request restart through the `openclaw` delegation tool. Effective Full Access, including Default (Full Access), authorizes permitted delegated changes without an approval prompt; restricted runs require human approval. See [Delegated setup and repair](/gateway/permission-modes#delegated-setup-and-repair).
    - `SIGUSR1` is reserved for Node's inspector, so attaching a debugger does not restart the Gateway. Prefer `openclaw gateway restart` for restarts; update manual restart scripts to send `SIGUSR2`.
    - `SIGINT`/`SIGTERM` stop the process but do not restore custom terminal state — if you wrap the CLI in a TUI or raw-mode input, restore the terminal yourself before exit.

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
  Allow the Gateway to auto-configure channels from ambient environment variables. By default, channels require an explicit `channels.<id>` config block.
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

If no persistent token is configured, run `openclaw doctor --generate-gateway-token`, restart the Gateway, and then rerun the command. Generic `openclaw config get` output remains redacted, including `--json`.
