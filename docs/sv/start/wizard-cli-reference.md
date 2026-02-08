---
summary: "Fullständig referens för CLI‑introduktionsflöde, autentisering/modellkonfiguration, utdata och internals"
read_when:
  - Du behöver detaljerat beteende för openclaw‑introduktion
  - Du felsöker introduktionsresultat eller integrerar introduktionsklienter
title: "CLI‑referens för introduktion"
sidebarTitle: "CLI‑referens"
x-i18n:
  source_path: start/wizard-cli-reference.md
  source_hash: 20bb32d6fd952345
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:45Z
---

# CLI‑referens för introduktion

Den här sidan är den fullständiga referensen för `openclaw onboard`.
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
Det installerar eller ändrar ingenting på fjärrvärden.

## Detaljer för lokalt flöde

<Steps>
  <Step title="Identifiering av befintlig konfiguration">
    - Om `~/.openclaw/openclaw.json` finns, välj Behåll, Ändra eller Återställ.
    - Att köra guiden igen raderar ingenting om du inte uttryckligen väljer Återställ (eller skickar `--reset`).
    - Om konfigurationen är ogiltig eller innehåller äldre nycklar stoppar guiden och ber dig köra `openclaw doctor` innan du fortsätter.
    - Återställ använder `trash` och erbjuder omfattningar:
      - Endast konfiguration
      - Konfiguration + autentiseringsuppgifter + sessioner
      - Full återställning (tar även bort arbetsytan)
  </Step>
  <Step title="Modell och autentisering">
    - Fullständig alternativmatris finns i [Autentiserings- och modellalternativ](#auth-and-model-options).
  </Step>
  <Step title="Arbetsyta">
    - Standard `~/.openclaw/workspace` (konfigurerbar).
    - Sår arbetsytefiler som behövs för bootstrap‑ritualen vid första körningen.
    - Arbetsytans layout: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Frågar efter port, bind, autentiseringsläge och Tailscale‑exponering.
    - Rekommenderat: behåll token‑auth aktiverad även för loopback så att lokala WS‑klienter måste autentisera.
    - Inaktivera autentisering endast om du fullt ut litar på varje lokal process.
    - Bindningar som inte är loopback kräver fortfarande autentisering.
  </Step>
  <Step title="Kanaler">
    - [WhatsApp](/channels/whatsapp): valfri QR‑inloggning
    - [Telegram](/channels/telegram): bot‑token
    - [Discord](/channels/discord): bot‑token
    - [Google Chat](/channels/googlechat): servicekonto‑JSON + webhook‑audience
    - [Mattermost](/channels/mattermost)‑plugin: bot‑token + bas‑URL
    - [Signal](/channels/signal): valfri installation av `signal-cli` + kontokonfiguration
    - [BlueBubbles](/channels/bluebubbles): rekommenderad för iMessage; server‑URL + lösenord + webhook
    - [iMessage](/channels/imessage): äldre `imsg` CLI‑sökväg + DB‑åtkomst
    - DM‑säkerhet: standard är parning. Första DM skickar en kod; godkänn via
      `openclaw pairing approve <channel> <code>` eller använd tillåtelselistor.
  </Step>
  <Step title="Installation av daemon">
    - macOS: LaunchAgent
      - Kräver inloggad användarsession; för headless, använd en anpassad LaunchDaemon (levereras inte).
    - Linux och Windows via WSL2: systemd‑användarenhet
      - Guiden försöker `loginctl enable-linger <user>` så att gatewayn fortsätter efter utloggning.
      - Kan be om sudo (skriver `/var/lib/systemd/linger`); den försöker utan sudo först.
    - Val av runtime: Node (rekommenderas; krävs för WhatsApp och Telegram). Bun rekommenderas inte.
  </Step>
  <Step title="Hälsokontroll">
    - Startar gatewayn (om behövs) och kör `openclaw health`.
    - `openclaw status --deep` lägger till gateway‑hälsoprober i statusutdata.
  </Step>
  <Step title="Skills">
    - Läser tillgängliga Skills och kontrollerar krav.
    - Låter dig välja node‑manager: npm eller pnpm (bun rekommenderas inte).
    - Installerar valfria beroenden (vissa använder Homebrew på macOS).
  </Step>
  <Step title="Slutför">
    - Sammanfattning och nästa steg, inklusive iOS‑, Android‑ och macOS‑appalternativ.
  </Step>
</Steps>

<Note>
Om inget GUI upptäcks skriver guiden ut SSH‑portforward‑instruktioner för Control UI i stället för att öppna en webbläsare.
Om Control UI‑resurser saknas försöker guiden bygga dem; reservlösningen är `pnpm ui:build` (installerar UI‑beroenden automatiskt).
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
- Om gatewayn är endast loopback, använd SSH‑tunnling eller ett tailnet.
- Discovery‑tips:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Autentiserings- och modellalternativ

<AccordionGroup>
  <Accordion title="Anthropic API‑nyckel (rekommenderas)">
    Använder `ANTHROPIC_API_KEY` om den finns eller ber om en nyckel och sparar den sedan för daemon‑användning.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: kontrollerar nyckelringsposten ”Claude Code‑credentials”
    - Linux och Windows: återanvänder `~/.claude/.credentials.json` om den finns

    På macOS, välj ”Always Allow” så att launchd‑starter inte blockeras.

  </Accordion>
  <Accordion title="Anthropic‑token (klistra in setup‑token)">
    Kör `claude setup-token` på valfri maskin och klistra sedan in token.
    Du kan namnge den; tomt använder standard.
  </Accordion>
  <Accordion title="OpenAI Code‑prenumeration (återanvänd Codex CLI)">
    Om `~/.codex/auth.json` finns kan guiden återanvända den.
  </Accordion>
  <Accordion title="OpenAI Code‑prenumeration (OAuth)">
    Webbläsarflöde; klistra in `code#state`.

    Sätter `agents.defaults.model` till `openai-codex/gpt-5.3-codex` när modellen är osatt eller `openai/*`.

  </Accordion>
  <Accordion title="OpenAI API‑nyckel">
    Använder `OPENAI_API_KEY` om den finns eller ber om en nyckel och sparar den sedan till
    `~/.openclaw/.env` så att launchd kan läsa den.

    Sätter `agents.defaults.model` till `openai/gpt-5.1-codex` när modellen är osatt, `openai/*` eller `openai-codex/*`.

  </Accordion>
  <Accordion title="xAI (Grok) API‑nyckel">
    Ber om `XAI_API_KEY` och konfigurerar xAI som modellleverantör.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Ber om `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`).
    Setup‑URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API‑nyckel (generisk)">
    Lagrar nyckeln åt dig.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Ber om `AI_GATEWAY_API_KEY`.
    Mer information: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Ber om konto‑ID, gateway‑ID och `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Mer information: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Konfiguration skrivs automatiskt.
    Mer information: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic‑kompatibel)">
    Ber om `SYNTHETIC_API_KEY`.
    Mer information: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot och Kimi Coding">
    Konfigurationer för Moonshot (Kimi K2) och Kimi Coding skrivs automatiskt.
    Mer information: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Hoppa över">
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

WhatsApp‑autentiseringsuppgifter hamnar under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessioner lagras under `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Vissa kanaler levereras som plugins. När de väljs under introduktionen ber guiden
om att installera pluginen (npm eller lokal sökväg) innan kanalkonfiguration.
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
