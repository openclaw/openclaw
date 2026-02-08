---
summary: "Doctor-kommando: hälsokontroller, konfigmigreringar och reparationssteg"
read_when:
  - Lägger till eller ändrar doctor-migreringar
  - Introducerar brytande konfigändringar
title: "Doctor"
x-i18n:
  source_path: gateway/doctor.md
  source_hash: df7b25f60fd08d50
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:38Z
---

# Doctor

`openclaw doctor` är reparations- och migreringsverktyget för OpenClaw. Det åtgärdar inaktuell
konfig/tillstånd, kontrollerar hälsa och ger handlingsbara reparationssteg.

## Snabbstart

```bash
openclaw doctor
```

### Headless / automation

```bash
openclaw doctor --yes
```

Acceptera standardval utan att fråga (inklusive omstart-/tjänst-/sandbox-reparationssteg när tillämpligt).

```bash
openclaw doctor --repair
```

Tillämpa rekommenderade reparationer utan att fråga (reparationer + omstarter där det är säkert).

```bash
openclaw doctor --repair --force
```

Tillämpa även aggressiva reparationer (skriver över anpassade supervisor-konfigar).

```bash
openclaw doctor --non-interactive
```

Kör utan frågor och tillämpa endast säkra migreringar (konfig-normalisering + flytt av tillstånd på disk). Hoppar över omstart-/tjänst-/sandbox-åtgärder som kräver mänsklig bekräftelse.
Äldre tillståndsmigreringar körs automatiskt när de upptäcks.

```bash
openclaw doctor --deep
```

Skanna systemtjänster efter extra gateway-installationer (launchd/systemd/schtasks).

Om du vill granska ändringar innan de skrivs, öppna konfigfilen först:

```bash
cat ~/.openclaw/openclaw.json
```

## Vad den gör (sammanfattning)

- Valfri pre-flight-uppdatering för git-installationer (endast interaktivt).
- Kontroll av UI-protokollens aktualitet (bygger om Control UI när protokollschemat är nyare).
- Hälsokontroll + uppmaning om omstart.
- Sammanfattning av Skills-status (berättigade/saknade/blockerade).
- Konfig-normalisering för äldre värden.
- Varningar för OpenCode Zen-leverantörsöverskrivningar (`models.providers.opencode`).
- Migrering av äldre tillstånd på disk (sessioner/agentkatalog/WhatsApp-autentisering).
- Kontroller av tillståndsintegritet och behörigheter (sessioner, transkript, tillståndskatalog).
- Kontroller av konfigfilens behörigheter (chmod 600) vid lokal körning.
- Modellautentiseringshälsa: kontrollerar OAuth-utgång, kan uppdatera utgående tokens och rapporterar auth-profilers cooldown/inaktiverade tillstånd.
- Detektering av extra arbetsytekatalog (`~/openclaw`).
- Reparation av sandbox-avbildning när sandboxing är aktiverat.
- Migrering av äldre tjänster och detektering av extra gateway.
- Kontroller av Gateway-körtid (tjänst installerad men körs inte; cachad launchd-etikett).
- Kanalstatusvarningar (sonderas från den körande gatewayen).
- Granskning av supervisor-konfig (launchd/systemd/schtasks) med valfri reparation.
- Bästa praxis-kontroller för Gateway-körtid (Node vs Bun, sökvägar för versionshanterare).
- Diagnostik för Gateway-portkollisioner (standard `18789`).
- Säkerhetsvarningar för öppna DM-policyer.
- Gateway-autentiseringsvarningar när ingen `gateway.auth.token` är satt (lokalt läge; erbjuder token-generering).
- systemd linger-kontroll på Linux.
- Kontroller för källinstallation (pnpm workspace-mismatch, saknade UI-tillgångar, saknad tsx-binär).
- Skriver uppdaterad konfig + guide-metadata.

## Detaljerat beteende och motiv

### 0) Valfri uppdatering (git-installationer)

Om detta är en git-utcheckning och doctor körs interaktivt, erbjuder den att
uppdatera (fetch/rebase/build) innan doctor körs.

### 1) Konfig-normalisering

Om konfigen innehåller äldre värdeformer (till exempel `messages.ackReaction`
utan en kanalspecifik överskrivning) normaliserar doctor dem till det aktuella
schemat.

### 2) Migreringar av äldre konfig-nycklar

När konfigen innehåller utfasade nycklar vägrar andra kommandon att köras och ber
dig köra `openclaw doctor`.

Doctor kommer att:

- Förklara vilka äldre nycklar som hittades.
- Visa migreringen som tillämpades.
- Skriva om `~/.openclaw/openclaw.json` med det uppdaterade schemat.

Gatewayen kör också automatiskt doctor-migreringar vid uppstart när den upptäcker
ett äldre konfigformat, så inaktuella konfigar repareras utan manuell åtgärd.

Aktuella migreringar:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → toppnivå `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen-leverantörsöverskrivningar

Om du manuellt har lagt till `models.providers.opencode` (eller `opencode-zen`) åsidosätter det
den inbyggda OpenCode Zen-katalogen från `@mariozechner/pi-ai`. Det kan
tvinga alla modeller till ett enda API eller nollställa kostnader. Doctor varnar
så att du kan ta bort överskrivningen och återställa per-modell-API-routning + kostnader.

### 3) Migreringar av äldre tillstånd (disklayout)

Doctor kan migrera äldre layouter på disk till den aktuella strukturen:

- Sessionslagring + transkript:
  - från `~/.openclaw/sessions/` till `~/.openclaw/agents/<agentId>/sessions/`
- Agentkatalog:
  - från `~/.openclaw/agent/` till `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp-autentiseringstillstånd (Baileys):
  - från äldre `~/.openclaw/credentials/*.json` (utom `oauth.json`)
  - till `~/.openclaw/credentials/whatsapp/<accountId>/...` (standardkonto-id: `default`)

Dessa migreringar är best-effort och idempotenta; doctor utfärdar varningar när
den lämnar kvar äldre mappar som säkerhetskopior. Gateway/CLI migrerar också
automatiskt de äldre sessionerna + agentkatalogen vid uppstart så att historik/autentisering/modeller hamnar i per-agent-sökvägen utan manuell doctor-körning. WhatsApp-autentisering migreras avsiktligt endast via `openclaw doctor`.

### 4) Kontroller av tillståndsintegritet (sessionspersistens, routning och säkerhet)

Tillståndskatalogen är den operativa hjärnstammen. Om den försvinner förlorar du
sessioner, autentiseringsuppgifter, loggar och konfig (om du inte har säkerhetskopior någon annanstans).

Doctor kontrollerar:

- **Tillståndskatalog saknas**: varnar om katastrofal tillståndsförlust, uppmanar att återskapa
  katalogen och påminner om att den inte kan återställa saknade data.
- **Behörigheter för tillståndskatalog**: verifierar skrivbarhet; erbjuder att reparera behörigheter
  (och ger en `chown`-hint när ägare/grupp-mismatch upptäcks).
- **Sessionskataloger saknas**: `sessions/` och sessionslagringskatalogen krävs
  för att bevara historik och undvika `ENOENT`-krascher.
- **Transkript-mismatch**: varnar när nyliga sessionsposter saknar
  transkriptfiler.
- **Huvudsession ”1-rads JSONL”**: flaggar när huvudtranskriptet bara har en
  rad (historiken ackumuleras inte).
- **Flera tillståndskataloger**: varnar när flera `~/.openclaw`-mappar finns över
  hemkataloger eller när `OPENCLAW_STATE_DIR` pekar någon annanstans (historik kan
  delas mellan installationer).
- **Påminnelse om fjärrläge**: om `gateway.mode=remote` påminner doctor dig att köra
  den på fjärrvärden (tillståndet finns där).
- **Konfigfilens behörigheter**: varnar om `~/.openclaw/openclaw.json` är
  läsbar för grupp/värld och erbjuder att strama åt till `600`.

### 5) Modellautentiseringshälsa (OAuth-utgång)

Doctor inspekterar OAuth-profiler i autentiseringslagret, varnar när tokens
håller på att gå ut/har gått ut och kan uppdatera dem när det är säkert. Om Anthropic Claude Code-profilen
är inaktuell föreslår den att köra `claude setup-token` (eller klistra in en setup-token).
Uppdateringsuppmaningar visas endast vid interaktiv körning (TTY); `--non-interactive`
hoppar över uppdateringsförsök.

Doctor rapporterar också autentiseringsprofiler som tillfälligt är obrukbara på grund av:

- korta cooldowns (hastighetsbegränsningar/timeouts/autentiseringsfel)
- längre inaktiveringar (fakturering/kreditfel)

### 6) Validering av Hooks-modell

Om `hooks.gmail.model` är satt validerar doctor modellreferensen mot
katalogen och tillåtelselistan och varnar när den inte kan lösas eller är otillåten.

### 7) Reparation av sandbox-avbildning

När sandboxing är aktiverat kontrollerar doctor Docker-avbildningar och erbjuder att bygga eller
byta till äldre namn om den aktuella avbildningen saknas.

### 8) Migreringar av Gateway-tjänster och städhints

Doctor upptäcker äldre gateway-tjänster (launchd/systemd/schtasks) och
erbjuder att ta bort dem och installera OpenClaw-tjänsten med den aktuella gateway-porten. Den kan också skanna efter extra gateway-liknande tjänster och skriva ut städhints.
Profilnamngivna OpenClaw gateway-tjänster betraktas som förstklassiga och flaggas inte som ”extra”.

### 9) Säkerhetsvarningar

Doctor utfärdar varningar när en leverantör är öppen för DM utan en tillåtelselista, eller
när en policy är konfigurerad på ett farligt sätt.

### 10) systemd linger (Linux)

Om den körs som en systemd-användartjänst säkerställer doctor att lingering är aktiverat så att
gatewayen fortsätter att vara igång efter utloggning.

### 11) Skills-status

Doctor skriver ut en snabb sammanfattning av berättigade/saknade/blockerade Skills för den aktuella arbetsytan.

### 12) Gateway-autentiseringskontroller (lokal token)

Doctor varnar när `gateway.auth` saknas på en lokal gateway och erbjuder att
generera en token. Använd `openclaw doctor --generate-gateway-token` för att tvinga token-
skapande i automation.

### 13) Gateway-hälsokontroll + omstart

Doctor kör en hälsokontroll och erbjuder att starta om gatewayen när den verkar
ohälsosam.

### 14) Kanalstatusvarningar

Om gatewayen är frisk kör doctor en kanalstatussond och rapporterar
varningar med föreslagna åtgärder.

### 15) Granskning + reparation av supervisor-konfig

Doctor kontrollerar den installerade supervisor-konfigen (launchd/systemd/schtasks) för
saknade eller inaktuella standarder (t.ex. systemd-beroenden för network-online och
omstartsfördröjning). När den hittar en avvikelse rekommenderar den en uppdatering och kan
skriva om servicefilen/uppgiften till de aktuella standarderna.

Noteringar:

- `openclaw doctor` frågar innan omskrivning av supervisor-konfig.
- `openclaw doctor --yes` accepterar standardreparationsuppmaningar.
- `openclaw doctor --repair` tillämpar rekommenderade åtgärder utan frågor.
- `openclaw doctor --repair --force` skriver över anpassade supervisor-konfigar.
- Du kan alltid tvinga en fullständig omskrivning via `openclaw gateway install --force`.

### 16) Diagnostik för Gateway-körtid + port

Doctor inspekterar tjänstens körtid (PID, senaste avslutsstatus) och varnar när
tjänsten är installerad men faktiskt inte körs. Den kontrollerar också portkollisioner
på gateway-porten (standard `18789`) och rapporterar troliga orsaker (gateway redan
körs, SSH-tunnel).

### 17) Bästa praxis för Gateway-körtid

Doctor varnar när gateway-tjänsten körs på Bun eller en Node-sökväg som hanteras av en versionshanterare
(`nvm`, `fnm`, `volta`, `asdf`, osv.). WhatsApp- och Telegram-kanaler kräver Node,
och sökvägar för versionshanterare kan gå sönder efter uppgraderingar eftersom tjänsten inte
läser in din shell-init. Doctor erbjuder att migrera till en systeminstallerad Node när
tillgänglig (Homebrew/apt/choco).

### 18) Skrivning av konfig + guide-metadata

Doctor sparar alla konfigändringar och stämplar guide-metadata för att registrera doctor-körningen.

### 19) Arbetsyte-tips (backup + minnessystem)

Doctor föreslår ett minnessystem för arbetsytan när det saknas och skriver ut ett backup-tips
om arbetsytan inte redan ligger under git.

Se [/concepts/agent-workspace](/concepts/agent-workspace) för en fullständig guide till
arbetsytestruktur och git-backup (rekommenderat privat GitHub eller GitLab).
