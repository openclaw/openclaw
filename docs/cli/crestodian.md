---
summary: "CLI reference and security model for the inference-backed Crestodian setup and repair helper"
read_when:
  - You finished inference setup and want Crestodian to configure the rest
  - You need to inspect or repair OpenClaw with the local setup agent
  - You are designing or enabling message-channel rescue mode
title: "Crestodian"
---

# `openclaw crestodian`

Conversational Crestodian is OpenClaw's local setup, repair, and configuration
agent. It starts only after the effective default model completes a real turn.
Fresh installs establish inference first; malformed config stays on the
classic doctor path.

## When it starts

Running `openclaw` with no subcommand routes based on config state:

- Config missing, or exists with no authored settings (empty, or only `$schema`/`meta` keys): starts guided onboarding with live AI verification.
- Config exists but fails validation: starts classic onboarding, which reports the issues and directs you to `openclaw doctor`.
- Config exists and is valid: opens the normal agent TUI. A reachable
  configured Gateway whose default agent has a model goes directly to that UI
  without onboarding or Crestodian. Use `/crestodian` inside the TUI, or run
  `openclaw crestodian` directly, to reach Crestodian later.

Running `openclaw crestodian` first live-tests the configured default model. A passing turn starts Crestodian. An interactive failure opens guided inference setup and hands off to Crestodian after a candidate passes. One-shot, JSON, and other noninteractive requests fail with instructions to run `openclaw onboard` when inference is unavailable. `openclaw --help` and `openclaw --version` keep their normal fast paths.

Noninteractive bare `openclaw` (no TTY) exits with a short message instead of printing root help: it points to non-interactive onboarding on a fresh or invalid install, or to `openclaw agent --local ...` when config is valid.

`openclaw onboard --modern` remains a compatibility alias for Crestodian, but uses the same inference gate: working inference opens the chat, interactive failures start guided inference setup, and noninteractive failures exit with onboarding guidance. `openclaw onboard --classic` opens the full step-by-step wizard.

## What Crestodian shows

Interactive Crestodian opens the same TUI shell as `openclaw tui`, with a Crestodian chat backend. The startup greeting covers:

- config validity and the default agent
- the verified model Crestodian is using
- Gateway reachability from the first startup probe
- the next recommended debug action

It does not dump secrets or load plugin CLI commands just to start.

Use `status` for the detailed inventory: config path, docs/source paths, local CLI probes, key/token presence, agents, model, and Gateway details.

Crestodian uses the same reference discovery as regular agents: in a Git checkout it points at local `docs/` and the source tree; in an npm install it uses bundled docs and links to [https://github.com/openclaw/openclaw](https://github.com/openclaw/openclaw), with guidance to check source when docs are not enough.

## Examples

```bash
openclaw
openclaw crestodian
openclaw crestodian --json
openclaw crestodian --message "models"
openclaw crestodian --message "validate config"
openclaw crestodian --message "setup workspace ~/Projects/work model openai/gpt-5.5" --yes
openclaw crestodian --message "set default model openai/gpt-5.5" --yes
openclaw onboard --modern
```

Inside the Crestodian TUI:

```text
status
health
doctor
doctor fix
validate config
setup
setup workspace ~/Projects/work model openai/gpt-5.5
config set gateway.port 19001
config set-ref gateway.auth.token env OPENCLAW_GATEWAY_TOKEN
gateway status
restart gateway
agents
create agent work workspace ~/Projects/work
models
configure model provider
set default model openai/gpt-5.5
channels
channel info slack
connect slack
open setup wizard
open classic wizard
open channel wizard for slack
plugins list
plugins search slack
plugin install clawhub:openclaw-codex-app-server
plugin uninstall openclaw-codex-app-server
talk to work agent
talk to agent for ~/Projects/work
audit
quit
```

## Operations and approval

Crestodian uses typed operations instead of editing config ad hoc.

Read-only operations run immediately: show overview, list agents, list installed plugins, search ClawHub plugins, show model/backend status, run status/health checks, check Gateway reachability, run doctor without interactive fixes, validate config, show the audit-log path.

Starting guided channel setup (`connect telegram`) or model-provider setup (`configure model provider`) also runs immediately. Each wizard collects explicit answers and owns the resulting writes.

Persistent, require conversational approval (or `--yes` for a direct command): write config, `config set`, `config set-ref`, setup/onboarding bootstrap, change the default model, start/stop/restart the Gateway, create agents, install or uninstall plugins, run doctor repairs that rewrite config or state.

Approval is given in your own words: unambiguous replies ("yes", "sure", "go ahead", "not now") resolve from a closed deterministic list, and anything else is judged by a separate host-run model call that sees only your message and the pending proposal — never by the conversation model itself, which cannot self-approve. Ambiguous replies keep the proposal pending and the conversation asks again.

Applied writes are recorded in `~/.openclaw/audit/crestodian.jsonl`. Discovery is not audited; only applied operations and writes are.

Channel setup can run as a hosted conversation until it reaches a secret. The
local Crestodian TUI does not accept sensitive wizard answers because terminal
chat input is visible. It offers `open channel wizard` immediately, carrying
the selected channel into the masked terminal wizard; you can also run
`openclaw channels add --channel <channel>` later.

### Switching to the menu wizards

The local chat can hand control back to any terminal menu flow:

```text
open setup wizard
open classic wizard
open channel wizard for slack
channel info slack
```

`open setup wizard` opens guided onboarding. `open classic wizard` opens the
full classic setup. `open channel wizard for <channel>` opens masked channel
setup after the chat TUI closes. Use `channel info <channel>` first for the
channel label, setup state, prerequisites summary, and docs link.

Model-provider setup uses the same provider/auth and default-model steps as
`openclaw onboard`. In the local Crestodian TUI, approval exits the chat shell,
runs those steps with masked terminal prompts, and then resumes Crestodian. A
gateway/app chat that supports sensitive replies hosts the same steps inline.

## Setup bootstrap

`setup` configures the remaining workspace and Gateway state after guided onboarding has already established inference. It writes only through typed config operations and asks for approval first.

```text
setup
setup workspace ~/Projects/work
setup workspace ~/Projects/work model openai/gpt-5.5
```

If inference is missing or its live check fails, leave Crestodian and run `openclaw onboard`. Guided onboarding detects configured models, API keys, and authenticated local CLIs, asks each candidate for a real reply, and persists only a passing route. Crestodian starts immediately after that boundary and can then configure channels, agents, plugins, and other optional features.

The macOS app skips this ladder entirely when it reaches a configured Gateway
whose default agent already has a working model; it opens the normal agent UI.
For a fresh or incomplete Gateway, the app drives the inference ladder through
the `crestodian.setup.detect` and `crestodian.setup.activate` Gateway methods:
detect lists every candidate backend it finds, activate live-tests one
candidate (a real "reply with OK" completion), and only persists the model,
credential, and provider/runtime state needed for that route after the test passes. Workspace and Gateway defaults remain for Crestodian. A failing candidate
never changes config; the app automatically walks down the ladder and finally
offers a manual key/token step populated from the Gateway's active
text-inference provider plugins. The selected provider owns its starter model
and config, and the credential is verified the same way before it is saved.

## AI conversation

Interactive Crestodian is AI-only: every message — including ones that look like typed commands — runs through the same agent loop as regular OpenClaw agents, restricted to one ring-zero `crestodian` tool that wraps the typed operations. Read actions run freely, mutations require your conversational approval for that exact operation (see Operations and approval), and every applied write is audited and re-validated. The agent session persists, so Crestodian has real multi-turn memory. If the verified inference route later stops working, return to `openclaw onboard` and repair it before continuing.

The typed command grammar is anchored: a message either matches a command exactly or it is conversation. Questions and natural phrasing ("why did my gateway stop?") never trigger operations — they are answered by the AI.

One secret-hygiene exception: an exact `config set` on a sensitive path (tokens, keys, passwords) never reaches a model. It runs on the deterministic path with a redacted proposal, and the value is masked in the AI-visible history. Prefer `config set-ref <path> env <ENV_VAR>` for secrets.

Message-channel rescue mode never uses the model-assisted planner. Remote rescue stays deterministic so a broken or compromised normal agent path cannot be used as a config editor.

### CLI harness trust model

Embedded runtimes and the Codex app-server harness enforce the ring-zero
restriction directly: the run carries a tool allow-list with only the
`crestodian` tool. CLI harnesses (Claude Code, Gemini CLI) cannot enforce an
OpenClaw tool allow-list — the CLI owns its native tools and its own permission
policy, so OpenClaw fails closed if asked to restrict one. For CLI-harness
models Crestodian instead:

- injects a dedicated MCP server that serves only the `crestodian` tool and
  replaces OpenClaw's normal MCP tool surface for the run (for Claude Code the
  generated config is applied with `--strict-mcp-config`, so no other MCP
  servers are loaded),
- keeps every config mutation inside the tool's approval and audit contract —
  reads run freely, writes require your conversational yes, and every applied
  write is audited and re-validated,
- leaves native tools (file reads, shell) to the harness. They follow the same
  permission posture as normal OpenClaw agent runs on this machine: with
  OpenClaw's default exec settings Claude Code runs with permissions bypassed,
  and a restricted `tools.exec` config falls back to the CLI's own permission
  policy.

Only Crestodian sessions get the crestodian MCP server; normal agent runs
never see this tool. Treat a Crestodian session on a CLI-harness model like a
normal local agent run on the same host: the ring-zero tool adds an audited,
approval-gated path for config repair, but it does not prevent the harness's
native tools from touching files directly. The Codex app-server fallback and
API-key models enforce the strict single-tool loop; prefer those when you want
the hard restriction.

## Switching to an agent

Use a natural-language selector to leave Crestodian and open the normal TUI:

```text
talk to agent
talk to work agent
switch to main agent
```

`openclaw tui`, `openclaw chat`, and `openclaw terminal` open the normal agent TUI directly; they do not start Crestodian. After switching into the normal TUI, `/crestodian` returns to Crestodian, optionally with a follow-up request:

```text
/crestodian
/crestodian restart gateway
```

## Message rescue mode

Message rescue mode is the message-channel entrypoint for Crestodian: use it when your normal agent is dead but a trusted channel (for example WhatsApp) still receives commands.

This is a deterministic emergency command handler, not the conversational
Crestodian agent. It does not bootstrap a fresh setup or relax the inference
gate for Crestodian chat.

Supported command: `/crestodian <request>`. Rescue accepts the exact typed command grammar only — natural language is rejected with a hint, never guessed into an operation, and no model is ever consulted.

```text
You, in a trusted owner DM: /crestodian status
OpenClaw: Crestodian rescue mode. Gateway reachable: no. Config valid: no.
You: /crestodian restart gateway
OpenClaw: Plan: restart the Gateway. Reply /crestodian yes to apply.
You: /crestodian yes
OpenClaw: Applied. Audit entry written.
```

Agent creation can also be queued locally or via rescue:

```text
create agent work workspace ~/Projects/work model openai/gpt-5.5
/crestodian create agent work workspace ~/Projects/work
```

Remote rescue is an admin surface and must be treated like remote config repair, not normal chat.

Security contract for remote rescue:

- Disabled when sandboxing is active for the agent/session; Crestodian refuses remote rescue and points to local CLI repair.
- Default effective state is `auto`: allow remote rescue only in trusted YOLO operation, where the runtime already has unsandboxed local authority (`tools.exec.security` resolves to `full` and `tools.exec.ask` resolves to `off`, with sandbox mode `off`).
- Requires an explicit owner identity; no wildcard sender rules, open group policy, unauthenticated webhooks, or anonymous channels.
- Owner DMs only by default; group/channel rescue needs explicit opt-in.
- Plugin search and list are read-only. Plugin install is always local-only (blocked in rescue, even when otherwise enabled) because it downloads executable code. Plugin uninstall can be approved as a persistent rescue operation.
- Remote rescue cannot open the local TUI or switch into an interactive agent session; use local `openclaw` for agent handoff.
- Persistent writes still require approval, even in rescue mode.
- Every applied rescue operation is audited. Message-channel rescue records channel, account, sender, and source-address metadata; config-mutating operations also record config hashes before and after.
- Secrets are never echoed. SecretRef inspection reports availability, not values.
- If the Gateway is alive, rescue prefers Gateway typed operations; if it is dead, rescue uses only the minimal local repair surface that does not depend on the normal agent loop.

Config shape:

```jsonc
{
  "crestodian": {
    "rescue": {
      "enabled": "auto",
      "ownerDmOnly": true,
      "pendingTtlMinutes": 15,
    },
  },
}
```

- `enabled`: `"auto"` (default) allows rescue only when the effective runtime is YOLO and sandboxing is off; `false` never allows message-channel rescue; `true` explicitly allows rescue when owner/channel checks pass (still subject to the sandboxing denial).
- `ownerDmOnly`: restrict rescue to owner direct messages. Default `true`.
- `pendingTtlMinutes`: how long a pending rescue write stays open for `/crestodian yes` approval before expiring. Default `15`.

Remote rescue is covered by the Docker lane:

```bash
pnpm test:docker:crestodian-rescue
```

An opt-in live channel command-surface smoke checks `/crestodian status` plus a persistent approval roundtrip through the rescue handler:

```bash
pnpm test:live:crestodian-rescue-channel
```

Inference-first setup through explicit Crestodian commands is covered by:

```bash
pnpm test:docker:crestodian-first-run
```

That packaged-CLI lane starts with an empty state dir and proves Crestodian
fails closed without inference. It then live-activates a fake Claude inference
backend, verifies the probe, and only afterward runs Crestodian commands to set
the workspace and model, create an additional agent, configure Discord through
a plugin enablement plus token SecretRef, validate config, and check the audit
log. The QA Lab scenario below redirects to the same Docker lane:

```bash
pnpm openclaw qa suite --scenario crestodian-ring-zero-setup
```

## Related

- [CLI reference](/cli)
- [Doctor](/cli/doctor)
- [TUI](/cli/tui)
- [Sandbox](/cli/sandbox)
- [Security](/cli/security)
