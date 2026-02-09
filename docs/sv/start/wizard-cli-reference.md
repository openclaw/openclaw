---
summary: "Fullständig referens för CLI‑introduktionsflöde, autentisering/modellkonfiguration, utdata och internals"
read_when:
  - Du behöver detaljerat beteende för openclaw‑introduktion
  - Du felsöker introduktionsresultat eller integrerar introduktionsklienter
title: "CLI‑referens för introduktion"
sidebarTitle: "CLI‑referens"
---

# CLI‑referens för introduktion

Denna sida är den fullständiga referensen för `openclaw onboard`.
För den korta guiden, se [Onboarding Wizard (CLI)](/start/wizard).

## Vad guiden gör

Lokalt läge (standard) leder dig genom:

- Modell- och autentiseringskonfiguration (OpenAI Code‑prenumeration OAuth, Anthropic API‑nyckel eller setup‑token, samt MiniMax, GLM, Moonshot och AI Gateway‑alternativ)
- Arbetsytans plats och bootstrap‑filer
- Gateway‑inställningar (port, bind, auth, Tailscale)
- Kanaler och leverantörer (Telegram, WhatsApp, Discord, Google Chat, Mattermost‑plugin, Signal)
- Installation av daemon (LaunchAgent eller systemd‑användarenhet)
- Hälsokontroll
- Skills‑konfiguration

Fjärrläge konfigurerar den här maskinen för att ansluta till en gateway någon annanstans.
Det inte installera eller ändra något på fjärrvärden.

## Detaljer för lokalt flöde

<Steps>
  <Step title="Existing config detection">
    - Om `~/.openclaw/openclaw.json` finns, välj Keep, Modifiera eller Återställ.
    - Att köra om guiden torkar inte någonting om du inte uttryckligen väljer Återställ (eller skicka `--reset`).
    - Om konfigurationen är ogiltig eller innehåller äldre nycklar, stannar guiden och ber dig att köra `openclaw doctor` innan du fortsätter.
    - Återställ använder `trash` och erbjuder omfattning:
      - Endast Config
      - Config + autentiseringsuppgifter + sessioner
      - Fullständig återställning (tar också bort arbetsytan)  
</Step>
  <Step title="Model and auth">
    - Fullständig alternativmatris finns i [Autentiserings- och modellalternativ](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Standard `~/.openclaw/workspace` (konfigurerbar).
    - Frön arbetsytefiler som behövs för första körda bootstrap ritual.
    - Arbetsytans layout: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Prompts för port, bind, auth-läge och skräddarsydd exponering.
    - Rekommenderas: hålla token auth aktiverad även för loopback så lokala WS-klienter måste autentisera.
    - Inaktivera auth endast om du helt litar på varje lokal process.
    - Icke-loopback binder fortfarande kräver auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): valfri QR-inloggning
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): servicekonto JSON + webhook-publik
    - [Mattermost](/channels/mattermost) plugin: bot token + bas-URL
    - [Signal](/channels/signal): valfri `signal-cli` install + account config
    - [BlueBubbles](/channels/bluebubbles): rekommenderas för iMessage; server-URL + lösenord + webhook
    - [iMessage](/channels/imessage): äldre `imsg` CLI-sökväg + DB-åtkomst
    - DM-säkerhet: standard paras. Första DM skickar en kod; godkänna via
      `openclaw parkoppling godkänna <channel><code>` eller använd tillåtelselistor.
  </Step><code>` eller använd tillåtna listor.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Kräver inloggad användarsession; för huvudlös, använd en anpassad LaunchDaemon (inte levererad).
    - Linux och Windows via WSL2: systemdanvändarenhet
      - Wizard försöker `loginctl enable-linger <user>` så gateway stannar upp efter utloggning.
      - Kan fråga om sudo (skriver `/var/lib/systemd/linger`); den försöker utan sudo först.
    - Runtime val: Node (rekommenderas; krävs för WhatsApp och Telegram). Bun rekommenderas inte.
  </Step>
  <Step title="Health check">
    - Startar gateway (om det behövs) och kör `openclaw health`.
    - `openclaw status --deep` lägger till gateway hälso-sonder till statusutgång.
  </Step>
  <Step title="Skills">
    - Läser tillgängliga färdigheter och kontroller krav.
    - Kan du välja nod manager: npm eller pnpm (bun rekommenderas inte).
    - Installerar valfria beroenden (vissa använder Homebrew på macOS).
  </Step>
  <Step title="Finish">
    - Sammanfattning och nästa steg, inklusive iOS, Android och macOS app-alternativ.
  </Step>
</Steps>

<Note>
Om ingen GUI upptäcks, guiden skriver ut SSH port-forward instruktioner för Control UI istället för att öppna en webbläsare.
Om UI-tillgångar saknas försöker guiden bygga dem; reservationen är `pnpm ui:build` (auto-installs UI deps).
</Note>

## Detaljer för fjärrläge

Fjärrläge konfigurerar den här maskinen för att ansluta till en gateway någon annanstans.

<Info>
Fjärrläge installerar eller ändrar ingenting på fjärrvärden.
</Info>

Det du anger:

- URL till fjärrgateway (`ws://...`)
- Token om fjärrgateway‑auth krävs (rekommenderas)

<Note>
- Om gateway är loopback-endast, använd SSH-tunneling eller en tailnet.
- Upptäcktledtrådar:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Autentiserings- och modellalternativ

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Använder `ANTHROPIC_API_KEY` om den finns eller ber om en nyckel och sparar den sedan för daemon‑användning.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: kontrollerar nyckelringsposten ”Claude Code‑credentials”
    - Linux och Windows: återanvänder `~/.claude/.credentials.json` om den finns

    ```
    På macOS, välj ”Always Allow” så att launchd‑starter inte blockeras.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Kör `claude setup-token` på någon maskin, klistra sedan in token.
    Du kan namnge det; tomt använder standard.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Om `~/.codex/auth.json` finns kan guiden återanvända den.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Webbläsarflöde; klistra in `code#state`.

    ```
    Sätter `agents.defaults.model` till `openai-codex/gpt-5.3-codex` när modellen är osatt eller `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Använder `OPENAI_API_KEY` om den finns eller ber om en nyckel och sparar den sedan till
    `~/.openclaw/.env` så att launchd kan läsa den.

    ```
    Sätter `agents.defaults.model` till `openai/gpt-5.1-codex` när modellen är osatt, `openai/*` eller `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Ber om `XAI_API_KEY` och konfigurerar xAI som modellleverantör.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Prompts för `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`).
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Lagrar nyckeln åt dig.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Prompts för `AI_GATEWAY_API_KEY`.
    Mer detalj: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Prompts för konto-ID, gateway-ID och `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Mer detalj: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Konfigurationen är auto-skriven.
    Mer detalj: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Prompts för `SYNTHETIC_API_KEY`.
    Mer detalj: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) och Kimi kodning konfigurationer är automatiskt skrivna.
    Mer detalj: [Moonshot AI (Kimi + Kimi kodning)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Lämnar autentisering okonfigurerad.
  </Accordion>
</AccordionGroup>

Modellbeteende:

- Välj standardmodell från upptäckta alternativ eller ange leverantör och modell manuellt.
- Guiden kör en modellkontroll och varnar om den konfigurerade modellen är okänd eller saknar autentisering.

Sökvägar för autentiseringsuppgifter och profiler:

- OAuth‑uppgifter: `~/.openclaw/credentials/oauth.json`
- Autentiseringsprofiler (API‑nycklar + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Tips för headless och server: slutför OAuth på en maskin med webbläsare och kopiera sedan
`~/.openclaw/credentials/oauth.json` (eller `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
till gateway‑värden.
</Note>

## Utdata och internals

Typiska fält i `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (om Minimax valts)
- `gateway.*` (läge, bind, auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Kanal‑tillåtelselistor (Slack, Discord, Matrix, Microsoft Teams) när du väljer det under frågorna (namn löses till ID när möjligt)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` skriver `agents.list[]` och valfri `bindings`.

WhatsApp-uppgifter går under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessioner lagras under `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Vissa kanaler levereras som plugins. När den är markerad under registrering, uppmanar guiden
att installera plugin (npm eller lokal sökväg) innan kanalkonfiguration.
</Note>

Gateway‑guide RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Klienter (macOS‑appen och Control UI) kan rendera steg utan att återimplementera introduktionslogiken.

Signal‑konfigurationsbeteende:

- Laddar ned lämplig release‑asset
- Lagrar den under `~/.openclaw/tools/signal-cli/<version>/`
- Skriver `channels.signal.cliPath` i konfigurationen
- JVM‑byggen kräver Java 21
- Native‑byggen används när tillgängliga
- Windows använder WSL2 och följer Linux signal‑cli‑flödet inuti WSL

## Relaterad dokumentation

- Introduktionsnav: [Onboarding Wizard (CLI)](/start/wizard)
- Automatisering och skript: [CLI Automation](/start/wizard-cli-automation)
- Kommandoreferens: [`openclaw onboard`](/cli/onboard)
