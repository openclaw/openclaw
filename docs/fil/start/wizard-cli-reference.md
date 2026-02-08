---
summary: "Kumpletong sanggunian para sa CLI onboarding flow, setup ng auth/model, mga output, at mga internal"
read_when:
  - Kailangan mo ng detalyadong behavior para sa openclaw onboard
  - Nagde-debug ka ng onboarding results o nag-iintegrate ng onboarding clients
title: "Sanggunian sa CLI Onboarding"
sidebarTitle: "Sanggunian ng CLI"
x-i18n:
  source_path: start/wizard-cli-reference.md
  source_hash: 20bb32d6fd952345
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:09Z
---

# Sanggunian sa CLI Onboarding

Ang pahinang ito ang kumpletong sanggunian para sa `openclaw onboard`.
Para sa maikling gabay, tingnan ang [Onboarding Wizard (CLI)](/start/wizard).

## Ano ang ginagawa ng wizard

Ang local mode (default) ay gagabayan ka sa:

- Setup ng model at auth (OpenAI Code subscription OAuth, Anthropic API key o setup token, pati MiniMax, GLM, Moonshot, at mga opsyon sa AI Gateway)
- Lokasyon ng workspace at mga bootstrap file
- Mga setting ng Gateway (port, bind, auth, Tailscale)
- Mga channel at provider (Telegram, WhatsApp, Discord, Google Chat, Mattermost plugin, Signal)
- Pag-install ng daemon (LaunchAgent o systemd user unit)
- Health check
- Setup ng Skills

Ang remote mode ay kino-configure ang makinang ito para kumonekta sa isang gateway sa ibang lugar.
Hindi ito nag-i-install o nagbabago ng anuman sa remote host.

## Mga detalye ng local flow

<Steps>
  <Step title="Pag-detect ng umiiral na config">
    - Kung umiiral ang `~/.openclaw/openclaw.json`, pumili ng Keep, Modify, o Reset.
    - Ang muling pagpapatakbo ng wizard ay hindi magbubura ng anuman maliban kung hayagan mong piliin ang Reset (o magpasa ng `--reset`).
    - Kung invalid ang config o may mga legacy key, hihinto ang wizard at hihilingin na patakbuhin ang `openclaw doctor` bago magpatuloy.
    - Ang Reset ay gumagamit ng `trash` at nag-aalok ng mga saklaw:
      - Config lang
      - Config + credentials + sessions
      - Full reset (inaalis din ang workspace)
  </Step>
  <Step title="Model at auth">
    - Ang buong option matrix ay nasa [Auth and model options](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Default na `~/.openclaw/workspace` (maaaring i-configure).
    - Naghahasik ng mga workspace file na kailangan para sa first-run bootstrap ritual.
    - Layout ng workspace: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Magtatanong para sa port, bind, auth mode, at Tailscale exposure.
    - Inirerekomenda: panatilihing naka-enable ang token auth kahit para sa loopback para kailangan pa ring mag-authenticate ang mga lokal na WS client.
    - I-disable lang ang auth kung lubos mong pinagkakatiwalaan ang bawat lokal na proseso.
    - Ang mga non-loopback bind ay nangangailangan pa rin ng auth.
  </Step>
  <Step title="Mga channel">
    - [WhatsApp](/channels/whatsapp): opsyonal na QR login
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience
    - [Mattermost](/channels/mattermost) plugin: bot token + base URL
    - [Signal](/channels/signal): opsyonal na `signal-cli` install + config ng account
    - [BlueBubbles](/channels/bluebubbles): inirerekomenda para sa iMessage; server URL + password + webhook
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access
    - Seguridad ng DM: default ay pairing. Ang unang DM ay magpapadala ng code; aprubahan via
      `openclaw pairing approve <channel> <code>` o gumamit ng mga allowlist.
  </Step>
  <Step title="Pag-install ng daemon">
    - macOS: LaunchAgent
      - Nangangailangan ng naka-login na user session; para sa headless, gumamit ng custom LaunchDaemon (hindi kasama).
    - Linux at Windows via WSL2: systemd user unit
      - Sinusubukan ng wizard ang `loginctl enable-linger <user>` para manatiling tumatakbo ang gateway pagkatapos mag-logout.
      - Maaaring humingi ng sudo (nagsusulat ng `/var/lib/systemd/linger`); susubukan muna nito nang walang sudo.
    - Pagpili ng runtime: Node (inirerekomenda; kinakailangan para sa WhatsApp at Telegram). Hindi inirerekomenda ang Bun.
  </Step>
  <Step title="Health check">
    - Sinisimulan ang gateway (kung kailangan) at pinapatakbo ang `openclaw health`.
    - Idinadagdag ng `openclaw status --deep` ang mga gateway health probe sa status output.
  </Step>
  <Step title="Skills">
    - Binabasa ang mga available na skill at tinitingnan ang mga kinakailangan.
    - Pinapapili ka ng node manager: npm o pnpm (hindi inirerekomenda ang bun).
    - Nag-i-install ng mga opsyonal na dependency (ang ilan ay gumagamit ng Homebrew sa macOS).
  </Step>
  <Step title="Tapusin">
    - Buod at mga susunod na hakbang, kabilang ang mga opsyon sa iOS, Android, at macOS app.
  </Step>
</Steps>

<Note>
Kung walang GUI na nadetect, ipi-print ng wizard ang mga SSH port-forward instruction para sa Control UI sa halip na magbukas ng browser.
Kung nawawala ang Control UI assets, susubukan ng wizard na i-build ang mga ito; fallback ang `pnpm ui:build` (auto-install ng UI deps).
</Note>

## Mga detalye ng remote mode

Ang remote mode ay kino-configure ang makinang ito para kumonekta sa isang gateway sa ibang lugar.

<Info>
Ang remote mode ay hindi nag-i-install o nagbabago ng anuman sa remote host.
</Info>

Mga ise-set mo:

- URL ng remote gateway (`ws://...`)
- Token kung kailangan ang auth ng remote gateway (inirerekomenda)

<Note>
- Kung loopback-only ang gateway, gumamit ng SSH tunneling o tailnet.
- Mga hint sa discovery:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Mga opsyon sa auth at model

<AccordionGroup>
  <Accordion title="Anthropic API key (inirerekomenda)">
    Gumagamit ng `ANTHROPIC_API_KEY` kung naroroon o hihingi ng key, pagkatapos ay ise-save ito para sa paggamit ng daemon.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: tinitingnan ang Keychain item na "Claude Code-credentials"
    - Linux at Windows: nire-reuse ang `~/.claude/.credentials.json` kung naroroon

    Sa macOS, piliin ang "Always Allow" para hindi ma-block ang mga launchd start.

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Patakbuhin ang `claude setup-token` sa kahit anong makina, pagkatapos ay i-paste ang token.
    Maaari mo itong pangalanan; kapag blanko, gagamit ng default.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Kung umiiral ang `~/.codex/auth.json`, maaaring i-reuse ito ng wizard.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Browser flow; i-paste ang `code#state`.

    Itinatakda ang `agents.defaults.model` sa `openai-codex/gpt-5.3-codex` kapag hindi naka-set ang model o `openai/*`.

  </Accordion>
  <Accordion title="OpenAI API key">
    Gumagamit ng `OPENAI_API_KEY` kung naroroon o hihingi ng key, pagkatapos ay ise-save ito sa
    `~/.openclaw/.env` para mabasa ng launchd.

    Itinatakda ang `agents.defaults.model` sa `openai/gpt-5.1-codex` kapag hindi naka-set ang model, `openai/*`, o `openai-codex/*`.

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Hihingi ng `XAI_API_KEY` at iko-configure ang xAI bilang model provider.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Hihingi ng `OPENCODE_API_KEY` (o `OPENCODE_ZEN_API_KEY`).
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Ise-store ang key para sa iyo.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Hihingi ng `AI_GATEWAY_API_KEY`.
    Mas detalyado: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Hihingi ng account ID, gateway ID, at `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Mas detalyado: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Awtomatikong isinusulat ang config.
    Mas detalyado: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Hihingi ng `SYNTHETIC_API_KEY`.
    Mas detalyado: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot at Kimi Coding">
    Awtomatikong isinusulat ang mga config ng Moonshot (Kimi K2) at Kimi Coding.
    Mas detalyado: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Laktawan">
    Iniiwan ang auth na hindi naka-configure.
  </Accordion>
</AccordionGroup>

Behavior ng model:

- Pumili ng default na model mula sa mga nadetect na opsyon, o manu-manong ilagay ang provider at model.
- Nagpapatakbo ang wizard ng model check at nagbababala kung ang naka-configure na model ay hindi kilala o kulang sa auth.

Mga path ng credential at profile:

- OAuth credentials: `~/.openclaw/credentials/oauth.json`
- Mga auth profile (API key + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Tip para sa headless at server: tapusin ang OAuth sa isang makinang may browser, pagkatapos ay kopyahin ang
`~/.openclaw/credentials/oauth.json` (o `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
papunta sa host ng Gateway.
</Note>

## Mga output at internals

Mga karaniwang field sa `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (kung Minimax ang pinili)
- `gateway.*` (mode, bind, auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Mga channel allowlist (Slack, Discord, Matrix, Microsoft Teams) kapag nag-opt in ka sa mga prompt (ang mga pangalan ay nireresolba sa mga ID kung posible)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

Isinusulat ng `openclaw agents add` ang `agents.list[]` at opsyonal na `bindings`.

Ang mga credential ng WhatsApp ay napupunta sa ilalim ng `~/.openclaw/credentials/whatsapp/<accountId>/`.
Ang mga session ay naka-store sa ilalim ng `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Ang ilang channel ay dinideliver bilang mga plugin. Kapag pinili sa panahon ng onboarding, hihingi ang wizard
na i-install ang plugin (npm o lokal na path) bago ang configuration ng channel.
</Note>

Gateway wizard RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Maaaring i-render ng mga client (macOS app at Control UI) ang mga hakbang nang hindi muling ini-implement ang onboarding logic.

Behavior ng Signal setup:

- Dina-download ang naaangkop na release asset
- Ini-store ito sa ilalim ng `~/.openclaw/tools/signal-cli/<version>/`
- Isinusulat ang `channels.signal.cliPath` sa config
- Nangangailangan ang mga JVM build ng Java 21
- Ginagamit ang mga native build kapag available
- Gumagamit ang Windows ng WSL2 at sinusunod ang Linux signal-cli flow sa loob ng WSL

## Kaugnay na docs

- Onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)
- Automation at mga script: [CLI Automation](/start/wizard-cli-automation)
- Sanggunian ng command: [`openclaw onboard`](/cli/onboard)
