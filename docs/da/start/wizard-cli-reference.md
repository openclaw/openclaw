---
summary: "Komplet reference for CLI-introduktionsflow, opsætning af auth/model, output og interne detaljer"
read_when:
  - Du har brug for detaljeret adfærd for openclaw onboard
  - Du fejlsøger introduktionsresultater eller integrerer introduktionsklienter
title: "CLI Onboarding Reference"
sidebarTitle: "CLI reference"
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
Det installerer eller ændrer ikke noget på den eksterne vært.

## Detaljer for lokalt flow

<Steps>
  <Step title="Existing config detection">
    - Hvis `~/.openclaw/openclaw.json` findes, vælg Keep, Modify, eller Reset.
    - Genkørende guiden sletter ikke noget, medmindre du eksplicit vælger Nulstil (eller pass `--reset`).
    - Hvis config er ugyldig eller indeholder ældre nøgler, guiden stopper og beder dig om at køre `openclaw læge` før du fortsætter.
    - Nulstil bruger `trash` og tilbyder anvendelsesområder:
      - Config only
      - Config + legitimationsoplysninger + sessioner
      - Fuld nulstilling (også fjerner arbejdsområde)  
</Step>
  <Step title="Model and auth">
    - Den fulde valgmatrix findes i [Auth and model options](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Standard `~/.openclaw/workspace` (konfigurerbar).
    - Seeds arbejdsrumsfiler, der er nødvendige til første-run bootstrap ritual.
    - Arbejdsområdelayout: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Prompts for port, bind, auth mode, og skræddersyet eksponering.
    - Anbefalet: Hold token auth aktiveret selv for loopback så lokale WS klienter skal godkende.
    - Deaktivér kun auth hvis du har fuld tillid til hver lokal proces.
    - Non-loopback binds kræver stadig auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): valgfri QR login
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): servicekonto JSON + webhook audience
    - [Mattermost](/channels/mattermost) plugin: bot token + base URL
    - [Signal](/channels/signal): valgfri `signal-cli` install + account config
    - [BlueBubbles](/channels/bluebubbles): anbefales til iMessage; server URL + password + webhook
    - [iMessage](/channels/imessage): legacy `imsg` CLI sti + DB adgang
    - DM security: Standard er parring. Første DM sender en kode. Godkend via
      `openclaw parring godkendelse <channel><code>` eller brug tilladelseslister.
  </Step><code>` eller brug tilladslister.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Kræver logget ind brugersession; for headless, brug en brugerdefineret LaunchDaemon (ikke sendt).
    - Linux og Windows via WSL2: systemd user unit
      - Wizard forsøg `loginctl enable-linger <user>` så gateway forbliver op efter logout.
      - Kan bede om sudo (skriv `/var/lib/systemd/linger`); den prøver uden sudo først.
    - Runtime valg: Node (anbefalet; kræves for WhatsApp og Telegram). Bun anbefales ikke.
  </Step>
  <Step title="Health check">
    - Starter gateway (hvis nødvendigt) og kører `openclaw sundhed`.
    - `openclaw status --deep` tilføjer gateway sundhed sonder til status output.
  </Step>
  <Step title="Skills">
    - Læser tilgængelige færdigheder og kontrol krav.
    - Lader dig vælge node manager: npm eller pnpm (bun anbefales ikke).
    - Installerer valgfri afhængigheder (nogle bruger Homebrew på macOS).
  </Step>
  <Step title="Finish">
    - Resumé og næste trin, herunder iOS, Android og macOS app-muligheder.
  </Step>
</Steps>

<Note>
Hvis der ikke detekteres en GUI, udskriver guiden SSH port-forward instruktioner til Control UI i stedet for at åbne en browser.
Hvis Control UI aktiver mangler, forsøger guiden at bygge dem; fallback er `pnpm ui:build` (auto-installér UI deps).
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
- Hvis gateway kun er loopback-kun, brug SSH-tunneling eller en tailnet.
- Discovery hints:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Auth- og modelmuligheder

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Bruger `ANTHROPIC_API_KEY` hvis den findes eller beder om en nøgle og gemmer den derefter til daemon-brug.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: tjekker Keychain-elementet "Claude Code-credentials"
    - Linux og Windows: genbruger `~/.claude/.credentials.json` hvis den findes

    ```
    På macOS skal du vælge "Always Allow", så launchd-start ikke blokeres.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Kør `claude setup-token` på enhver maskine, og indsæt derefter token.
    Du kan navngive den; blank bruger standard.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Hvis `~/.codex/auth.json` findes, kan guiden genbruge det.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Browser-flow; indsæt `code#state`.

    ```
    Sætter `agents.defaults.model` til `openai-codex/gpt-5.3-codex`, når modellen ikke er sat eller er `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Bruger `OPENAI_API_KEY` hvis den findes eller beder om en nøgle og gemmer den derefter i
    `~/.openclaw/.env`, så launchd kan læse den.

    ```
    Sætter `agents.defaults.model` til `openai/gpt-5.1-codex`, når modellen ikke er sat, er `openai/*` eller `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Beder om `XAI_API_KEY` og konfigurerer xAI som modeludbyder.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Spørg om `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`).
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Gemmer nøglen for dig.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Spørg til `AI_GATEWAY_API_KEY`.
    Flere detaljer: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Foreslår om konto ID, gateway ID og `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Flere detaljer: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Konfigurationen er auto-skrevet.
    Flere detaljer: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Forslag til `SYNTHETIC_API_KEY`.
    Flere detaljer: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) og Kimi Coding configs er automatisk skrevet.
    Flere detaljer: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
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

WhatsApp legitimationsoplysninger går under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessioner opbevares under `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Nogle kanaler leveres som plugins. Når dette er valgt under onboarding, beder guiden
om at installere plugin'et (npm eller lokal sti) før kanalkonfiguration.
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
