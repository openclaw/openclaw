---
summary: "CLI onboarding wizard: guided setup for gateway, workspace, channels, and skills"
read_when:
  - Running or configuring the onboarding wizard
  - Setting up a new machine
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Onboarding Wizard (CLI)

The onboarding wizard is the **recommended** way to set up OpenClaw on macOS,
Linux, or Windows (via WSL2; strongly recommended).
It configures a local Gateway or a remote Gateway connection, plus channels, skills,
and workspace defaults in one guided flow.

```bash
openclaw onboard
```

<Info>
Fastest first chat: open the Control UI (no channel setup needed). Run
`openclaw dashboard` and chat in the browser. Docs: [Dashboard](/web/dashboard).
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
Recommended: set up a Brave Search API key so the agent can use `web_search`
(`web_fetch` works without a key). Easiest path: `openclaw configure --section web`
which stores `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
</Tip>

## QuickStart vs Advanced

The wizard starts with **QuickStart** (defaults) vs **Advanced** (full control).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Local gateway (loopback)
    - Workspace default (or existing workspace)
    - Gateway port **18789**
    - Gateway auth **Token** (auto‑generated, even on loopback)
    - Tailscale exposure **Off**
    - Telegram + WhatsApp DMs default to **allowlist** (you'll be prompted for your phone number)
  </Tab>
  <Tab title="Advanced (full control)">
    - Exposes every step (mode, workspace, gateway, channels, daemon, skills).
  </Tab>
</Tabs>

## Pre-flight Checks

Before starting the wizard, OpenClaw runs pre-flight checks to validate prerequisites:

- **Node.js version** — Ensures Node 22.12.0 or newer is installed
- **Config directory permissions** — Verifies write access to `~/.openclaw`
- **Workspace directory permissions** — Ensures workspace directory is accessible
- **Network connectivity** — Checks internet access for OAuth flows (optional)
- **Gateway port availability** — Verifies default port 18789 is free (optional)
- **Existing config validity** — Validates any existing config file (optional)

Required checks must pass before onboarding continues. Optional checks provide warnings but don't block the wizard.

Skip checks with flags:
- `--skip-preflight` — Skip all pre-flight checks
- `--skip-preflight-network` — Skip network connectivity check
- `--skip-preflight-port` — Skip port availability check

## Error Recovery

The wizard includes automatic error recovery for common issues:

- **Network errors** — Offers retry for transient connectivity issues
- **Permission errors** — Provides fix suggestions with commands
- **Config errors** — Suggests running `openclaw doctor` to repair
- **Port conflicts** — Allows continuing with port configuration during setup
- **OAuth errors** — Guides through re-authentication

When an error occurs, the wizard will:
1. Categorize the error type
2. Suggest recovery actions
3. Offer retry, skip, or abort options
4. Provide links to relevant documentation

## What the wizard configures

**Local mode (default)** walks you through these steps:

1. **Model/Auth** — Anthropic API key (recommended), OpenAI, or Custom Provider
   (OpenAI-compatible, Anthropic-compatible, or Unknown auto-detect). Pick a default model.
2. **Workspace** — Location for agent files (default `~/.openclaw/workspace`). Seeds bootstrap files.
3. **Gateway** — Port, bind address, auth mode, Tailscale exposure.
4. **Channels** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles, or iMessage.
5. **Daemon** — Installs a LaunchAgent (macOS) or systemd user unit (Linux/WSL2).
6. **Health check** — Starts the Gateway and verifies it's running.
7. **Skills** — Installs recommended skills and optional dependencies.

<Note>
Re-running the wizard does **not** wipe anything unless you explicitly choose **Reset** (or pass `--reset`).
If the config is invalid or contains legacy keys, the wizard asks you to run `openclaw doctor` first.
</Note>

**Remote mode** only configures the local client to connect to a Gateway elsewhere.
It does **not** install or change anything on the remote host.

## Post-Onboarding Verification

After completing the wizard, OpenClaw runs a verification suite to ensure everything is set up correctly:

- **Gateway reachability** — Tests WebSocket connection to the gateway
- **Config validation** — Verifies the written config file is valid
- **Workspace accessibility** — Confirms workspace directory is readable/writable
- **Provider connectivity** — Checks that AI provider credentials are configured
- **Channel status** — Verifies configured channels are properly set up

Verification results are displayed with clear pass/fail indicators. If any checks fail, the wizard provides specific guidance on how to fix the issues.

Skip verification with `--skip-verify` flag.

## Next Steps Guide

After successful onboarding, you'll see a personalized "What's Next?" guide that includes:

- **Setup status** — Summary of what was configured
- **Useful commands** — Quick reference for common tasks
- **Helpful links** — Documentation and resources relevant to your setup

The guide is tailored based on:
- Your chosen flow (QuickStart vs Advanced)
- Which features you enabled (channels, skills, web search)
- Verification results

## Troubleshooting

### Common Issues

**Pre-flight checks fail:**
- Check Node version: `node --version` (must be >= 22.12.0)
- Verify permissions: `ls -la ~/.openclaw`
- Fix permissions: `chmod 755 ~/.openclaw`

**Gateway not reachable:**
- Check if gateway is running: `openclaw gateway status`
- Start gateway: `openclaw gateway run`
- Check port conflicts: `lsof -i :18789`

**Config validation errors:**
- Run config doctor: `openclaw doctor`
- View config issues: `openclaw doctor --deep`
- Repair config: `openclaw doctor --fix`

**Permission errors:**
- Ensure you have write access to config directory
- Check workspace directory permissions
- Verify file ownership if running as different user

**Network/OAuth errors:**
- Check internet connectivity
- Verify firewall settings
- Retry OAuth flow: `openclaw configure --section agents`

For more help, see [Troubleshooting](/gateway/troubleshooting) and [FAQ](/help/faq).

## Add another agent

Use `openclaw agents add <name>` to create a separate agent with its own workspace,
sessions, and auth profiles. Running without `--workspace` launches the wizard.

What it sets:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notes:

- Default workspaces follow `~/.openclaw/workspace-<agentId>`.
- Add `bindings` to route inbound messages (the wizard can do this).
- Non-interactive flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Full reference

For detailed step-by-step breakdowns, non-interactive scripting, Signal setup,
RPC API, and a full list of config fields the wizard writes, see the
[Wizard Reference](/reference/wizard).

## Related docs

- CLI command reference: [`openclaw onboard`](/cli/onboard)
- Onboarding overview: [Onboarding Overview](/start/onboarding-overview)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Agent first-run ritual: [Agent Bootstrapping](/start/bootstrapping)
