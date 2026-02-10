---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI onboarding wizard: guided setup for gateway, workspace, channels, and skills"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running or configuring the onboarding wizard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up a new machine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Onboarding Wizard (CLI)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sidebarTitle: "Onboarding: CLI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Onboarding Wizard (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The onboarding wizard is the **recommended** way to set up OpenClaw on macOS,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Linux, or Windows (via WSL2; strongly recommended).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It configures a local Gateway or a remote Gateway connection, plus channels, skills,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and workspace defaults in one guided flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Info>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fastest first chat: open the Control UI (no channel setup needed). Run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw dashboard` and chat in the browser. Docs: [Dashboard](/web/dashboard).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Info>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To reconfigure later:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw configure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents add <name>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--json` does not imply non-interactive mode. For scripts, use `--non-interactive`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended: set up a Brave Search API key so the agent can use `web_search`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(`web_fetch` works without a key). Easiest path: `openclaw configure --section web`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
which stores `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## QuickStart vs Advanced（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wizard starts with **QuickStart** (defaults) vs **Advanced** (full control).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="QuickStart (defaults)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Local gateway (loopback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Workspace default (or existing workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Gateway port **18789**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Gateway auth **Token** (auto‑generated, even on loopback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Tailscale exposure **Off**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Telegram + WhatsApp DMs default to **allowlist** (you'll be prompted for your phone number)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Advanced (full control)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Exposes every step (mode, workspace, gateway, channels, daemon, skills).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What the wizard configures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Local mode (default)** walks you through these steps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Model/Auth** — Anthropic API key (recommended), OpenAI, or Custom Provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   (OpenAI-compatible, Anthropic-compatible, or Unknown auto-detect). Pick a default model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Workspace** — Location for agent files (default `~/.openclaw/workspace`). Seeds bootstrap files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Gateway** — Port, bind address, auth mode, Tailscale exposure.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Channels** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles, or iMessage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Daemon** — Installs a LaunchAgent (macOS) or systemd user unit (Linux/WSL2).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Health check** — Starts the Gateway and verifies it's running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **Skills** — Installs recommended skills and optional dependencies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Re-running the wizard does **not** wipe anything unless you explicitly choose **Reset** (or pass `--reset`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the config is invalid or contains legacy keys, the wizard asks you to run `openclaw doctor` first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Remote mode** only configures the local client to connect to a Gateway elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It does **not** install or change anything on the remote host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Add another agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `openclaw agents add <name>` to create a separate agent with its own workspace,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessions, and auth profiles. Running without `--workspace` launches the wizard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What it sets:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].name`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].agentDir`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default workspaces follow `~/.openclaw/workspace-<agentId>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `bindings` to route inbound messages (the wizard can do this).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Non-interactive flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Full reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For detailed step-by-step breakdowns, non-interactive scripting, Signal setup,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RPC API, and a full list of config fields the wizard writes, see the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Wizard Reference](/reference/wizard).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI command reference: [`openclaw onboard`](/cli/onboard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding overview: [Onboarding Overview](/start/onboarding-overview)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS app onboarding: [Onboarding](/start/onboarding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent first-run ritual: [Agent Bootstrapping](/start/bootstrapping)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
