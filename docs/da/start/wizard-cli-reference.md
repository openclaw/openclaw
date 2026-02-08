---
summary: "Komplet reference for CLI-introduktionsflow, opsætning af auth/model, output og interne detaljer"
read_when:
  - Du har brug for detaljeret adfærd for openclaw onboard
  - Du fejlsøger introduktionsresultater eller integrerer introduktionsklienter
title: "CLI Onboarding Reference"
sidebarTitle: "CLI reference"
x-i18n:
  source_path: start/wizard-cli-reference.md
  source_hash: 20bb32d6fd952345
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:56Z
---

# CLI Onboarding Reference

Denne side er den fulde reference for `openclaw onboard`.
For den korte guide, se [Onboarding Wizard (CLI)](/start/wizard).

## Hvad opsætningsguiden gør

Lokal tilstand (standard) fører dig igennem:

- Opsætning af model og auth (OpenAI Code-abonnement OAuth, Anthropic API-nøgle eller setup-token samt MiniMax-, GLM-, Moonshot- og AI Gateway-muligheder)
- Arbejdsområdets placering og bootstrap-filer
- Gateway-indstillinger (port, bind, auth, tailscale)
- Kanaler og udbydere (Telegram, WhatsApp, Discord, Google Chat, Mattermost-plugin, Signal)
- Installation af daemon (LaunchAgent eller systemd user unit)
- Sundhedstjek
- Opsætning af Skills

Fjern-tilstand konfigurerer denne maskine til at forbinde til en gateway et andet sted.
Den installerer eller ændrer ikke noget på den eksterne vært.

## Detaljer for lokalt flow

<Steps>
  <Step title="Registrering af eksisterende konfiguration">
    - Hvis `~/.openclaw/openclaw.json` findes, kan du vælge Behold, Redigér eller Nulstil.
    - Genkørsel af opsætningsguiden sletter intet, medmindre du eksplicit vælger Nulstil (eller angiver `--reset`).
    - Hvis konfigurationen er ugyldig eller indeholder ældre nøgler, stopper guiden og beder dig køre `openclaw doctor` før du fortsætter.
    - Nulstilling bruger `trash` og tilbyder omfang:
      - Kun konfiguration
      - Konfiguration + legitimationsoplysninger + sessioner
      - Fuld nulstilling (fjerner også arbejdsområdet)
  </Step>
  <Step title="Model og auth">
    - Den fulde valgmatrix findes i [Auth and model options](#auth-and-model-options).
  </Step>
  <Step title="Arbejdsområde">
    - Standard `~/.openclaw/workspace` (kan konfigureres).
    - Seeder arbejdsområdefiler, der kræves til bootstrap-ritualet ved første kørsel.
    - Arbejdsområdets layout: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Spørger efter port, bind, auth-tilstand og tailscale-eksponering.
    - Anbefalet: behold token-auth aktiveret selv for loopback, så lokale WS-klienter skal autentificere.
    - Deaktivér kun auth, hvis du fuldt ud har tillid til alle lokale processer.
    - Ikke-loopback binds kræver stadig auth.
  </Step>
  <Step title="Kanaler">
    - [WhatsApp](/channels/whatsapp): valgfri QR-login
    - [Telegram](/channels/telegram): bot-token
    - [Discord](/channels/discord): bot-token
    - [Google Chat](/channels/googlechat): servicekonto-JSON + webhook-audience
    - [Mattermost](/channels/mattermost) plugin: bot-token + base-URL
    - [Signal](/channels/signal): valgfri `signal-cli`-installation + kontokonfiguration
    - [BlueBubbles](/channels/bluebubbles): anbefalet til iMessage; server-URL + adgangskode + webhook
    - [iMessage](/channels/imessage): ældre `imsg` CLI-sti + DB-adgang
    - DM-sikkerhed: standard er parring. Første DM sender en kode; godkend via
      `openclaw pairing approve <channel> <code>` eller brug tilladelseslister.
  </Step>
  <Step title="Installation af daemon">
    - macOS: LaunchAgent
      - Kræver indlogget brugersession; for headless, brug en brugerdefineret LaunchDaemon (medfølger ikke).
    - Linux og Windows via WSL2: systemd user unit
      - Guiden forsøger `loginctl enable-linger <user>`, så gatewayen forbliver kørende efter logout.
      - Kan bede om sudo (skriver `/var/lib/systemd/linger`); den prøver uden sudo først.
    - Valg af runtime: Node (anbefalet; påkrævet for WhatsApp og Telegram). Bun anbefales ikke.
  </Step>
  <Step title="Sundhedstjek">
    - Starter gateway (om nødvendigt) og kører `openclaw health`.
    - `openclaw status --deep` tilføjer gateway-sundhedstjek til statusoutput.
  </Step>
  <Step title="Skills">
    - Læser tilgængelige skills og tjekker krav.
    - Lader dig vælge node manager: npm eller pnpm (bun anbefales ikke).
    - Installerer valgfrie afhængigheder (nogle bruger Homebrew på macOS).
  </Step>
  <Step title="Afslut">
    - Opsummering og næste trin, inklusive iOS-, Android- og macOS-appmuligheder.
  </Step>
</Steps>

<Note>
Hvis der ikke registreres nogen GUI, udskriver guiden SSH port-forward-instruktioner til Control UI i stedet for at åbne en browser.
Hvis Control UI-aktiver mangler, forsøger guiden at bygge dem; fallback er `pnpm ui:build` (auto-installerer UI-afhængigheder).
</Note>

## Detaljer for fjern-tilstand

Fjern-tilstand konfigurerer denne maskine til at forbinde til en gateway et andet sted.

<Info>
Fjern-tilstand installerer eller ændrer ikke noget på den eksterne vært.
</Info>

Det, du indstiller:

- Fjern-gateway-URL (`ws://...`)
- Token, hvis fjern-gateway-auth er påkrævet (anbefalet)

<Note>
- Hvis gatewayen er kun-loopback, brug SSH-tunneling eller et tailnet.
- Discovery-hints:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Auth- og modelmuligheder

<AccordionGroup>
  <Accordion title="Anthropic API-nøgle (anbefalet)">
    Bruger `ANTHROPIC_API_KEY` hvis den findes eller beder om en nøgle og gemmer den derefter til daemon-brug.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: tjekker Keychain-elementet "Claude Code-credentials"
    - Linux og Windows: genbruger `~/.claude/.credentials.json` hvis den findes

    På macOS skal du vælge "Always Allow", så launchd-start ikke blokeres.

  </Accordion>
  <Accordion title="Anthropic token (indsæt setup-token)">
    Kør `claude setup-token` på en hvilken som helst maskine, og indsæt derefter tokenet.
    Du kan navngive det; tomt bruger standard.
  </Accordion>
  <Accordion title="OpenAI Code-abonnement (genbrug af Codex CLI)">
    Hvis `~/.codex/auth.json` findes, kan guiden genbruge det.
  </Accordion>
  <Accordion title="OpenAI Code-abonnement (OAuth)">
    Browser-flow; indsæt `code#state`.

    Sætter `agents.defaults.model` til `openai-codex/gpt-5.3-codex`, når modellen ikke er sat eller er `openai/*`.

  </Accordion>
  <Accordion title="OpenAI API-nøgle">
    Bruger `OPENAI_API_KEY` hvis den findes eller beder om en nøgle og gemmer den derefter i
    `~/.openclaw/.env`, så launchd kan læse den.

    Sætter `agents.defaults.model` til `openai/gpt-5.1-codex`, når modellen ikke er sat, er `openai/*` eller `openai-codex/*`.

  </Accordion>
  <Accordion title="xAI (Grok) API-nøgle">
    Beder om `XAI_API_KEY` og konfigurerer xAI som modeludbyder.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Beder om `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`).
    Opsætnings-URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API-nøgle (generisk)">
    Gemmer nøglen for dig.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Beder om `AI_GATEWAY_API_KEY`.
    Flere detaljer: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Beder om konto-id, gateway-id og `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Flere detaljer: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Konfigurationen skrives automatisk.
    Flere detaljer: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-kompatibel)">
    Beder om `SYNTHETIC_API_KEY`.
    Flere detaljer: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot og Kimi Coding">
    Moonshot (Kimi K2) og Kimi Coding-konfigurationer skrives automatisk.
    Flere detaljer: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Spring over">
    Efterlader auth uopsat.
  </Accordion>
</AccordionGroup>

Modeladfærd:

- Vælg standardmodel ud fra registrerede muligheder, eller indtast udbyder og model manuelt.
- Guiden kører et modeltjek og advarer, hvis den konfigurerede model er ukendt eller mangler auth.

Stier til legitimationsoplysninger og profiler:

- OAuth-legitimationsoplysninger: `~/.openclaw/credentials/oauth.json`
- Auth-profiler (API-nøgler + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Tip til headless og servere: fuldfør OAuth på en maskine med browser, og kopiér derefter
`~/.openclaw/credentials/oauth.json` (eller `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
til gateway-værten.
</Note>

## Output og interne detaljer

Typiske felter i `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (hvis Minimax er valgt)
- `gateway.*` (tilstand, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Kanal-tilladelseslister (Slack, Discord, Matrix, Microsoft Teams), når du vælger dem under prompts (navne opløses til id’er, når det er muligt)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` skriver `agents.list[]` og valgfri `bindings`.

WhatsApp-legitimationsoplysninger placeres under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessioner gemmes under `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Nogle kanaler leveres som plugins. Når de vælges under introduktionen, beder guiden
om at installere plugin’et (npm eller lokal sti) før kanalkonfiguration.
</Note>

Gateway wizard RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Klienter (macOS-app og Control UI) kan gengive trin uden at genimplementere introduktionslogik.

Signal-opsætningsadfærd:

- Downloader den passende release-asset
- Gemmer den under `~/.openclaw/tools/signal-cli/<version>/`
- Skriver `channels.signal.cliPath` i konfigurationen
- JVM-builds kræver Java 21
- Native builds bruges, når de er tilgængelige
- Windows bruger WSL2 og følger Linux signal-cli-flow inde i WSL

## Relaterede dokumenter

- Onboarding-hub: [Onboarding Wizard (CLI)](/start/wizard)
- Automatisering og scripts: [CLI Automation](/start/wizard-cli-automation)
- Kommandoreference: [`openclaw onboard`](/cli/onboard)
