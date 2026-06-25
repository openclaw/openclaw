---
summary: "CLI onboarding: minimal first-run setup with an optional advanced infrastructure wizard"
read_when:
  - Running or configuring CLI onboarding
  - Setting up a new machine
title: "Onboarding (CLI)"
sidebarTitle: "Onboarding: CLI"
---

CLI onboarding is the **recommended** terminal setup path for OpenClaw on
macOS, Linux, or Windows. Windows desktop users can also start with
[Windows Hub](/platforms/windows).
It gets a local agent running with the fewest required prompts, then opens that
agent to help configure optional features.

```bash
openclaw onboard
```

## Locale

The CLI wizard localizes fixed onboarding copy. It resolves locale from
`OPENCLAW_LOCALE`, then `LC_ALL`, then `LC_MESSAGES`, then `LANG`, and falls
back to English. Supported wizard locales are `en`, `zh-CN`, and `zh-TW`.

```bash
OPENCLAW_LOCALE=zh-CN openclaw onboard
```

Names and stable identifiers stay literal: `OpenClaw`, `Gateway`, `Tailscale`,
commands, config keys, URLs, provider IDs, model IDs, and plugin/channel labels
are not translated.

<Info>
Fastest first chat: run `openclaw`. After minimal setup, the normal local agent
opens directly.
</Info>

To reconfigure later:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive`.
</Note>

<Tip>
Advanced CLI onboarding includes a web search step where you can pick a provider
such as Brave, DuckDuckGo, Exa, Firecrawl, Gemini, Grok, Kimi, MiniMax Search,
Ollama Web Search, Perplexity, SearXNG, or Tavily. Some providers require an
API key, while others are key-free. You can also configure this later with
`openclaw configure --section web`. Docs: [Web tools](/tools/web).
</Tip>

## Default vs Advanced

Default onboarding runs the minimal QuickStart path. Use
`openclaw onboard --flow advanced` for full infrastructure control.

<Tabs>
  <Tab title="QuickStart (default)">
    - Offers to import supported auth, skills, instructions, and settings from another agent environment
    - Model/auth only when no runnable local agent exists
    - Workspace default (or existing workspace)
    - Local mode
    - Tool policy default for new local setups: `tools.profile: "coding"` (existing explicit profile is preserved)
    - DM isolation default: local onboarding writes `session.dmScope: "per-channel-peer"` when unset. Details: [CLI Setup Reference](/start/wizard-cli-reference#outputs-and-internals)
    - Opens the normal local agent for assisted optional setup

  </Tab>
  <Tab title="Advanced (full control)">
    - Exposes mode, workspace, Gateway, channels, daemon, search, skills, hooks, and health.

  </Tab>
</Tabs>

## What onboarding configures

**Default local mode** performs only the required steps:

1. **Import or Model/Auth** — choose a registered migration source such as Codex, Claude, or Hermes, or set up a model separately. Detected migration sources appear first. Migration previews supported skills, instructions, settings, and other artifacts, and asks separately before importing supported auth credentials. If you skip import, choose any supported provider/auth flow (API key, OAuth, or provider-specific manual auth), including Custom Provider
   (OpenAI-compatible, Anthropic-compatible, or Unknown auto-detect). Pick a default model.
   Security note: if this agent will run tools or process webhook/hooks content, prefer the strongest latest-generation model available and keep tool policy strict. Weaker/older tiers are easier to prompt-inject.
   For non-interactive runs, `--secret-input-mode ref` stores env-backed refs in auth profiles instead of plaintext API key values.
   In non-interactive `ref` mode, the provider env var must be set; passing inline key flags without that env var fails fast.
   In interactive runs, choosing secret reference mode lets you point at either an environment variable or a configured provider ref (`file` or `exec`), with a fast preflight validation before saving.
   For Anthropic, interactive onboarding/configure offers **Anthropic Claude CLI** as the preferred local path and **Anthropic API key** as the recommended production path. Anthropic setup-token also remains available as a supported token-auth path.
2. **Workspace** — Location for agent files (default `~/.openclaw/workspace`). Seeds bootstrap files.
3. **Agent handoff** — Opens the normal local agent with a short request to help finish only the optional setup you need. Runtime-only setup guidance tells the agent to read the current channel inventory, follow the selected channel's official `docsPath`, use guided setup unless the installed CLI exposes every required non-interactive option, and verify the result with a channel probe instead of improvising provider-specific instructions.

**Advanced local mode** additionally walks through:

1. **Gateway** — Port, bind address, auth mode, Tailscale exposure.
   In interactive token mode, choose default plaintext token storage or opt into SecretRef.
   Non-interactive token SecretRef path: `--gateway-token-ref-env <ENV_VAR>`.
2. **Channels** — built-in and official plugin chat channels such as iMessage, Discord, Feishu, Google Chat, Mattermost, Microsoft Teams, QQ Bot, Signal, Slack, Telegram, WhatsApp, and more.
3. **Daemon** — Installs a LaunchAgent (macOS), systemd user unit (Linux/WSL2), or native Windows Scheduled Task with per-user Startup-folder fallback.
   If token auth requires a token and `gateway.auth.token` is SecretRef-managed, daemon install validates it but does not persist the resolved token into supervisor service environment metadata.
   If token auth requires a token and the configured token SecretRef is unresolved, daemon install is blocked with actionable guidance.
   If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, daemon install is blocked until mode is set explicitly.
4. **Health check** — Starts the Gateway and verifies it's running.
5. **Search, skills, and hooks** — Configures optional capabilities and dependencies.

<Note>
Re-running onboarding does **not** wipe anything unless you explicitly choose **Reset** (or pass `--reset`).
CLI `--reset` defaults to config, credentials, and sessions; use `--reset-scope full` to include workspace.
If the config is invalid or contains legacy keys, onboarding asks you to run `openclaw doctor` first.
</Note>

**Remote mode** only configures the local client to connect to a Gateway elsewhere.
It does **not** install or change anything on the remote host.

## Add another agent

Use `openclaw agents add <name>` to create a separate agent with its own workspace,
sessions, and auth profiles. Running without `--workspace` launches onboarding.

What it sets:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notes:

- Default workspaces follow `~/.openclaw/workspace-<agentId>`.
- Add `bindings` to route inbound messages (onboarding can do this).
- Non-interactive flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Full reference

For detailed step-by-step breakdowns and config outputs, see
[CLI Setup Reference](/start/wizard-cli-reference).
For non-interactive examples, see [CLI Automation](/start/wizard-cli-automation).
For the deeper technical reference, including RPC details, see
[Onboarding Reference](/reference/wizard).

## Related docs

- CLI command reference: [`openclaw onboard`](/cli/onboard)
- Onboarding overview: [Onboarding Overview](/start/onboarding-overview)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Agent first-run ritual: [Agent Bootstrapping](/start/bootstrapping)
