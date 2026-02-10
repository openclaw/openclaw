---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Complete reference for CLI onboarding flow, auth/model setup, outputs, and internals"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need detailed behavior for openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are debugging onboarding results or integrating onboarding clients（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "CLI Onboarding Reference"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sidebarTitle: "CLI reference"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# CLI Onboarding Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page is the full reference for `openclaw onboard`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For the short guide, see [Onboarding Wizard (CLI)](/start/wizard).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What the wizard does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local mode (default) walks you through:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model and auth setup (OpenAI Code subscription OAuth, Anthropic API key or setup token, plus MiniMax, GLM, Moonshot, and AI Gateway options)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workspace location and bootstrap files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway settings (port, bind, auth, tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels and providers (Telegram, WhatsApp, Discord, Google Chat, Mattermost plugin, Signal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daemon install (LaunchAgent or systemd user unit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Health check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote mode configures this machine to connect to a gateway elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It does not install or modify anything on the remote host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Local flow details（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Existing config detection">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - If `~/.openclaw/openclaw.json` exists, choose Keep, Modify, or Reset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Re-running the wizard does not wipe anything unless you explicitly choose Reset (or pass `--reset`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - If config is invalid or contains legacy keys, the wizard stops and asks you to run `openclaw doctor` before continuing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Reset uses `trash` and offers scopes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Config only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Config + credentials + sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Full reset (also removes workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Model and auth">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Full option matrix is in [Auth and model options](#auth-and-model-options).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Workspace">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Default `~/.openclaw/workspace` (configurable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Seeds workspace files needed for first-run bootstrap ritual.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Workspace layout: [Agent workspace](/concepts/agent-workspace).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Gateway">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Prompts for port, bind, auth mode, and tailscale exposure.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Recommended: keep token auth enabled even for loopback so local WS clients must authenticate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Disable auth only if you fully trust every local process.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Non-loopback binds still require auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Channels">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [WhatsApp](/channels/whatsapp): optional QR login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Telegram](/channels/telegram): bot token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Discord](/channels/discord): bot token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Mattermost](/channels/mattermost) plugin: bot token + base URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Signal](/channels/signal): optional `signal-cli` install + account config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [BlueBubbles](/channels/bluebubbles): recommended for iMessage; server URL + password + webhook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - DM security: default is pairing. First DM sends a code; approve via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      `openclaw pairing approve <channel> <code>` or use allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Daemon install">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - macOS: LaunchAgent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Requires logged-in user session; for headless, use a custom LaunchDaemon (not shipped).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Linux and Windows via WSL2: systemd user unit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Wizard attempts `loginctl enable-linger <user>` so gateway stays up after logout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Runtime selection: Node (recommended; required for WhatsApp and Telegram). Bun is not recommended.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Health check">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Starts gateway (if needed) and runs `openclaw health`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `openclaw status --deep` adds gateway health probes to status output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Skills">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Reads available skills and checks requirements.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Lets you choose node manager: npm or pnpm (bun not recommended).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Installs optional dependencies (some use Homebrew on macOS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Finish">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Summary and next steps, including iOS, Android, and macOS app options.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote mode details（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote mode configures this machine to connect to a gateway elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Info>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote mode does not install or modify anything on the remote host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Info>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What you set:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote gateway URL (`ws://...`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Token if remote gateway auth is required (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If gateway is loopback-only, use SSH tunneling or a tailnet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discovery hints:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - macOS: Bonjour (`dns-sd`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Linux: Avahi (`avahi-browse`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auth and model options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Anthropic API key (recommended)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Anthropic OAuth (Claude Code CLI)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - macOS: checks Keychain item "Claude Code-credentials"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Linux and Windows: reuses `~/.claude/.credentials.json` if present（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    On macOS, choose "Always Allow" so launchd starts do not block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Anthropic token (setup-token paste)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Run `claude setup-token` on any machine, then paste the token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    You can name it; blank uses default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    If `~/.codex/auth.json` exists, the wizard can reuse it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="OpenAI Code subscription (OAuth)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Browser flow; paste `code#state`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Sets `agents.defaults.model` to `openai-codex/gpt-5.3-codex` when model is unset or `openai/*`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="OpenAI API key">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Uses `OPENAI_API_KEY` if present or prompts for a key, then saves it to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    `~/.openclaw/.env` so launchd can read it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Sets `agents.defaults.model` to `openai/gpt-5.1-codex` when model is unset, `openai/*`, or `openai-codex/*`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="xAI (Grok) API key">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Prompts for `XAI_API_KEY` and configures xAI as a model provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="OpenCode Zen">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="API key (generic)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Stores the key for you.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Vercel AI Gateway">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Prompts for `AI_GATEWAY_API_KEY`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Cloudflare AI Gateway">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Prompts for account ID, gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="MiniMax M2.1">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Config is auto-written.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    More detail: [MiniMax](/providers/minimax).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Synthetic (Anthropic-compatible)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Prompts for `SYNTHETIC_API_KEY`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    More detail: [Synthetic](/providers/synthetic).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Moonshot and Kimi Coding">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Moonshot (Kimi K2) and Kimi Coding configs are auto-written.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Skip">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Leaves auth unconfigured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pick default model from detected options, or enter provider and model manually.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wizard runs a model check and warns if the configured model is unknown or missing auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Credential and profile paths:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OAuth credentials: `~/.openclaw/credentials/oauth.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth profiles (API keys + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Headless and server tip: complete OAuth on a machine with a browser, then copy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/credentials/oauth.json` (or `$OPENCLAW_STATE_DIR/credentials/oauth.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Outputs and internals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Typical fields in `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.model` / `models.providers` (if Minimax chosen)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.*` (mode, bind, auth, tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel allowlists (Slack, Discord, Matrix, Microsoft Teams) when you opt in during prompts (names resolve to IDs when possible)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills.install.nodeManager`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.lastRunAt`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.lastRunVersion`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.lastRunCommit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.lastRunCommand`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.lastRunMode`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw agents add` writes `agents.list[]` and optional `bindings`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sessions are stored under `~/.openclaw/agents/<agentId>/sessions/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some channels are delivered as plugins. When selected during onboarding, the wizard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prompts to install the plugin (npm or local path) before channel configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway wizard RPC:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.start`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.next`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.cancel`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Clients (macOS app and Control UI) can render steps without re-implementing onboarding logic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Signal setup behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Downloads the appropriate release asset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stores it under `~/.openclaw/tools/signal-cli/<version>/`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Writes `channels.signal.cliPath` in config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JVM builds require Java 21（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Native builds are used when available（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows uses WSL2 and follows Linux signal-cli flow inside WSL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Automation and scripts: [CLI Automation](/start/wizard-cli-automation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Command reference: [`openclaw onboard`](/cli/onboard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
