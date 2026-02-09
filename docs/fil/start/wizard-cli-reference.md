---
summary: "Kumpletong sanggunian para sa CLI onboarding flow, setup ng auth/model, mga output, at mga internal"
read_when:
  - Kailangan mo ng detalyadong behavior para sa openclaw onboard
  - Nagde-debug ka ng onboarding results o nag-iintegrate ng onboarding clients
title: "Sanggunian sa CLI Onboarding"
sidebarTitle: "Sanggunian ng CLI"
---

# Sanggunian sa CLI Onboarding

Ang pahinang ito ang kumpletong reference para sa `openclaw onboard`.
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
  <Step title="Existing config detection">
    - Kung umiiral ang `~/.openclaw/openclaw.json`, pumili ng Keep, Modify, o Reset.
    - Ang muling pagpapatakbo ng wizard ay hindi nagbubura ng anuman maliban kung tahasan mong piliin ang Reset (o ipasa ang `--reset`).
    - Kung hindi valid ang config o may taglay na legacy keys, hihinto ang wizard at hihilingin na patakbuhin mo ang `openclaw doctor` bago magpatuloy.
    - Gumagamit ang Reset ng `trash` at nag-aalok ng mga saklaw:
      - Config lang
      - Config + credentials + mga session
      - Full reset (inaalis din ang workspace)  
</Step>
  <Step title="Model and auth">
    - Ang buong option matrix ay nasa [Auth and model options](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Default na `~/.openclaw/workspace` (maaaring i-configure).
    - Seeds workspace files needed for first-run bootstrap ritual.
    - Layout ng workspace: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Prompts for port, bind, auth mode, and tailscale exposure.
    - Recommended: keep token auth enabled even for loopback so local WS clients must authenticate.
    - Disable auth only if you fully trust every local process.
    - Non-loopback binds still require auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience
    - [Mattermost](/channels/mattermost) plugin: bot token + base URL
    - [Signal](/channels/signal): optional `signal-cli` install + account config
    - [BlueBubbles](/channels/bluebubbles): recommended for iMessage; server URL + password + webhook
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access
    - DM security: default is pairing. First DM sends a code; approve via
      `openclaw pairing approve <channel><code>` o gumamit ng mga allowlist.
  </Step><code>` or use allowlists.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux and Windows via WSL2: systemd user unit
      - Wizard attempts `loginctl enable-linger <user>` so gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - Runtime selection: Node (recommended; required for WhatsApp and Telegram). 1. Hindi inirerekomenda ang Bun.
  2. </Step>
  <Step title="Health check">
    - Sinisimulan ang gateway (kung kailangan) at pinapatakbo ang `openclaw health`.
    - `openclaw status --deep` adds gateway health probes to status output.
  3. </Step>
  <Step title="Skills">
    - Binabasa ang mga available na skill at sinusuri ang mga kinakailangan.
    4. - Pinapapili ka ng node manager: npm o pnpm (hindi inirerekomenda ang bun).
    5. - Nag-i-install ng mga opsyonal na dependency (ang ilan ay gumagamit ng Homebrew sa macOS).
  6. </Step>
  <Step title="Finish">
    - Buod at mga susunod na hakbang, kabilang ang mga opsyon para sa iOS, Android, at macOS app.
  </Step>
</Steps>

<Note>
7. Kung walang nakitang GUI, ipiniprint ng wizard ang mga tagubilin sa SSH port-forward para sa Control UI sa halip na magbukas ng browser.
If Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
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
8. - Kung loopback-only ang gateway, gumamit ng SSH tunneling o isang tailnet.
- Discovery hints:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Mga opsyon sa auth at model

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Gumagamit ng `ANTHROPIC_API_KEY` kung naroroon o hihingi ng key, pagkatapos ay ise-save ito para sa paggamit ng daemon.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: tinitingnan ang Keychain item na "Claude Code-credentials"
    - Linux at Windows: nire-reuse ang `~/.claude/.credentials.json` kung naroroon

    ```
    Sa macOS, piliin ang "Always Allow" para hindi ma-block ang mga launchd start.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Run `claude setup-token` on any machine, then paste the token.
    9. Maaari mo itong pangalanan; kapag blangko, gagamit ng default.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Kung umiiral ang `~/.codex/auth.json`, maaaring i-reuse ito ng wizard.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Browser flow; i-paste ang `code#state`.

    ```
    Itinatakda ang `agents.defaults.model` sa `openai-codex/gpt-5.3-codex` kapag hindi naka-set ang model o `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Gumagamit ng `OPENAI_API_KEY` kung naroroon o hihingi ng key, pagkatapos ay ise-save ito sa
    `~/.openclaw/.env` para mabasa ng launchd.

    ```
    Itinatakda ang `agents.defaults.model` sa `openai/gpt-5.1-codex` kapag hindi naka-set ang model, `openai/*`, o `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Hihingi ng `XAI_API_KEY` at iko-configure ang xAI bilang model provider.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`).
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Ise-store ang key para sa iyo.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    10. Hihingi ng `AI_GATEWAY_API_KEY`.
    More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Prompts for account ID, gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Config is auto-written.
    11. Mas detalyado: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    12. Hihingi ng `SYNTHETIC_API_KEY`.
    More detail: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) and Kimi Coding configs are auto-written.
    More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
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

WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Some channels are delivered as plugins. When selected during onboarding, the wizard
prompts to install the plugin (npm or local path) before channel configuration.
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
