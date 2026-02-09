---
summary: "Volledige referentie voor de CLI-onboardingwizard: elke stap, vlag en configveld"
read_when:
  - Een specifieke wizardstap of -vlag opzoeken
  - Onboarding automatiseren met niet-interactieve modus
  - Wizardgedrag debuggen
title: "Referentie onboardingwizard"
sidebarTitle: "Wizard Reference"
---

# Referentie onboardingwizard

Dit is de volledige referentie voor de `openclaw onboard` CLI-wizard.
Voor een overzicht op hoog niveau, zie [Onboarding Wizard](/start/wizard).

## Stroomdetails (lokale modus)

<Steps>
  <Step title="Existing config detection">
    - Als `~/.openclaw/openclaw.json` bestaat, kies **Behouden / Wijzigen / Resetten**.
    - Het opnieuw uitvoeren van de wizard wist **niets**, tenzij je expliciet **Resetten** kiest
      (of `--reset` doorgeeft).
    - Als de config ongeldig is of legacy-sleutels bevat, stopt de wizard en vraagt
      je om `openclaw doctor` uit te voeren voordat je verdergaat.
    - Resetten gebruikt `trash` (nooit `rm`) en biedt scopes:
      - Alleen config
      - Config + inloggegevens + sessies
      - Volledige reset (verwijdert ook de werkruimte)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API-sleutel (aanbevolen)**: gebruikt `ANTHROPIC_API_KEY` indien aanwezig of vraagt om een sleutel en slaat deze vervolgens op voor daemon-gebruik.
    - **Anthropic OAuth (Claude Code CLI)**: op macOS controleert de wizard het Sleutelhangerelement "Claude Code-credentials" (kies "Altijd toestaan" zodat launchd-starts niet blokkeren); op Linux/Windows hergebruikt hij `~/.claude/.credentials.json` indien aanwezig.
    - **Anthropic-token (setup-token plakken)**: voer `claude setup-token` uit op een willekeurige machine en plak vervolgens de token (je kunt deze een naam geven; leeg = standaard).
    - **OpenAI Code (Codex) abonnement (Codex CLI)**: als `~/.codex/auth.json` bestaat, kan de wizard deze hergebruiken.
    - **OpenAI Code (Codex) abonnement (OAuth)**: browserflow; plak de `code#state`.
      - Stelt `agents.defaults.model` in op `openai-codex/gpt-5.2` wanneer het model niet is ingesteld of `openai/*` is.
    - **OpenAI API-sleutel**: gebruikt `OPENAI_API_KEY` indien aanwezig of vraagt om een sleutel en slaat deze vervolgens op in `~/.openclaw/.env` zodat launchd deze kan lezen.
    - **xAI (Grok) API-sleutel**: vraagt om `XAI_API_KEY` en configureert xAI als modelprovider.
    - **OpenCode Zen (multi-model proxy)**: vraagt om `OPENCODE_API_KEY` (of `OPENCODE_ZEN_API_KEY`, haal deze op via https://opencode.ai/auth).
    - **API-sleutel**: slaat de sleutel voor je op.
    - **Vercel AI Gateway (multi-model proxy)**: vraagt om `AI_GATEWAY_API_KEY`.
    - Meer details: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: vraagt om Account ID, Gateway ID en `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Meer details: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config wordt automatisch weggeschreven.
    - Meer details: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatibel)**: vraagt om `SYNTHETIC_API_KEY`.
    - Meer details: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config wordt automatisch weggeschreven.
    - **Kimi Coding**: config wordt automatisch weggeschreven.
    - Meer details: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Overslaan**: er is nog geen auth geconfigureerd.
    - Kies een standaardmodel uit de gedetecteerde opties (of voer provider/model handmatig in).
    - De wizard voert een modelcheck uit en waarschuwt als het geconfigureerde model onbekend is of auth ontbreekt.
    - OAuth-inloggegevens staan in `~/.openclaw/credentials/oauth.json`; auth-profielen staan in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API-sleutels + OAuth).
    - Meer details: [/concepts/oauth](/concepts/oauth)    
<Note>
    Tip voor headless/server: voltooi OAuth op een machine met een browser en kopieer vervolgens
    `~/.openclaw/credentials/oauth.json` (of `$OPENCLAW_STATE_DIR/credentials/oauth.json`) naar de
    Gateway-host.
    </Note>
  </Step>
  <Step title="Workspace">
    - Standaard `~/.openclaw/workspace` (configureerbaar).
    - Initialiseert de werkruimtebestanden die nodig zijn voor het bootstrap-ritueel van de agent.
    - Volledige werkruimte-indeling + back-upgids: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Poort, bind, auth-modus, Tailscale-blootstelling.
    - Auth-aanbeveling: houd **Token** aan, zelfs voor loopback, zodat lokale WS-clients zich moeten authenticeren.
    - Schakel auth alleen uit als je elke lokale proces volledig vertrouwt.
    - Niet-loopback binds vereisen nog steeds auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optionele QR-login.
    - [Telegram](/channels/telegram): bot-token.
    - [Discord](/channels/discord): bot-token.
    - [Google Chat](/channels/googlechat): serviceaccount-JSON + webhook-audience.
    - [Mattermost](/channels/mattermost) (plugin): bot-token + basis-URL.
    - [Signal](/channels/signal): optionele `signal-cli`-installatie + accountconfiguratie.
    - [BlueBubbles](/channels/bluebubbles): **aanbevolen voor iMessage**; server-URL + wachtwoord + webhook.
    - [iMessage](/channels/imessage): legacy `imsg` CLI-pad + DB-toegang.
    - DM-beveiliging: standaard is koppelen. De eerste DM stuurt een code; keur goed via `openclaw pairing approve <channel><code>` of gebruik toegestane lijsten.
  </Step><code>` of gebruik toegestane lijsten.
  </Step>
  <Step title="Daemon-installatie">
    - macOS: LaunchAgent
      - Vereist een aangemelde gebruikerssessie; voor headless gebruik een aangepaste LaunchDaemon (niet meegeleverd).
    - Linux (en Windows via WSL2): systemd user unit
      - De wizard probeert lingering in te schakelen via `loginctl enable-linger <user>` zodat de Gateway actief blijft na uitloggen.
      - Kan om sudo vragen (schrijft `/var/lib/systemd/linger`); probeert eerst zonder sudo.
    - **Runtimekeuze:** Node (aanbevolen; vereist voor WhatsApp/Telegram). Bun wordt **niet aanbevolen**.
  </Step>
  <Step title="Gezondheidscheck">
    - Start de Gateway (indien nodig) en voert `openclaw health` uit.
    - Tip: `openclaw status --deep` voegt gateway-gezondheidsprobes toe aan de statusuitvoer (vereist een bereikbare Gateway).
  </Step>
  <Step title="Skills (aanbevolen)">
    - Leest de beschikbare Skills en controleert vereisten.
    - Laat je een node manager kiezen: **npm / pnpm** (bun niet aanbevolen).
    - Installeert optionele afhankelijkheden (sommige gebruiken Homebrew op macOS).
  </Step>
  <Step title="Afronden">
    - Samenvatting + volgende stappen, inclusief iOS/Android/macOS-apps voor extra functies.
  </Step>
</Steps>

<Note>
Als er geen GUI wordt gedetecteerd, print de wizard SSH-port-forward-instructies voor de Control UI in plaats van een browser te openen.
Als de Control UI-assets ontbreken, probeert de wizard deze te bouwen; de fallback is `pnpm ui:build` (installeert UI-afhankelijkheden automatisch).
</Note>

## Niet-interactieve modus

Gebruik `--non-interactive` om onboarding te automatiseren of te scripten:

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

Voeg `--json` toe voor een machineleesbare samenvatting.

<Note>
`--json` impliceert **niet** de niet-interactieve modus. Gebruik `--non-interactive` (en `--workspace`) voor scripts.
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

### Agent toevoegen (niet-interactief)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

De Gateway stelt de wizardstroom beschikbaar via RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clients (macOS-app, Control UI) kunnen stappen renderen zonder de onboardinglogica opnieuw te implementeren.

## Signal-installatie (signal-cli)

De wizard kan `signal-cli` installeren vanaf GitHub-releases:

- Downloadt het juiste release-asset.
- Slaat het op onder `~/.openclaw/tools/signal-cli/<version>/`.
- Schrijft `channels.signal.cliPath` naar je config.

Notities:

- JVM-builds vereisen **Java 21**.
- Native builds worden gebruikt wanneer beschikbaar.
- Windows gebruikt WSL2; de installatie van signal-cli volgt de Linux-stroom binnen WSL.

## Wat de wizard wegschrijft

Typische velden in `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (als Minimax is gekozen)
- `gateway.*` (modus, bind, auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Kanaal-toegestane lijsten (Slack/Discord/Matrix/Microsoft Teams) wanneer je hier tijdens de prompts voor kiest (namen worden waar mogelijk naar ID's omgezet).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` schrijft `agents.list[]` en optionele `bindings`.

WhatsApp-inloggegevens staan onder `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessies worden opgeslagen onder `~/.openclaw/agents/<agentId>/sessions/`.

Sommige kanalen worden als plugins geleverd. Wanneer je er tijdens onboarding één kiest, zal de wizard
vragen om deze te installeren (npm of een lokaal pad) voordat deze kan worden geconfigureerd.

## Gerelateerde documentatie

- Wizardoverzicht: [Onboarding Wizard](/start/wizard)
- macOS-app onboarding: [Onboarding](/start/onboarding)
- Configreferentie: [Gateway configuration](/gateway/configuration)
- Providers: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
