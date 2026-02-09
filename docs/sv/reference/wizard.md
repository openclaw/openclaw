---
summary: "Fullständig referens för CLI-introduktionsguiden: varje steg, flagga och konfigfält"
read_when:
  - Söker efter ett specifikt guide-steg eller flagga
  - Automatiserar introduktion med icke-interaktivt läge
  - Felsöker guidebeteende
title: "Referens för introduktionsguide"
sidebarTitle: "Wizard Reference"
---

# Referens för introduktionsguide

Detta är den fullständiga referensen för `openclaw onboard` CLI-guiden.
För en överblick på hög nivå, se [Onboarding Wizard](/start/wizard).

## Flödesdetaljer (lokalt läge)

<Steps>
  <Step title="Existing config detection">
    - Om `~/.openclaw/openclaw.json` finns, välj **Behåll / Ändra / Återställ**.
    - Att köra om guiden torkar **inte** om du inte uttryckligen väljer **Återställ**
      (eller passerar `--reset`).
    - Om konfigurationen är ogiltig eller innehåller äldre nycklar, stannar guiden och ber
      dig att köra `openclaw doctor` innan du fortsätter.
    - Återställ använder `trash` (aldrig `rm`) och erbjuder omfattning:
      - Config only
      - Config + autentiseringsuppgifter + sessioner
      - Fullständig återställning (tar också bort arbetsytan)  
</Step>
  <Step title="Model/Auth">
    - **Antropisk API-nyckel (rekommenderas)**: använder `ANTHROPIC_API_KEY` om den finns eller ber om en nyckel, sparar den sedan för serveranvändning.
    - **Anthropic OAuth (Claude Code CLI)**: på macOS trollkarlen kontrollerar Nyckelringsetiketten "Claude Code-autentiseringar" (välj "Alltid tillåt" så att launchd startar blockeras inte); på Linux/Windows det återanvänder `~/. laude/.credentials.json` om närvarande.
    - **Antropisk token (klistra in setup-token)**: kör `claude setup-token` på någon maskin, klistra sedan in token (du kan namnge det; tomt = standard).
    - **OpenAI-kod (Codex) prenumeration (Codex CLI)**: om `~/.codex/auth.json` finns kan guiden återanvända den.
    - **OpenAI-kod (Codex) prenumeration (OAuth)**: webbläsarflöde; klistra in `code#state`.
      - Ställer in `agents.defaults.model` till `openai-codex/gpt-5.2` när modellen är unset eller `openai/*`.
    - **OpenAI API-nyckel**: använder `OPENAI_API_KEY` om det finns eller ber om en nyckel, sparar det sedan till `~/.openclaw/.env` så launchd kan läsa den.
    - **xAI (Grok) API-nyckel**: uppmaningar för `XAI_API_KEY` och konfigurerar xAI som modellleverantör.
    - **OpenCode Zen (multi-model proxy)**: uppmaningar till `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`, hämta det på https://opencode.ai/auth).
    - **API-nyckel**: lagrar nyckeln för dig.
    - **Vercel AI Gateway (multi-model proxy)**: uppmaningar till `AI_GATEWAY_API_KEY`.
    - Mer detalj: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: uppmaningar om konto-ID, Gateway ID och `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Mer detalj: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: konfiguration är automatiskt skriven.
    - Mer detalj: [MiniMax](/providers/minimax)
    - **Syntetisk (Anthropic-kompatibel)**: uppmaningar till `SYNTHETIC_API_KEY`.
    - Mer detalj: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config är automatiskt skriven.
    - **Kimi Coding**: config är automatiskt skriven.
    - Mer detalj: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: ingen auth konfigurerad ännu.
    - Välj en standardmodell från upptäckta alternativ (eller ange leverantör/modell manuellt).
    - Guiden kör en modellkontroll och varnar om den konfigurerade modellen är okänd eller saknar autentisering.
    - OAuth autentiseringsuppgifter lever i `~/.openclaw/credentials/oauth.json`; auth profiler lever i `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API-nycklar + OAuth).
    - Mer information: [/concepts/oauth](/concepts/oauth)    
<Note>
    Tips för headless/server: slutför OAuth på en maskin med webbläsare och kopiera sedan
    `~/.openclaw/credentials/oauth.json` (eller `$OPENCLAW_STATE_DIR/credentials/oauth.json`) till
    gateway-värden.
    </Note>
  </Step>
  <Step title="Workspace">
    - Standard `~/.openclaw/workspace` (konfigurerbar).
    - Frön de arbetsytefakter som behövs för agenten bootstrap ritual.
    - Fullständig arbetsytelayout + guide för säkerhetskopiering: [Agentarbetsyta](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Port, bind, auth-läge, skräddarsydd exponering.
    - Auth rekommendation: behåll **Token** även för loopback så att lokala WS-klienter måste autentisera.
    - Inaktivera auth endast om du helt litar på varje lokal process.
    - Icke-loopback binder fortfarande kräver auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): valfri QR-inloggning.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): servicekonto JSON + webhook-publik.
    - [Mattermost](/channels/mattermost) (plugin): bot token + bas-URL.
    - [Signal](/channels/signal): valfri `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **rekommenderas för iMessage**; server URL + lösenord + webhook.
    - [iMessage](/channels/imessage): äldre `imsg` CLI-sökväg + DB-åtkomst.
    - DM säkerhet: standard är parning. Första DM skickar en kod; godkänna via `openclaw parkoppling godkänna <channel><code>` eller använd tillåtelselistor.
  </Step><code>` eller använd tillåtelselistor.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Kräver en inloggad användarsession; för huvudlös, använd en anpassad LaunchDaemon (inte levererad).
    - Linux (och Windows via WSL2): systemdanvändarenhet
      - Wizard försöker aktivera kvardröjande via `loginctl enable-linger <user>` så Gateway stannar kvar efter utloggning.
      - Kan fråga om sudo (skriver `/var/lib/systemd/linger`); den försöker utan sudo först.
    - **Körtidsval:** Node (rekommenderas; krävs för WhatsApp/Telegram). Bun är **inte rekommenderas**.
  </Step>
  <Step title="Health check">
    - Startar Gateway (om det behövs) och kör `openclaw health`.
    - Tips: `openclaw status --deep` lägger till gateway hälso-sonder till statusutdata (kräver en nåbar gateway).
  </Step>
  <Step title="Skills (recommended)">
    - Läser de tillgängliga färdigheterna och kontrollkraven.
    - Kan du välja en nodhanterare: **npm / pnpm** (bun rekommenderas inte).
    - Installerar valfria beroenden (vissa använder Homebrew på macOS).
  </Step>
  <Step title="Finish">
    - Sammanfattning + nästa steg, inklusive iOS/Android/macOS appar för extra funktioner.
  </Step>
</Steps>

<Note>
Om ingen GUI upptäcks, guiden skriver ut SSH port-forward instruktioner för Control UI istället för att öppna en webbläsare.
Om kontrollgränssnittets tillgångar saknas, försöker guiden bygga dem; fallback är `pnpm ui:build` (auto-installs UI deps).
</Note>

## Icke-interaktivt läge

Använd `--non-interactive` för att automatisera eller skripta introduktion:

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

Lägg till `--json` för en maskinläsbar sammanfattning.

<Note>
`--json` betyder **inte** icke-interaktivt läge. Använd `--non-interactive` (och `--workspace`) för skript.
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

### Lägg till agent (icke-interaktivt)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway-guide RPC

Gateway exponerar trollkarlsflödet över RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Klienter (macOS app, Control UI) kan rendera steg utan att implementera ombordstigningslogik.

## Signal-konfigurering (signal-cli)

Guiden kan installera `signal-cli` från GitHub-releaser:

- Hämtar lämplig release-tillgång.
- Lagrar den under `~/.openclaw/tools/signal-cli/<version>/`.
- Skriver `channels.signal.cliPath` till din konfig.

Noteringar:

- JVM-byggen kräver **Java 21**.
- Native-byggen används när de finns tillgängliga.
- Windows använder WSL2; installation av signal-cli följer Linux-flödet inuti WSL.

## Vad guiden skriver

Typiska fält i `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (om Minimax valts)
- `gateway.*` (läge, bindning, autentisering, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Kanal-tillåtelselistor (Slack/Discord/Matrix/Microsoft Teams) när du väljer det under frågorna (namn löses till ID:n när möjligt).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` skriver `agents.list[]` och valfri `bindings`.

WhatsApp-uppgifter går under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessioner lagras under `~/.openclaw/agents/<agentId>/sessions/`.

Vissa kanaler levereras som plugins. När du väljer en under registrering, kommer guiden
uppmanas att installera den (npm eller en lokal sökväg) innan den kan konfigureras.

## Relaterad dokumentation

- Guideöversikt: [Introduktionsguide](/start/wizard)
- Introduktion i macOS-appen: [Introduktion](/start/onboarding)
- Konfigreferens: [Gateway-konfiguration](/gateway/configuration)
- Leverantörer: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills-konfig](/tools/skills-config)
