---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Full reference for the CLI onboarding wizard: every step, flag, and config field"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Looking up a specific wizard step or flag（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Automating onboarding with non-interactive mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging wizard behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Onboarding Wizard Reference"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sidebarTitle: "Wizard Reference"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Onboarding Wizard Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the full reference for the `openclaw onboard` CLI wizard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For a high-level overview, see [Onboarding Wizard](/start/wizard).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Flow details (local mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Existing config detection">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - If `~/.openclaw/openclaw.json` exists, choose **Keep / Modify / Reset**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Re-running the wizard does **not** wipe anything unless you explicitly choose **Reset**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      (or pass `--reset`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - If the config is invalid or contains legacy keys, the wizard stops and asks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      you to run `openclaw doctor` before continuing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Reset uses `trash` (never `rm`) and offers scopes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Config only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Config + credentials + sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Full reset (also removes workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Model/Auth">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Anthropic API key (recommended)**: uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Anthropic OAuth (Claude Code CLI)**: on macOS the wizard checks Keychain item "Claude Code-credentials" (choose "Always Allow" so launchd starts don't block); on Linux/Windows it reuses `~/.claude/.credentials.json` if present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Anthropic token (paste setup-token)**: run `claude setup-token` on any machine, then paste the token (you can name it; blank = default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **OpenAI Code (Codex) subscription (Codex CLI)**: if `~/.codex/auth.json` exists, the wizard can reuse it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; paste the `code#state`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Sets `agents.defaults.model` to `openai-codex/gpt-5.2` when model is unset or `openai/*`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **OpenAI API key**: uses `OPENAI_API_KEY` if present or prompts for a key, then saves it to `~/.openclaw/.env` so launchd can read it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **xAI (Grok) API key**: prompts for `XAI_API_KEY` and configures xAI as a model provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **OpenCode Zen (multi-model proxy)**: prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`, get it at https://opencode.ai/auth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **API key**: stores the key for you.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Vercel AI Gateway (multi-model proxy)**: prompts for `AI_GATEWAY_API_KEY`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Cloudflare AI Gateway**: prompts for Account ID, Gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **MiniMax M2.1**: config is auto-written.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - More detail: [MiniMax](/providers/minimax)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - More detail: [Synthetic](/providers/synthetic)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Moonshot (Kimi K2)**: config is auto-written.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Kimi Coding**: config is auto-written.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Skip**: no auth configured yet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Pick a default model from detected options (or enter provider/model manually).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Wizard runs a model check and warns if the configured model is unknown or missing auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - OAuth credentials live in `~/.openclaw/credentials/oauth.json`; auth profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - More detail: [/concepts/oauth](/concepts/oauth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Headless/server tip: complete OAuth on a machine with a browser, then copy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    `~/.openclaw/credentials/oauth.json` (or `$OPENCLAW_STATE_DIR/credentials/oauth.json`) to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Workspace">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Default `~/.openclaw/workspace` (configurable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Seeds the workspace files needed for the agent bootstrap ritual.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Full workspace layout + backup guide: [Agent workspace](/concepts/agent-workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Gateway">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Port, bind, auth mode, tailscale exposure.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Auth recommendation: keep **Token** even for loopback so local WS clients must authenticate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Disable auth only if you fully trust every local process.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Non‑loopback binds still require auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Channels">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [WhatsApp](/channels/whatsapp): optional QR login.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Telegram](/channels/telegram): bot token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Discord](/channels/discord): bot token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [Signal](/channels/signal): optional `signal-cli` install + account config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [BlueBubbles](/channels/bluebubbles): **recommended for iMessage**; server URL + password + webhook.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - DM security: default is pairing. First DM sends a code; approve via `openclaw pairing approve <channel> <code>` or use allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Daemon install">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - macOS: LaunchAgent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Linux (and Windows via WSL2): systemd user unit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - **Runtime selection:** Node (recommended; required for WhatsApp/Telegram). Bun is **not recommended**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Health check">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Starts the Gateway (if needed) and runs `openclaw health`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Tip: `openclaw status --deep` adds gateway health probes to status output (requires a reachable gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Skills (recommended)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Reads the available skills and checks requirements.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Lets you choose a node manager: **npm / pnpm** (bun not recommended).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Installs optional dependencies (some use Homebrew on macOS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Finish">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Summary + next steps, including iOS/Android/macOS apps for extra features.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Non-interactive mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--non-interactive` to automate or script onboarding:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --auth-choice apiKey \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --anthropic-api-key "$ANTHROPIC_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --gateway-bind loopback \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --install-daemon \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --daemon-runtime node \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --skip-skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add `--json` for a machine‑readable summary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--json` does **not** imply non-interactive mode. Use `--non-interactive` (and `--workspace`) for scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Gemini example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice gemini-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gemini-api-key "$GEMINI_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Z.AI example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice zai-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --zai-api-key "$ZAI_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Vercel AI Gateway example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice ai-gateway-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Cloudflare AI Gateway example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice cloudflare-ai-gateway-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --cloudflare-ai-gateway-account-id "your-account-id" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Moonshot example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice moonshot-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --moonshot-api-key "$MOONSHOT_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Synthetic example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice synthetic-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --synthetic-api-key "$SYNTHETIC_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="OpenCode Zen example">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --auth-choice opencode-zen \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --opencode-zen-api-key "$OPENCODE_API_KEY" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-port 18789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      --gateway-bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Add agent (non-interactive)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agents add work \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --workspace ~/.openclaw/workspace-work \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --model openai/gpt-5.2 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --bind whatsapp:biz \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway wizard RPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway exposes the wizard flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Clients (macOS app, Control UI) can render steps without re‑implementing onboarding logic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Signal setup (signal-cli)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wizard can install `signal-cli` from GitHub releases:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Downloads the appropriate release asset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stores it under `~/.openclaw/tools/signal-cli/<version>/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Writes `channels.signal.cliPath` to your config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JVM builds require **Java 21**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Native builds are used when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows uses WSL2; signal-cli install follows the Linux flow inside WSL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What the wizard writes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Typical fields in `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.model` / `models.providers` (if Minimax chosen)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.*` (mode, bind, auth, tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel allowlists (Slack/Discord/Matrix/Microsoft Teams) when you opt in during the prompts (names resolve to IDs when possible).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
Some channels are delivered as plugins. When you pick one during onboarding, the wizard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
will prompt to install it (npm or a local path) before it can be configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wizard overview: [Onboarding Wizard](/start/wizard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS app onboarding: [Onboarding](/start/onboarding)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config reference: [Gateway configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
