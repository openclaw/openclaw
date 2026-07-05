---
summary: "CLI onboarding: minimal first-run setup with an optional advanced infrastructure wizard"
read_when:
  - Running or configuring CLI onboarding
  - Setting up a new machine
title: "Onboarding (CLI)"
sidebarTitle: "Onboarding: CLI"
---

```bash
openclaw onboard
```

CLI onboarding is the recommended terminal setup path on macOS, Linux, and
Windows (native or WSL2). It gets a local agent running with the fewest required
prompts, then opens that agent to help configure optional features. `openclaw
setup` runs the same flow ([Setup](/cli/setup) covers baseline-only variants).
Windows desktop users can also start from [Windows Hub](/platforms/windows).

Provider sign-in or migration can extend the minimal flow. Advanced channel
pairing, daemon install, and skill downloads can be revisited later with the
agent, `openclaw configure`, or `openclaw onboard --flow advanced`.

<Info>
Fastest first chat: run `openclaw`. After minimal setup, the normal local agent
opens directly.
</Info>

## Locale

The wizard localizes fixed onboarding copy. Resolve order: `OPENCLAW_LOCALE`,
`LC_ALL`, `LC_MESSAGES`, `LANG`, then English. Supported locales: `en`,
`zh-CN`, `zh-TW`.

```bash
OPENCLAW_LOCALE=zh-CN openclaw onboard
```

Product names, commands, config keys, URLs, provider IDs, model IDs, and
plugin/channel labels stay in English regardless of locale.

To reconfigure later:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive` (see [CLI automation](/start/wizard-cli-automation)).
</Note>

<Tip>
Advanced onboarding includes a web search step where you can pick a provider: Brave,
DuckDuckGo, Exa, Firecrawl, Gemini, Grok, Kimi, MiniMax Search, Ollama Web
Search, Perplexity, SearXNG, or Tavily. Some need an API key; others are
key-free. Configure this later with `openclaw configure --section web`. Docs:
[Web tools](/tools/web).
</Tip>

## Default vs Advanced

Default onboarding runs the minimal QuickStart path. Use `openclaw onboard
--flow advanced` for full infrastructure control. `manual` is an alias for
`advanced`.

<Tabs>
  <Tab title="QuickStart (default)">
    - Offers to import supported auth, skills, instructions, and settings from another agent environment
    - Model/auth only when no runnable local agent exists
    - Workspace default (or existing workspace)
    - Local mode
    - Tool policy: `tools.profile: "coding"` for new setups (an existing explicit profile is preserved)
    - DM isolation: `session.dmScope: "per-channel-peer"` for new setups. Details: [CLI setup reference](/start/wizard-cli-reference#outputs-and-internals)
    - Opens the normal local agent for assisted optional setup

  </Tab>
  <Tab title="Advanced (full control)">
    - Exposes mode, workspace, Gateway, channels, daemon, search, skills, hooks, and health

  </Tab>
</Tabs>

Remote mode (`--mode remote`) always uses the advanced flow; it only
configures this machine to connect to a Gateway elsewhere and never installs
or changes anything on the remote host.

## What onboarding configures

Default local mode performs only the required steps:

1. **Import or Model/Auth** - choose a registered migration source such as
   Codex, Claude, or Hermes, or set up a model separately. Detected migration
   sources appear first. Migration previews supported skills, instructions,
   settings, and other artifacts, and asks separately before importing supported
   auth credentials. If you skip import, pick a provider auth flow (API key, OAuth, or
   provider-specific manual auth), including Custom Provider
   (OpenAI-compatible, OpenAI Responses-compatible, Anthropic-compatible, or
   Unknown auto-detect). Pick a default model.
   Security note: if this agent will run tools or process webhook/hook
   content, prefer the strongest latest-generation model available and keep
   tool policy strict - weaker or older tiers are easier to prompt-inject.
   For non-interactive runs, `--secret-input-mode ref` stores env-backed refs
   instead of plaintext API key values; the referenced env var must already
   be set, or onboarding fails fast. Interactive secret reference mode can
   point at an environment variable or a configured provider ref (`file` or
   `exec`), with a fast preflight check before saving.
2. **Workspace** - directory for agent files (default `~/.openclaw/workspace`). Seeds bootstrap files.
3. **Agent handoff** - starts a temporary local Gateway and opens the normal
   local agent with a request to help finish only the optional setup you need.

Advanced local mode additionally walks through:

1. **Gateway** - port, bind address, auth mode, Tailscale exposure. In
   interactive token mode, choose plaintext token storage (default) or opt
   into a SecretRef. Non-interactive SecretRef path: `--gateway-token-ref-env <ENV_VAR>`.
2. **Channels** - built-in and official plugin chat channels, including
   Discord, Feishu, Google Chat, iMessage, Mattermost, Microsoft Teams,
   QQ Bot, Signal, Slack, Telegram, WhatsApp, and more.
3. **Daemon** - installs a LaunchAgent (macOS), a systemd user unit
   (Linux/WSL2), or a native Windows Scheduled Task with a per-user
   Startup-folder fallback.
   If token auth is required and `gateway.auth.token` is SecretRef-managed,
   daemon install validates it but does not persist a resolved token into
   supervisor service environment metadata; an unresolved SecretRef blocks
   install with guidance. If both `gateway.auth.token` and
   `gateway.auth.password` are set while `gateway.auth.mode` is unset, install
   is blocked until you set the mode explicitly.
4. **Health check** - starts the Gateway and verifies it is reachable.
5. **Search, skills, and hooks** - configures optional capabilities and dependencies.

<Note>
Re-running onboarding does **not** wipe anything unless you explicitly choose
**Reset** (or pass `--reset`). CLI `--reset` defaults to config, credentials,
and sessions; use `--reset-scope full` to also remove the workspace. If the
config is invalid or contains legacy keys, onboarding asks you to run
`openclaw doctor` first.
</Note>

`--flow import` runs a detected migration flow instead of fresh setup; see
[Migrate](/cli/migrate) and the migration guides under
[Install](/install/migrating-hermes). `openclaw onboard --modern` starts
[Crestodian](/cli/crestodian), a conversational setup/repair assistant, in
place of onboarding.

## Add another agent

Use `openclaw agents add <name>` to create a separate agent with its own
workspace, sessions, and auth profiles. Running without `--workspace` starts
an interactive flow for name, workspace, auth, channels, and bindings - it is
not the full `openclaw onboard` wizard.

What it sets:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notes:

- Default workspace: `~/.openclaw/workspace-<agentId>` (or under
  `agents.defaults.workspace` if that is set).
- Add `bindings` to route inbound messages to this agent (onboarding can do this for you).
- Non-interactive flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Full reference

For detailed step-by-step behavior and config outputs, see
[CLI setup reference](/start/wizard-cli-reference).
For non-interactive examples, see [CLI automation](/start/wizard-cli-automation).
For the full flag reference, see [`openclaw onboard`](/cli/onboard).

## Related docs

- CLI command reference: [`openclaw onboard`](/cli/onboard)
- Onboarding overview: [Onboarding overview](/start/onboarding-overview)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Agent first-run ritual: [Agent Bootstrapping](/start/bootstrapping)
