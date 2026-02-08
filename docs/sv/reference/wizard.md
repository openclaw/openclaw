---
summary: "Fullständig referens för CLI-introduktionsguiden: varje steg, flagga och konfigfält"
read_when:
  - Söker efter ett specifikt guide-steg eller flagga
  - Automatiserar introduktion med icke-interaktivt läge
  - Felsöker guidebeteende
title: "Referens för introduktionsguide"
sidebarTitle: "Wizard Reference"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:43Z
---

# Referens för introduktionsguide

Detta är den fullständiga referensen för `openclaw onboard` CLI-guiden.
För en översikt på hög nivå, se [Introduktionsguide](/start/wizard).

## Flödesdetaljer (lokalt läge)

<Steps>
  <Step title="Detektering av befintlig konfig">
    - Om `~/.openclaw/openclaw.json` finns, välj **Behåll / Ändra / Återställ**.
    - Att köra guiden igen raderar **inget** om du inte uttryckligen väljer **Återställ**
      (eller skickar `--reset`).
    - Om konfigen är ogiltig eller innehåller äldre nycklar stannar guiden och ber
      dig att köra `openclaw doctor` innan du fortsätter.
    - Återställning använder `trash` (aldrig `rm`) och erbjuder omfattningar:
      - Endast konfig
      - Konfig + autentiseringsuppgifter + sessioner
      - Full återställning (tar även bort arbetsytan)
  </Step>
  <Step title="Modell/Autentisering">
    - **Anthropic API-nyckel (rekommenderas)**: använder `ANTHROPIC_API_KEY` om den finns eller ber om en nyckel och sparar den sedan för daemon-användning.
    - **Anthropic OAuth (Claude Code CLI)**: på macOS kontrollerar guiden Keychain-posten ”Claude Code-credentials” (välj ”Always Allow” så att launchd-starter inte blockeras); på Linux/Windows återanvänds `~/.claude/.credentials.json` om den finns.
    - **Anthropic-token (klistra in setup-token)**: kör `claude setup-token` på valfri maskin och klistra sedan in token (du kan namnge den; tomt = standard).
    - **OpenAI Code (Codex)-prenumeration (Codex CLI)**: om `~/.codex/auth.json` finns kan guiden återanvända den.
    - **OpenAI Code (Codex)-prenumeration (OAuth)**: webbläsarflöde; klistra in `code#state`.
      - Sätter `agents.defaults.model` till `openai-codex/gpt-5.2` när modell inte är satt eller är `openai/*`.
    - **OpenAI API-nyckel**: använder `OPENAI_API_KEY` om den finns eller ber om en nyckel och sparar den sedan till `~/.openclaw/.env` så att launchd kan läsa den.
    - **xAI (Grok) API-nyckel**: ber om `XAI_API_KEY` och konfigurerar xAI som modellleverantör.
    - **OpenCode Zen (proxy för flera modeller)**: ber om `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`, hämta den på https://opencode.ai/auth).
    - **API-nyckel**: lagrar nyckeln åt dig.
    - **Vercel AI Gateway (proxy för flera modeller)**: ber om `AI_GATEWAY_API_KEY`.
    - Mer information: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: ber om Account ID, Gateway ID och `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Mer information: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: konfig skrivs automatiskt.
    - Mer information: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-kompatibel)**: ber om `SYNTHETIC_API_KEY`.
    - Mer information: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: konfig skrivs automatiskt.
    - **Kimi Coding**: konfig skrivs automatiskt.
    - Mer information: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Hoppa över**: ingen autentisering konfigureras ännu.
    - Välj en standardmodell från upptäckta alternativ (eller ange leverantör/modell manuellt).
    - Guiden kör en modellkontroll och varnar om den konfigurerade modellen är okänd eller saknar autentisering.
    - OAuth-uppgifter finns i `~/.openclaw/credentials/oauth.json`; autentiseringsprofiler finns i `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API-nycklar + OAuth).
    - Mer information: [/concepts/oauth](/concepts/oauth)
    <Note>
    Tips för headless/server: slutför OAuth på en maskin med webbläsare och kopiera sedan
    `~/.openclaw/credentials/oauth.json` (eller `$OPENCLAW_STATE_DIR/credentials/oauth.json`) till
    gateway-värden.
    </Note>
  </Step>
  <Step title="Arbetsyta">
    - Standard `~/.openclaw/workspace` (konfigurerbar).
    - Förbereder arbetsytans filer som behövs för agentens bootstrap-ritual.
    - Full arbetsyte-layout + backup-guide: [Agentarbetsyta](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - Port, bindning, autentiseringsläge, Tailscale-exponering.
    - Rekommendation för autentisering: behåll **Token** även för loopback så att lokala WS-klienter måste autentisera.
    - Inaktivera autentisering endast om du fullt ut litar på varje lokal process.
    - Bindningar som inte är loopback kräver fortfarande autentisering.
  </Step>
  <Step title="Kanaler">
    - [WhatsApp](/channels/whatsapp): valfri QR-inloggning.
    - [Telegram](/channels/telegram): bot-token.
    - [Discord](/channels/discord): bot-token.
    - [Google Chat](/channels/googlechat): tjänstekonto-JSON + webhook-publik.
    - [Mattermost](/channels/mattermost) (plugin): bot-token + bas-URL.
    - [Signal](/channels/signal): valfri `signal-cli`-installation + kontokonfig.
    - [BlueBubbles](/channels/bluebubbles): **rekommenderas för iMessage**; server-URL + lösenord + webhook.
    - [iMessage](/channels/imessage): äldre `imsg` CLI-sökväg + DB-åtkomst.
    - DM-säkerhet: standard är parkoppling. Första DM skickar en kod; godkänn via `openclaw pairing approve <channel> <code>` eller använd tillåtelselistor.
  </Step>
  <Step title="Installation av daemon">
    - macOS: LaunchAgent
      - Kräver en inloggad användarsession; för headless, använd en anpassad LaunchDaemon (medföljer inte).
    - Linux (och Windows via WSL2): systemd-användarenhet
      - Guiden försöker aktivera lingering via `loginctl enable-linger <user>` så att Gateway fortsätter att köras efter utloggning.
      - Kan be om sudo (skriver `/var/lib/systemd/linger`); den försöker utan sudo först.
    - **Val av runtime:** Node (rekommenderas; krävs för WhatsApp/Telegram). Bun **rekommenderas inte**.
  </Step>
  <Step title="Hälsokontroll">
    - Startar Gateway (vid behov) och kör `openclaw health`.
    - Tips: `openclaw status --deep` lägger till Gateway-hälsoprober i statusutdata (kräver en nåbar Gateway).
  </Step>
  <Step title="Skills (rekommenderas)">
    - Läser tillgängliga Skills och kontrollerar krav.
    - Låter dig välja en nodhanterare: **npm / pnpm** (bun rekommenderas inte).
    - Installerar valfria beroenden (vissa använder Homebrew på macOS).
  </Step>
  <Step title="Slutför">
    - Sammanfattning + nästa steg, inklusive iOS/Android/macOS-appar för extra funktioner.
  </Step>
</Steps>

<Note>
Om inget GUI detekteras skriver guiden ut instruktioner för SSH-portvidarebefordran för Control UI i stället för att öppna en webbläsare.
Om Control UI-tillgångarna saknas försöker guiden bygga dem; reservlösning är `pnpm ui:build` (installerar UI-beroenden automatiskt).
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
`--json` innebär **inte** icke-interaktivt läge. Använd `--non-interactive` (och `--workspace`) för skript.
</Note>

<AccordionGroup>
  <Accordion title="Gemini-exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI-exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway-exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway-exempel">
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
  <Accordion title="Moonshot-exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic-exempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen-exempel">
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

Gateway exponerar guideflödet över RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Klienter (macOS-app, Control UI) kan rendera steg utan att återimplementera introduktionslogik.

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

WhatsApp-autentiseringsuppgifter hamnar under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessioner lagras under `~/.openclaw/agents/<agentId>/sessions/`.

Vissa kanaler levereras som plugins. När du väljer en under introduktionen kommer guiden
att fråga om att installera den (npm eller lokal sökväg) innan den kan konfigureras.

## Relaterad dokumentation

- Guideöversikt: [Introduktionsguide](/start/wizard)
- Introduktion i macOS-appen: [Introduktion](/start/onboarding)
- Konfigreferens: [Gateway-konfiguration](/gateway/configuration)
- Leverantörer: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills-konfig](/tools/skills-config)
