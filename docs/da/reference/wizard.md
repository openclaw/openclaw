---
summary: "Fuld reference for CLI-onboardingguiden: hvert trin, flag og konfigurationsfelt"
read_when:
  - Når du slår et specifikt trin eller flag i guiden op
  - Når du automatiserer onboarding med ikke-interaktiv tilstand
  - Når du fejlsøger guidens adfærd
title: "Reference for onboardingguide"
sidebarTitle: "Guide-reference"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:58Z
---

# Reference for onboardingguide

Dette er den fulde reference for `openclaw onboard` CLI-guiden.
For et overordnet overblik, se [Onboarding Wizard](/start/wizard).

## Flow-detaljer (lokal tilstand)

<Steps>
  <Step title="Registrering af eksisterende konfiguration">
    - Hvis `~/.openclaw/openclaw.json` findes, kan du vælge **Behold / Redigér / Nulstil**.
    - Genkørsel af guiden sletter **ikke** noget, medmindre du eksplicit vælger **Nulstil**
      (eller angiver `--reset`).
    - Hvis konfigurationen er ugyldig eller indeholder forældede nøgler, stopper guiden og beder
      dig om at køre `openclaw doctor` før du fortsætter.
    - Nulstilling bruger `trash` (aldrig `rm`) og tilbyder niveauer:
      - Kun konfiguration
      - Konfiguration + legitimationsoplysninger + sessioner
      - Fuld nulstilling (fjerner også workspace)
  </Step>
  <Step title="Model/Auth">
    - **Anthropic API-nøgle (anbefalet)**: bruger `ANTHROPIC_API_KEY` hvis den findes, eller beder om en nøgle og gemmer den derefter til daemon-brug.
    - **Anthropic OAuth (Claude Code CLI)**: på macOS tjekker guiden nøgleringselementet "Claude Code-credentials" (vælg "Always Allow", så launchd-starts ikke blokeres); på Linux/Windows genbruges `~/.claude/.credentials.json` hvis den findes.
    - **Anthropic-token (indsæt setup-token)**: kør `claude setup-token` på en vilkårlig maskine, og indsæt derefter tokenet (du kan navngive det; tom = standard).
    - **OpenAI Code (Codex)-abonnement (Codex CLI)**: hvis `~/.codex/auth.json` findes, kan guiden genbruge det.
    - **OpenAI Code (Codex)-abonnement (OAuth)**: browserflow; indsæt `code#state`.
      - Sætter `agents.defaults.model` til `openai-codex/gpt-5.2`, når modellen ikke er sat eller er `openai/*`.
    - **OpenAI API-nøgle**: bruger `OPENAI_API_KEY` hvis den findes, eller beder om en nøgle og gemmer den derefter i `~/.openclaw/.env`, så launchd kan læse den.
    - **xAI (Grok) API-nøgle**: beder om `XAI_API_KEY` og konfigurerer xAI som modeludbyder.
    - **OpenCode Zen (multi-model proxy)**: beder om `OPENCODE_API_KEY` (eller `OPENCODE_ZEN_API_KEY`, få den på https://opencode.ai/auth).
    - **API-nøgle**: gemmer nøglen for dig.
    - **Vercel AI Gateway (multi-model proxy)**: beder om `AI_GATEWAY_API_KEY`.
    - Flere detaljer: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: beder om Account ID, Gateway ID og `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Flere detaljer: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: konfigurationen skrives automatisk.
    - Flere detaljer: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-kompatibel)**: beder om `SYNTHETIC_API_KEY`.
    - Flere detaljer: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: konfigurationen skrives automatisk.
    - **Kimi Coding**: konfigurationen skrives automatisk.
    - Flere detaljer: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Spring over**: ingen autentificering konfigureres endnu.
    - Vælg en standardmodel fra de registrerede muligheder (eller angiv udbyder/model manuelt).
    - Guiden kører et modeltjek og advarer, hvis den konfigurerede model er ukendt eller mangler autentificering.
    - OAuth-legitimationsoplysninger ligger i `~/.openclaw/credentials/oauth.json`; auth-profiler ligger i `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API-nøgler + OAuth).
    - Flere detaljer: [/concepts/oauth](/concepts/oauth)
    <Note>
    Tip til headless/server: gennemfør OAuth på en maskine med browser, og kopiér derefter
    `~/.openclaw/credentials/oauth.json` (eller `$OPENCLAW_STATE_DIR/credentials/oauth.json`) til
    gateway-værten.
    </Note>
  </Step>
  <Step title="Workspace">
    - Standard `~/.openclaw/workspace` (kan konfigureres).
    - Seeder workspace-filerne, der er nødvendige for agentens bootstrap-ritual.
    - Fuld workspace-struktur + backup-guide: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - Port, binding, auth-tilstand, Tailscale-eksponering.
    - Anbefaling for auth: behold **Token** selv for loopback, så lokale WS-klienter skal autentificere.
    - Deaktivér kun auth, hvis du fuldt ud stoler på alle lokale processer.
    - Bindinger uden for loopback kræver stadig auth.
  </Step>
  <Step title="Kanaler">
    - [WhatsApp](/channels/whatsapp): valgfri QR-login.
    - [Telegram](/channels/telegram): bot-token.
    - [Discord](/channels/discord): bot-token.
    - [Google Chat](/channels/googlechat): servicekonto-JSON + webhook-audience.
    - [Mattermost](/channels/mattermost) (plugin): bot-token + base-URL.
    - [Signal](/channels/signal): valgfri installation af `signal-cli` + kontokonfiguration.
    - [BlueBubbles](/channels/bluebubbles): **anbefalet til iMessage**; server-URL + adgangskode + webhook.
    - [iMessage](/channels/imessage): ældre `imsg` CLI-sti + DB-adgang.
    - DM-sikkerhed: standard er parring. Første DM sender en kode; godkend via `openclaw pairing approve <channel> <code>` eller brug tilladelseslister.
  </Step>
  <Step title="Installation af daemon">
    - macOS: LaunchAgent
      - Kræver en aktivt logget bruger-session; for headless, brug en tilpasset LaunchDaemon (medfølger ikke).
    - Linux (og Windows via WSL2): systemd user unit
      - Guiden forsøger at aktivere lingering via `loginctl enable-linger <user>`, så Gateway forbliver oppe efter logout.
      - Kan bede om sudo (skriver `/var/lib/systemd/linger`); den prøver uden sudo først.
    - **Valg af runtime:** Node (anbefalet; påkrævet for WhatsApp/Telegram). Bun er **ikke anbefalet**.
  </Step>
  <Step title="Sundhedstjek">
    - Starter Gateway (hvis nødvendigt) og kører `openclaw health`.
    - Tip: `openclaw status --deep` tilføjer gateway-sundhedsprober til statusoutput (kræver en tilgængelig gateway).
  </Step>
  <Step title="Skills (anbefalet)">
    - Læser de tilgængelige Skills og tjekker krav.
    - Lader dig vælge en node manager: **npm / pnpm** (bun ikke anbefalet).
    - Installerer valgfrie afhængigheder (nogle bruger Homebrew på macOS).
  </Step>
  <Step title="Afslut">
    - Opsummering + næste trin, inkl. iOS/Android/macOS-apps for ekstra funktioner.
  </Step>
</Steps>

<Note>
Hvis der ikke registreres nogen GUI, udskriver guiden instruktioner til SSH-port-forwarding for Control UI i stedet for at åbne en browser.
Hvis Control UI-assets mangler, forsøger guiden at bygge dem; fallback er `pnpm ui:build` (auto-installerer UI-afhængigheder).
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
`--json` indebærer **ikke** ikke-interaktiv tilstand. Brug `--non-interactive` (og `--workspace`) til scripts.
</Note>

<AccordionGroup>
  <Accordion title="Gemini-eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI-eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway-eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway-eksempel">
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
  <Accordion title="Moonshot-eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic-eksempel">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen-eksempel">
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

Gateway eksponerer guide-flowet over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Klienter (macOS-app, Control UI) kan rendere trin uden at genimplementere onboarding-logikken.

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

WhatsApp-legitimationsoplysninger ligger under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessioner gemmes under `~/.openclaw/agents/<agentId>/sessions/`.

Nogle kanaler leveres som plugins. Når du vælger en under onboarding, vil guiden
bede om at installere den (npm eller en lokal sti), før den kan konfigureres.

## Relaterede dokumenter

- Overblik over guiden: [Onboarding Wizard](/start/wizard)
- Onboarding i macOS-app: [Onboarding](/start/onboarding)
- Konfigurationsreference: [Gateway configuration](/gateway/configuration)
- Udbydere: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
