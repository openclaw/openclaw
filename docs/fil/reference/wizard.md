---
summary: "Buong reference para sa CLI onboarding wizard: bawat hakbang, flag, at config field"
read_when:
  - Naghahanap ng partikular na hakbang o flag ng wizard
  - Pag-a-automate ng onboarding gamit ang non-interactive mode
  - Pag-debug ng behavior ng wizard
title: "Onboarding Wizard Reference"
sidebarTitle: "Wizard Reference"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:14Z
---

# Onboarding Wizard Reference

Ito ang buong reference para sa `openclaw onboard` CLI wizard.
Para sa high-level na pangkalahatang-ideya, tingnan ang [Onboarding Wizard](/start/wizard).

## Mga detalye ng daloy (local mode)

<Steps>
  <Step title="Pag-detect ng umiiral na config">
    - Kung umiiral ang `~/.openclaw/openclaw.json`, pumili ng **Keep / Modify / Reset**.
    - Ang muling pagpapatakbo ng wizard ay **hindi** nagbubura ng kahit ano maliban kung tahasan mong piliin ang **Reset**
      (o ipasa ang `--reset`).
    - Kung hindi valid ang config o may laman na legacy keys, hihinto ang wizard at hihilingin
      na patakbuhin mo ang `openclaw doctor` bago magpatuloy.
    - Gumagamit ang Reset ng `trash` (hindi kailanman `rm`) at nag-aalok ng mga saklaw:
      - Config lang
      - Config + credentials + sessions
      - Buong reset (tinatanggal din ang workspace)
  </Step>
  <Step title="Model/Auth">
    - **Anthropic API key (inirerekomenda)**: ginagamit ang `ANTHROPIC_API_KEY` kung mayroon, o magpo-prompt para sa key, pagkatapos ay ise-save ito para sa paggamit ng daemon.
    - **Anthropic OAuth (Claude Code CLI)**: sa macOS, chine-check ng wizard ang Keychain item na "Claude Code-credentials" (piliin ang "Always Allow" para hindi ma-block ang launchd starts); sa Linux/Windows, nire-reuse nito ang `~/.claude/.credentials.json` kung mayroon.
    - **Anthropic token (i-paste ang setup-token)**: patakbuhin ang `claude setup-token` sa kahit anong machine, pagkatapos ay i-paste ang token (maaari mo itong pangalanan; blank = default).
    - **OpenAI Code (Codex) subscription (Codex CLI)**: kung umiiral ang `~/.codex/auth.json`, maaaring i-reuse ito ng wizard.
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; i-paste ang `code#state`.
      - Itinatakda ang `agents.defaults.model` sa `openai-codex/gpt-5.2` kapag hindi naka-set ang model o `openai/*`.
    - **OpenAI API key**: ginagamit ang `OPENAI_API_KEY` kung mayroon, o magpo-prompt para sa key, pagkatapos ay ise-save ito sa `~/.openclaw/.env` para mabasa ng launchd.
    - **xAI (Grok) API key**: magpo-prompt para sa `XAI_API_KEY` at iko-configure ang xAI bilang model provider.
    - **OpenCode Zen (multi-model proxy)**: magpo-prompt para sa `OPENCODE_API_KEY` (o `OPENCODE_ZEN_API_KEY`, kunin ito sa https://opencode.ai/auth).
    - **API key**: iniimbak ang key para sa iyo.
    - **Vercel AI Gateway (multi-model proxy)**: magpo-prompt para sa `AI_GATEWAY_API_KEY`.
    - Mas detalyado: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: magpo-prompt para sa Account ID, Gateway ID, at `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Mas detalyado: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: awtomatikong isinusulat ang config.
    - Mas detalyado: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: magpo-prompt para sa `SYNTHETIC_API_KEY`.
    - Mas detalyado: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: awtomatikong isinusulat ang config.
    - **Kimi Coding**: awtomatikong isinusulat ang config.
    - Mas detalyado: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: walang iaaayos na auth sa ngayon.
    - Pumili ng default na model mula sa mga natukoy na opsyon (o manu-manong ilagay ang provider/model).
    - Pinapatakbo ng wizard ang model check at magbababala kung hindi kilala ang naka-configure na model o kulang ang auth.
    - Ang OAuth credentials ay nasa `~/.openclaw/credentials/oauth.json`; ang auth profiles ay nasa `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth).
    - Mas detalyado: [/concepts/oauth](/concepts/oauth)
    <Note>
    Tip para sa headless/server: kumpletuhin ang OAuth sa isang machine na may browser, pagkatapos ay kopyahin ang
    `~/.openclaw/credentials/oauth.json` (o `$OPENCLAW_STATE_DIR/credentials/oauth.json`) papunta sa
    host ng Gateway.
    </Note>
  </Step>
  <Step title="Workspace">
    - Default na `~/.openclaw/workspace` (naa-configure).
    - Nagse-seed ng mga workspace file na kailangan para sa agent bootstrap ritual.
    - Buong layout ng workspace + gabay sa backup: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - Port, bind, auth mode, tailscale exposure.
    - Rekomendasyon sa auth: panatilihin ang **Token** kahit para sa loopback upang kailanganing mag-authenticate ang mga lokal na WS client.
    - I-disable lang ang auth kung lubos mong pinagkakatiwalaan ang bawat lokal na proseso.
    - Ang mga non‑loopback bind ay nangangailangan pa rin ng auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): opsyonal na QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.
    - [Signal](/channels/signal): opsyonal na `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **inirerekomenda para sa iMessage**; server URL + password + webhook.
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access.
    - Seguridad ng DM: default ay pairing. Ang unang DM ay magpapadala ng code; aprubahan via `openclaw pairing approve <channel> <code>` o gumamit ng allowlists.
  </Step>
  <Step title="Pag-install ng daemon">
    - macOS: LaunchAgent
      - Nangangailangan ng naka-log in na user session; para sa headless, gumamit ng custom LaunchDaemon (hindi kasama).
    - Linux (at Windows sa pamamagitan ng WSL2): systemd user unit
      - Sinusubukan ng wizard na i-enable ang lingering sa pamamagitan ng `loginctl enable-linger <user>` upang manatiling up ang Gateway kahit pagkatapos mag-logout.
      - Maaaring mag-prompt para sa sudo (nagsusulat ng `/var/lib/systemd/linger`); sinusubukan muna nito nang walang sudo.
    - **Pagpili ng runtime:** Node (inirerekomenda; kailangan para sa WhatsApp/Telegram). **Hindi inirerekomenda** ang Bun.
  </Step>
  <Step title="Health check">
    - Sinisimulan ang Gateway (kung kailangan) at pinapatakbo ang `openclaw health`.
    - Tip: ang `openclaw status --deep` ay nagdaragdag ng gateway health probes sa status output (nangangailangan ng maaabot na Gateway).
  </Step>
  <Step title="Skills (inirerekomenda)">
    - Binabasa ang mga available na Skills at chine-check ang mga kinakailangan.
    - Hinahayaan kang pumili ng node manager: **npm / pnpm** (hindi inirerekomenda ang bun).
    - Nag-i-install ng mga opsyonal na dependency (ang ilan ay gumagamit ng Homebrew sa macOS).
  </Step>
  <Step title="Tapusin">
    - Buod + mga susunod na hakbang, kabilang ang iOS/Android/macOS apps para sa mga dagdag na tampok.
  </Step>
</Steps>

<Note>
Kung walang GUI na natukoy, ipi-print ng wizard ang mga SSH port-forward instruction para sa Control UI sa halip na magbukas ng browser.
Kung nawawala ang Control UI assets, susubukan ng wizard na i-build ang mga ito; fallback ang `pnpm ui:build` (awtomatikong nag-i-install ng UI deps).
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
Ang `--json` ay **hindi** nangangahulugan ng non-interactive mode. Gamitin ang `--non-interactive` (at `--workspace`) para sa mga script.
</Note>

<AccordionGroup>
  <Accordion title="Halimbawa ng Gemini">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng Z.AI">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng Vercel AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng Cloudflare AI Gateway">
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
  <Accordion title="Halimbawa ng Moonshot">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng Synthetic">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Halimbawa ng OpenCode Zen">
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

Inilalantad ng Gateway ang daloy ng wizard sa pamamagitan ng RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Maaaring i-render ng mga client (macOS app, Control UI) ang mga hakbang nang hindi muling ipinapatupad ang onboarding logic.

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

Ang mga WhatsApp credential ay napupunta sa ilalim ng `~/.openclaw/credentials/whatsapp/<accountId>/`.
Ang mga session ay iniimbak sa ilalim ng `~/.openclaw/agents/<agentId>/sessions/`.

Ang ilang channel ay ipinapadala bilang mga plugin. Kapag pumili ka ng isa sa onboarding, ipo-prompt ka ng wizard
na i-install ito (npm o lokal na path) bago ito ma-configure.

## Kaugnay na docs

- Pangkalahatang-ideya ng wizard: [Onboarding Wizard](/start/wizard)
- Onboarding ng macOS app: [Onboarding](/start/onboarding)
- Reference ng config: [Gateway configuration](/gateway/configuration)
- Mga provider: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
