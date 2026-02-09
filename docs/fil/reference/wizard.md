---
summary: "Buong reference para sa CLI onboarding wizard: bawat hakbang, flag, at config field"
read_when:
  - Naghahanap ng partikular na hakbang o flag ng wizard
  - Pag-a-automate ng onboarding gamit ang non-interactive mode
  - Pag-debug ng behavior ng wizard
title: "Onboarding Wizard Reference"
sidebarTitle: "Wizard Reference"
---

# Onboarding Wizard Reference

Ito ang buong reference para sa `openclaw onboard` CLI wizard.
Para sa high-level na overview, tingnan ang [Onboarding Wizard](/start/wizard).

## Mga detalye ng daloy (local mode)

<Steps>
  <Step title="Existing config detection">
    - If `~/.openclaw/openclaw.json` exists, choose **Keep / Modify / Reset**.
    - Ang muling pagpapatakbo ng wizard ay **hindi** nagbubura ng anuman maliban kung tahasan mong piliin ang **Reset**
      (o ipasa ang `--reset`).
    - Kung ang config ay invalid o naglalaman ng legacy keys, hihinto ang wizard at hihilingin
      na patakbuhin mo ang `openclaw doctor` bago magpatuloy.
    - Reset uses `trash` (never `rm`) and offers scopes:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes workspace)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API key (recommended)**: uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
    - **Anthropic OAuth (Claude Code CLI)**: on macOS the wizard checks Keychain item "Claude Code-credentials" (choose "Always Allow" so launchd starts don't block); on Linux/Windows it reuses `~/.claude/.credentials.json` if present.
    - **Anthropic token (paste setup-token)**: run `claude setup-token` on any machine, then paste the token (you can name it; blank = default).
    - **OpenAI Code (Codex) subscription (Codex CLI)**: if `~/.codex/auth.json` exists, the wizard can reuse it.
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; i-paste ang `code#state`.
      - Itinatakda ang `agents.defaults.model` sa `openai-codex/gpt-5.2` kapag ang model ay hindi nakatakda o `openai/*`.
    - **OpenAI API key**: ginagamit ang `OPENAI_API_KEY` kung naroon o hihingi ng key, pagkatapos ay ise-save ito sa `~/.openclaw/.env` upang mabasa ng launchd.
    - **xAI (Grok) API key**: hihingi ng `XAI_API_KEY` at iko-configure ang xAI bilang model provider.
    - **OpenCode Zen (multi-model proxy)**: hihingi ng `OPENCODE_API_KEY` (o `OPENCODE_ZEN_API_KEY`, kunin ito sa https://opencode.ai/auth).
    - **API key**: stores the key for you.
    - **Vercel AI Gateway (multi-model proxy)**: prompts for `AI_GATEWAY_API_KEY`.
    - More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: prompts for Account ID, Gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config is auto-written.
    - Higit pang detalye: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: hihingi ng `SYNTHETIC_API_KEY`.
    - More detail: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config is auto-written.
    - **Kimi Coding**: config is auto-written.
    - More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: no auth configured yet.
    - Pumili ng default model mula sa mga natukoy na opsyon (o manu-manong ilagay ang provider/model).
    - Nagpapatakbo ang wizard ng model check at nagbababala kung ang naka-configure na model ay hindi kilala o kulang sa auth.
    - Ang mga OAuth credential ay nasa `~/.openclaw/credentials/oauth.json`; ang mga auth profile ay nasa `~/.openclaw/agents/
44. /agent/auth-profiles.json` (API keys + OAuth).<agentId>/agent/auth-profiles.json` (API keys + OAuth).
    - Mas detalyado: [/concepts/oauth](/concepts/oauth)    
<Note>
    Tip para sa headless/server: kumpletuhin ang OAuth sa isang machine na may browser, pagkatapos ay kopyahin ang
    `~/.openclaw/credentials/oauth.json` (o `$OPENCLAW_STATE_DIR/credentials/oauth.json`) papunta sa
    host ng Gateway.
    </Note>
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (configurable).
    - Seeds the workspace files needed for the agent bootstrap ritual.
    - Buong layout ng workspace + gabay sa backup: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Rekomendasyon sa auth: panatilihin ang **Token** kahit para sa loopback upang ang mga lokal na WS client ay kailangang mag-authenticate.
    - I-disable lamang ang auth kung lubos mong pinagkakatiwalaan ang bawat lokal na proseso.
    - Ang mga non‑loopback bind ay nangangailangan pa rin ng auth.
    - Non‑loopback binds still require auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.
    - [Signal](/channels/signal): optional `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **recommended for iMessage**; server URL + password + webhook.
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access.
    - DM security: default is pairing. First DM sends a code; approve via `openclaw pairing approve <channel><code>` o gumamit ng allowlists.
  </Step><code>` o gumamit ng mga allowlist.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux (and Windows via WSL2): systemd user unit
      - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - **Runtime selection:** Node (recommended; required for WhatsApp/Telegram). Bun is **not recommended**.
  </Step>
  <Step title="Health check">
    - Starts the Gateway (if needed) and runs `openclaw health`.
    - Tip: `openclaw status --deep` adds gateway health probes to status output (requires a reachable gateway).
  </Step>
  <Step title="Skills (recommended)">
    - Reads the available skills and checks requirements.
    - Lets you choose a node manager: **npm / pnpm** (bun not recommended).
    - Installs optional dependencies (some use Homebrew on macOS).
  </Step>
  <Step title="Finish">
    - Summary + next steps, including iOS/Android/macOS apps for extra features.
  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
</Note>

## Non-interactive mode

Gamitin ang `--non-interactive` upang i-automate o i-script ang onboarding:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Idagdag ang `--json` para sa machine‑readable na buod.

<Note>
`--json` does **not** imply non-interactive mode. Use `--non-interactive` (and `--workspace`) for scripts.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Magdagdag ng agent (non-interactive)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

The Gateway exposes the wizard flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clients (macOS app, Control UI) can render steps without re‑implementing onboarding logic.

## Signal setup (signal-cli)

Maaaring i-install ng wizard ang `signal-cli` mula sa GitHub releases:

- Dina-download ang angkop na release asset.
- Iniimbak ito sa ilalim ng `~/.openclaw/tools/signal-cli/<version>/`.
- Isinusulat ang `channels.signal.cliPath` sa iyong config.

Mga tala:

- Nangangailangan ang JVM builds ng **Java 21**.
- Ginagamit ang native builds kapag available.
- Gumagamit ang Windows ng WSL2; ang pag-install ng signal-cli ay sumusunod sa daloy ng Linux sa loob ng WSL.

## Ano ang isinusulat ng wizard

Mga tipikal na field sa `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (kung Minimax ang pinili)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Mga channel allowlist (Slack/Discord/Matrix/Microsoft Teams) kapag nag-opt in ka sa mga prompt (ang mga pangalan ay nireresolba sa mga ID kapag posible).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

Ang `openclaw agents add` ay nagsusulat ng `agents.list[]` at opsyonal na `bindings`.

WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.openclaw/agents/<agentId>/sessions/`.

Some channels are delivered as plugins. When you pick one during onboarding, the wizard
will prompt to install it (npm or a local path) before it can be configured.

## Kaugnay na docs

- Pangkalahatang-ideya ng wizard: [Onboarding Wizard](/start/wizard)
- Onboarding ng macOS app: [Onboarding](/start/onboarding)
- Reference ng config: [Gateway configuration](/gateway/configuration)
- Mga provider: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
