---
summary: "Volledige referentie voor de CLI-onboardingflow, auth-/modelconfiguratie, uitvoer en interne werking"
read_when:
  - Je hebt gedetailleerd gedrag nodig voor openclaw onboard
  - Je debugt onboardingresultaten of integreert onboardingclients
title: "CLI Onboarding-referentie"
sidebarTitle: "CLI-referentie"
---

# CLI Onboarding-referentie

Deze pagina is de volledige referentie voor `openclaw onboard`.
Voor de korte gids, zie [Onboarding Wizard (CLI)](/start/wizard).

## Wat de wizard doet

Lokale modus (standaard) leidt je door:

- Model- en auth-instelling (OpenAI Code-abonnement OAuth, Anthropic API-sleutel of setup-token, plus MiniMax-, GLM-, Moonshot- en AI Gateway-opties)
- Werkruimtelocatie en bootstrapbestanden
- Gateway-instellingen (poort, bind, auth, Tailscale)
- Kanalen en providers (Telegram, WhatsApp, Discord, Google Chat, Mattermost-plugin, Signal)
- Daemon-installatie (LaunchAgent of systemd user unit)
- Gezondheidscontrole
- Skills-instelling

Remote modus configureert deze machine om verbinding te maken met een Gateway elders.
Er wordt niets geïnstalleerd of gewijzigd op de remote host.

## Details lokale flow

<Steps>
  <Step title="Existing config detection">
    - Als `~/.openclaw/openclaw.json` bestaat, kies je Behouden, Wijzigen of Resetten.
    - Het opnieuw uitvoeren van de wizard wist niets, tenzij je expliciet Reset kiest (of `--reset` meegeeft).
    - Als de config ongeldig is of legacy-sleutels bevat, stopt de wizard en vraagt je om `openclaw doctor` uit te voeren voordat je verdergaat.
    - Reset gebruikt `trash` en biedt scopes:
      - Alleen config
      - Config + credentials + sessies
      - Volledige reset (verwijdert ook de werkruimte)  
</Step>
  <Step title="Model and auth">
    - De volledige optiematrix staat in [Auth- en modelopties](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Standaard `~/.openclaw/workspace` (configureerbaar).
    - Zaait werkruimtebestanden die nodig zijn voor het bootstrapritueel bij de eerste run.
    - Werkruimte-indeling: [Agent-werkruimte](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Vraagt om poort, bind, auth-modus en Tailscale-exposure.
    - Aanbevolen: houd token-auth ingeschakeld, zelfs voor loopback, zodat lokale WS-clients zich moeten authenticeren.
    - Schakel auth alleen uit als je elk lokaal proces volledig vertrouwt.
    - Niet-loopback binds vereisen nog steeds auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optionele QR-login
    - [Telegram](/channels/telegram): bot-token
    - [Discord](/channels/discord): bot-token
    - [Google Chat](/channels/googlechat): serviceaccount-JSON + webhook-audience
    - [Mattermost](/channels/mattermost)-plugin: bot-token + basis-URL
    - [Signal](/channels/signal): optionele installatie van `signal-cli` + accountconfiguratie
    - [BlueBubbles](/channels/bluebubbles): aanbevolen voor iMessage; server-URL + wachtwoord + webhook
    - [iMessage](/channels/imessage): legacy `imsg` CLI-pad + DB-toegang
    - DM-beveiliging: standaard is koppelen. De eerste DM stuurt een code; goedkeuren via
      `openclaw pairing approve <channel><code>` of gebruik toegestane lijsten.
  </Step><code>` of gebruik toegestane lijsten.
  </Step>
  <Step title="Daemon-installatie">
    - macOS: LaunchAgent
      - Vereist een ingelogde gebruikerssessie; voor headless gebruik een aangepaste LaunchDaemon (niet meegeleverd).
    - Linux en Windows via WSL2: systemd user unit
      - De wizard probeert `loginctl enable-linger <user>` zodat de Gateway actief blijft na uitloggen.
      - Kan om sudo vragen (schrijft `/var/lib/systemd/linger`); hij probeert eerst zonder sudo.
    - Runtimekeuze: Node (aanbevolen; vereist voor WhatsApp en Telegram). Bun wordt niet aanbevolen.
  </Step>
  <Step title="Gezondheidscontrole">
    - Start de Gateway (indien nodig) en voert `openclaw health` uit.
    - `openclaw status --deep` voegt Gateway-gezondheidsprobes toe aan de statusuitvoer.
  </Step>
  <Step title="Skills">
    - Leest beschikbare Skills en controleert vereisten.
    - Laat je een node manager kiezen: npm of pnpm (bun niet aanbevolen).
    - Installeert optionele afhankelijkheden (sommige gebruiken Homebrew op macOS).
  </Step>
  <Step title="Afronden">
    - Samenvatting en volgende stappen, inclusief iOS-, Android- en macOS-appopties.
  </Step>
</Steps>

<Note>
Als er geen GUI wordt gedetecteerd, print de wizard SSH-port-forward-instructies voor de Control UI in plaats van een browser te openen.
Als Control UI-assets ontbreken, probeert de wizard deze te bouwen; fallback is `pnpm ui:build` (installeert UI-deps automatisch).
</Note>

## Details remote modus

Remote modus configureert deze machine om verbinding te maken met een Gateway elders.

<Info>
Remote modus installeert of wijzigt niets op de remote host.
</Info>

Wat je instelt:

- Remote Gateway-URL (`ws://...`)
- Token als auth voor de remote Gateway vereist is (aanbevolen)

<Note>
- Als de Gateway alleen loopback is, gebruik SSH-tunneling of een tailnet.
- Discovery-hints:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Auth- en modelopties

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Gebruikt `ANTHROPIC_API_KEY` indien aanwezig of vraagt om een sleutel, en slaat deze vervolgens op voor daemon-gebruik.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: controleert Keychain-item "Claude Code-credentials"
    - Linux en Windows: hergebruikt `~/.claude/.credentials.json` indien aanwezig

    ```
    Kies op macOS "Always Allow" zodat launchd-starts niet blokkeren.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Voer `claude setup-token` uit op een willekeurige machine en plak vervolgens het token.
    Je kunt het een naam geven; leeg gebruikt de standaard.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Als `~/.codex/auth.json` bestaat, kan de wizard dit hergebruiken.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Browserflow; plak `code#state`.

    ```
    Stelt `agents.defaults.model` in op `openai-codex/gpt-5.3-codex` wanneer het model niet is ingesteld of `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Gebruikt `OPENAI_API_KEY` indien aanwezig of vraagt om een sleutel, en slaat deze vervolgens op in
    `~/.openclaw/.env` zodat launchd deze kan lezen.

    ```
    Stelt `agents.defaults.model` in op `openai/gpt-5.1-codex` wanneer het model niet is ingesteld, `openai/*` of `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Vraagt om `XAI_API_KEY` en configureert xAI als modelprovider.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Vraagt om `OPENCODE_API_KEY` (of `OPENCODE_ZEN_API_KEY`).
    Setup-URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Slaat de sleutel voor je op.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Vraagt om `AI_GATEWAY_API_KEY`.
    Meer details: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Vraagt om account-ID, Gateway-ID en `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Meer details: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Config wordt automatisch weggeschreven.
    Meer details: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Vraagt om `SYNTHETIC_API_KEY`.
    Meer details: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) en Kimi Coding-configs worden automatisch weggeschreven.
    Meer details: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    Laat auth ongeconfigureerd.
  </Accordion>
</AccordionGroup>

Modelgedrag:

- Kies het standaardmodel uit gedetecteerde opties, of voer provider en model handmatig in.
- De wizard voert een modelcheck uit en waarschuwt als het geconfigureerde model onbekend is of auth ontbreekt.

Credential- en profielpaden:

- OAuth-credentials: `~/.openclaw/credentials/oauth.json`
- Auth-profielen (API-sleutels + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Tip voor headless en servers: voltooi OAuth op een machine met een browser en kopieer daarna
`~/.openclaw/credentials/oauth.json` (of `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
naar de Gateway-host.
</Note>

## Uitvoer en interne werking

Typische velden in `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (als Minimax is gekozen)
- `gateway.*` (modus, bind, auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Kanaal-toegestane lijsten (Slack, Discord, Matrix, Microsoft Teams) wanneer je hier tijdens prompts voor kiest (namen worden waar mogelijk naar ID's vertaald)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` schrijft `agents.list[]` en optioneel `bindings`.

WhatsApp-credentials gaan onder `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessies worden opgeslagen onder `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Sommige kanalen worden geleverd als plugins. Wanneer ze tijdens onboarding worden geselecteerd, vraagt de wizard
om de plugin te installeren (npm of lokaal pad) vóór kanaalconfiguratie.
</Note>

Gateway wizard RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Clients (macOS-app en Control UI) kunnen stappen renderen zonder de onboardinglogica opnieuw te implementeren.

Signal-installatiegedrag:

- Downloadt de juiste release-asset
- Slaat deze op onder `~/.openclaw/tools/signal-cli/<version>/`
- Schrijft `channels.signal.cliPath` in de config
- JVM-builds vereisen Java 21
- Native builds worden gebruikt wanneer beschikbaar
- Windows gebruikt WSL2 en volgt de Linux signal-cli-flow binnen WSL

## Gerelateerde documentatie

- Onboarding-hub: [Onboarding Wizard (CLI)](/start/wizard)
- Automatisering en scripts: [CLI Automation](/start/wizard-cli-automation)
- Opdrachtreferentie: [`openclaw onboard`](/cli/onboard)
