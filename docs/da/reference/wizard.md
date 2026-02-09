---
summary: "Fuld reference for CLI-onboardingguiden: hvert trin, flag og konfigurationsfelt"
read_when:
  - Når du slår et specifikt trin eller flag i guiden op
  - Når du automatiserer onboarding med ikke-interaktiv tilstand
  - Når du fejlsøger guidens adfærd
title: "Reference for onboardingguide"
sidebarTitle: "Guide-reference"
---

# Reference for onboardingguide

Dette er den fulde reference for 'openclaw onboard' CLI guide.
For en oversigt på højt niveau, se [Onboardingguide](/start/wizard).

## Flow-detaljer (lokal tilstand)

<Steps>
  <Step title="Existing config detection">
    - Hvis `~/.openclaw/openclaw.json` findes, vælg **Behold / Ændr / Nulstil**.
    - Genkørende guiden gør **ikke** tørre noget, medmindre du eksplicit vælger **Nulstil**
      (eller pass `--reset`).
    - Hvis config er ugyldig eller indeholder ældre nøgler, guiden stopper og beder
      du at køre `openclaw læge` før du fortsætter.
    - Nulstil bruger `trash` (aldrig `rm`) og tilbyder anvendelsesområder:
      - Config only
      - Config + legitimationsoplysninger + sessioner
      - Fuld nulstilling (også fjerner arbejdsområde)  
</Step>
  <Step title="Model/Auth">
    - **Antropisk API-nøgle (anbefalet)**: bruger `ANTHROPIC_API_KEY` hvis den er til stede eller beder om en nøgle, så gemmer den til brug af dæmonen.
    - **Antropisk OAuth (Claude Code CLI)**: på macOS kontrollerer guiden Keychain element "Claude Code-credentials" (vælg "Altid Tillad", så launchd begynder ikke at blokere) på Linux/Windows genbruger den `~/. laude/.credentials.json«, hvis de er til stede.
    - **Anthropic token (paste setup-token)**: run `claude setup-token` på enhver maskine, derefter indsætte token (du kan navngive det; blank = standard).
    - **OpenAI Code (Codex) abonnement (Codex CLI)**: hvis `~/.codex/auth.json` findes, kan guiden genbruge den.
    - **OpenAI Code (Codex) abonnement (OAuth)**: browser flow; indsæt `code#state`.
      - Sætter `agents.defaults.model` til `openai-codex/gpt-5.2` når modellen er frakoblet eller `openai/*`.
    - **OpenAI API-nøgle**: bruger `OPENAI_API_KEY` hvis den er til stede eller beder om en nøgle, så gemmer den til `~/.openclaw/.env` så launchd kan læse den.
    - **xAI (Grok) API-nøgle**: beder om `XAI_API_KEY` og konfigurerer xAI som modeludbyder.
    - **OpenCode Zen (multi-model proxy)**: prompts for `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`, få det på https://opencode.ai/auth).
    - **API-nøgle **: gemmer nøglen til dig.
    - **Vercel AI Gateway (multi-model proxy)**: beder om `AI_GATEWAY_API_KEY`.
    - Flere detaljer: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: prompts for Account ID, Gateway ID og `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Flere detaljer: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config is auto-written.
    - Flere detaljer: [MiniMax](/providers/minimax)
    - **Syntetisk (Antropisk-kompatibel)**: beder om `SYNTHETIC_API_KEY`.
    - Flere detaljer: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config is auto-written.
    - **Kimi kodning**: config er automatisk skrevet.
    - Flere detaljer: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: ingen auth konfigureret endnu.
    - Vælg en standardmodel fra fundne muligheder (eller indtaste udbyder/model manuelt).
    - Guiden kører et modeltjek og advarer, hvis den konfigurerede model er ukendt eller mangler auth.
    - OAuth legitimationsoplysninger bor i `~/.openclaw/credentials/oauth.json`; auth profiler live i `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API-nøgler + OAuth).
    - Mere detaljer: [/concepts/oauth](/concepts/oauth)    
<Note>
    Tip til headless/server: gennemfør OAuth på en maskine med browser, og kopiér derefter
    `~/.openclaw/credentials/oauth.json` (eller `$OPENCLAW_STATE_DIR/credentials/oauth.json`) til
    gateway-værten.
    </Note>
  </Step>
  <Step title="Workspace">
    - Standard `~/.openclaw/workspace` (konfigurerbar).
    - Frø de nødvendige arbejdsrumsfiler til agenten bootstrap ritual.
    - Fuld workspace-layout + backup-guide: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Port, bind, auth mode, tailscale eksponering.
    - Auth anbefaling: Behold **Token** selv for loopback så lokale WS kunder skal godkende.
    - Deaktivér kun auth hvis du har fuld tillid til hver lokal proces.
    - Ikke- loopback bindinger kræver stadig auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): valgfri QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): Tjenestekonto JSON + webhook publikum.
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.
    - [Signal](/channels/signal): optional `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **anbefales til iMessage**; server URL + password + webhook.
    - [iMessage](/channels/imessage): arv `imsg` CLI sti + DB adgang.
    - DM sikkerhed: standard er parring. Første DM sender en kode. Godkend via `openclaw parring godkendelse <channel><code>` eller brug tilladelseslister.
  </Step><code>` eller brug tilladelseslister.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Kræver en indlogget brugersession; for headless, brug en brugerdefineret LaunchDaemon (ikke sendt).
    - Linux (og Windows via WSL2): systemd user unit
      - Wizard forsøger at aktivere dvale via `loginctl enable-linger <user>', så Gateway forbliver op efter logout.
      - Kan bede om sudo (skriv `/var/lib/systemd/linger`); den prøver uden sudo først.
    - **Runtime selection:** Node (anbefalet; kræves for WhatsApp/Telegram). Bun er **anbefales ikke**.
  </Step>
  <Step title="Health check">
    - Starts the Gateway (hvis nødvendigt) and runs `openclaw health`.
    - Tip: `openclaw status --deep` tilføjer gateway sundhed sonder til status output (kræver en nås gateway).
  </Step>
  <Step title="Skills (recommended)">
    - Læser de tilgængelige færdigheder og kontrol krav.
    - Lader dig vælge en node manager: **npm / pnpm** (bun anbefales ikke).
    - Installerer valgfri afhængigheder (nogle bruger Homebrew på macOS).
  </Step>
  <Step title="Finish">
    - Oversigt + næste trin, herunder iOS/Android/macOS apps til ekstra funktioner.
  </Step>
</Steps>

<Note>
Hvis der ikke detekteres en GUI, udskriver guiden SSH port-forward instruktioner til Control UI i stedet for at åbne en browser.
Hvis Control UI aktiver mangler, forsøger guiden at bygge dem; fallback er `pnpm ui:build` (auto-installér UI deps).
</Note>

## Ikke-interaktiv tilstand

Brug `--non-interactive` til at automatisere eller scripte onboarding:

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

Tilføj `--json` for en maskinlæsbar opsummering.

<Note>
`--json` betyder **ikke** betyder ikke-interaktiv tilstand. Brug `--non-interactive` (og `--workspace`) til scripts.
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

### Tilføj agent (ikke-interaktiv)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway guide RPC

Gateway udsætter guiden flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Kunder (macOS app, Control UI) kan gøre trin uden genimplementering onboarding logik.

## Signal-opsætning (signal-cli)

Guiden kan installere `signal-cli` fra GitHub-releases:

- Downloader det passende release-asset.
- Gemmer det under `~/.openclaw/tools/signal-cli/<version>/`.
- Skriver `channels.signal.cliPath` til din konfiguration.

Noter:

- JVM-builds kræver **Java 21**.
- Native builds bruges, når de er tilgængelige.
- Windows bruger WSL2; installation af signal-cli følger Linux-flowet inde i WSL.

## Hvad guiden skriver

Typiske felter i `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (hvis Minimax er valgt)
- `gateway.*` (tilstand, binding, auth, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Kanal-tilladelseslister (Slack/Discord/Matrix/Microsoft Teams), når du tilvælger dem under prompts (navne opløses til ID’er, når det er muligt).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` skriver `agents.list[]` og valgfri `bindings`.

WhatsApp legitimationsoplysninger går under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessioner opbevares under `~/.openclaw/agents/<agentId>/sessions/`.

Nogle kanaler leveres som plugins. Når du vælger en under onboarding, vil guiden
bede om at installere den (npm eller en lokal sti), før den kan konfigureres.

## Relaterede dokumenter

- Overblik over guiden: [Onboarding Wizard](/start/wizard)
- Onboarding i macOS-app: [Onboarding](/start/onboarding)
- Konfigurationsreference: [Gateway configuration](/gateway/configuration)
- Udbydere: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
