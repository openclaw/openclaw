---
summary: "Doctor-kommando: helbredstjek, konfigurationsmigreringer og reparations­trin"
read_when:
  - Tilføjelse eller ændring af doctor-migreringer
  - Introduktion af brydende konfigurationsændringer
title: "Doctor"
---

# Doctor

`openclaw doctor` er reparation + migration værktøj til OpenClaw. Det løser forsvundet
config/tilstand, kontrollerer sundhed og giver handlingsbare reparationstrin.

## Hurtig start

```bash
openclaw doctor
```

### Headless / automatisering

```bash
openclaw doctor --yes
```

Accepter standardindstillinger uden at blive spurgt (inkl. genstart/service/sandbox-reparationer, når relevant).

```bash
openclaw doctor --repair
```

Anvend anbefalede reparationer uden at blive spurgt (reparationer + genstarter, hvor det er sikkert).

```bash
openclaw doctor --repair --force
```

Anvend også aggressive reparationer (overskriver brugerdefinerede supervisor-konfigurationer).

```bash
openclaw doctor --non-interactive
```

Kør uden prompter og kun anvende sikre migrationer (config normalisering + on-disk state flytter). Skifter genstart/service/sandkasse handlinger, der kræver menneskelig bekræftelse.
Ældre tilstandsmigrationer kører automatisk, når de opdages.

```bash
openclaw doctor --deep
```

Scan systemtjenester for ekstra gateway-installationer (launchd/systemd/schtasks).

Hvis du vil gennemgå ændringer, før der skrives, så åbn konfigurationsfilen først:

```bash
cat ~/.openclaw/openclaw.json
```

## Hvad den gør (resumé)

- Valgfri pre-flight-opdatering for git-installationer (kun interaktiv).
- Tjek af UI-protokollens aktualitet (genbygger Control UI, når protokolschemaet er nyere).
- Helbredstjek + prompt for genstart.
- Statusoversigt for Skills (egnede/manglende/blokerede).
- Konfigurationsnormalisering for ældre værdier.
- Advarsler om OpenCode Zen-udbyderoverrides (`models.providers.opencode`).
- Migrering af ældre on-disk-tilstand (sessions/agent-mappe/WhatsApp-auth).
- Tjek af tilstands-integritet og -rettigheder (sessions, transskripter, state-mappe).
- Tjek af konfigurationsfilens rettigheder (chmod 600), når der køres lokalt.
- Model-auth-helbred: tjekker OAuth-udløb, kan opdatere udløbende tokens og rapporterer auth-profilers cooldown/deaktiverede tilstande.
- Detektion af ekstra workspace-mapper (`~/openclaw`).
- Reparation af sandbox-image, når sandboxing er aktiveret.
- Migrering af ældre tjenester og detektion af ekstra gateway-installationer.
- Gateway-runtime-tjek (tjeneste installeret men kører ikke; cachet launchd-label).
- Kanalstatusadvarsler (probet fra den kørende gateway).
- Revision af supervisor-konfiguration (launchd/systemd/schtasks) med valgfri reparation.
- Gateway-runtime best-practice-tjek (Node vs Bun, version-manager-stier).
- Diagnostik af gateway-portkollisioner (standard `18789`).
- Sikkerhedsadvarsler for åbne DM-politikker.
- Gateway-auth-advarsler, når ingen `gateway.auth.token` er sat (lokal tilstand; tilbyder token-generering).
- systemd linger-tjek på Linux.
- Tjek for kildeinstallationer (pnpm workspace-mismatch, manglende UI-assets, manglende tsx-binær).
- Skriver opdateret konfiguration + wizard-metadata.

## Detaljeret adfærd og begrundelse

### 0. Valgfri opdatering (git-installationer)

Hvis dette er et git-checkout, og doctor kører interaktivt, tilbyder den at
opdatere (fetch/rebase/build), før doctor køres.

### 1. Konfigurationsnormalisering

Hvis konfigurationen indeholder ældre værdiformer (for eksempel `messages.ackReaction`
uden en kanal-specifik override), normaliserer doctor dem til det aktuelle
skema.

### 2. Migreringer af ældre konfigurationsnøgler

Når konfigurationen indeholder forældede nøgler, nægter andre kommandoer at køre
og beder dig om at køre `openclaw doctor`.

Doctor vil:

- Forklare hvilke ældre nøgler der blev fundet.
- Vise den migrering, der blev anvendt.
- Omskrive `~/.openclaw/openclaw.json` med det opdaterede skema.

Gateway kører også automatisk doctor-migreringer ved opstart, når den registrerer
et ældre konfigurationsformat, så forældede konfigurationer repareres uden manuel
indgriben.

Aktuelle migreringer:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → topniveau `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode Zen-udbyderoverrides

Hvis du har tilføjet `models.providers.opencode` (eller `opencode-zen`) manuelt, det
tilsidesætter den indbyggede OpenCode Zen katalog fra `@mariozechner/pi-ai`. Det kan
tvinge hver model til en enkelt API eller nul ud omkostninger. Læge advarer så du kan
fjerne overskrivningen og gendanne per-model API routing + omkostninger.

### 3. Migrering af ældre tilstand (disklayout)

Doctor kan migrere ældre on-disk-layouts til den aktuelle struktur:

- Sessionslager + transskripter:
  - fra `~/.openclaw/sessions/` til `~/.openclaw/agents/<agentId>/sessions/`
- Agent-mappe:
  - fra `~/.openclaw/agent/` til `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp-auth-tilstand (Baileys):
  - fra ældre `~/.openclaw/credentials/*.json` (undtagen `oauth.json`)
  - til `~/.openclaw/credentials/whatsapp/<accountId>/...` (standard konto-id: `default`)

Disse vandringer er bedste indsats og idempotent; læge vil udsende advarsler, når
det efterlader nogen arv mapper bag som backups. Gateway/CLI migrerer også automatisk
de ældre sessioner + agent dir ved opstart, så historik/auth/modeller lander i
per-agent stien uden en manuel læge kører. WhatsApp auth er bevidst kun
migreret via `openclaw doktor`.

### 4. Tjek af tilstands-integritet (session-persistens, routing og sikkerhed)

Staten mappe er den operationelle hjernestam. Hvis det forsvinder, mister du
sessioner, legitimationsoplysninger, logs og config (medmindre du har sikkerhedskopier andre steder).

Doctor tjekker:

- **Manglende state-mappe**: advarer om katastrofalt tab af tilstand, tilbyder at
  genskabe mappen og minder om, at manglende data ikke kan gendannes.
- **Rettigheder på state-mappe**: verificerer skrivbarhed; tilbyder at reparere
  rettigheder (og udsender et `chown`-hint, når ejer/gruppe-mismatch
  opdages).
- **Manglende sessionsmapper**: `sessions/` og sessionslager-mappen er
  nødvendige for at bevare historik og undgå `ENOENT`-crashes.
- **Transskript-mismatch**: advarer, når nylige sessionsposter mangler
  transskriptfiler.
- **Hovedsession “1-linjers JSONL”**: markerer, når hovedtransskriptet kun har én
  linje (historikken akkumulerer ikke).
- **Flere state-mapper**: advarer, når der findes flere `~/.openclaw`-mapper på
  tværs af hjemmemapper, eller når `OPENCLAW_STATE_DIR` peger et andet sted hen
  (historik kan splittes mellem installationer).
- **Påmindelse om remote-tilstand**: hvis `gateway.mode=remote`, minder doctor dig om
  at køre den på den fjernværtsmaskine (tilstanden bor der).
- **Rettigheder på konfigurationsfil**: advarer, hvis `~/.openclaw/openclaw.json` er
  gruppe/verdens-læsbar og tilbyder at stramme til `600`.

### 5. Model-auth-helbred (OAuth-udløb)

Læge inspicerer OAuth profiler i auth Store, advarer når tokens er
udløb/udløbet og kan opdatere dem, når det er sikkert. Hvis Anthropic Claude Code
profilen er stille, foreslår den at køre `claude setup-token` (eller indsætte en setup-token).
Genopfrisk prompter vises kun, når du kører interaktivt (TTY); `--non-interactive`
springer op over opdateringsforsøg.

Doctor rapporterer også auth-profiler, der midlertidigt er ubrugelige på grund af:

- korte cooldowns (rate limits/timeouts/auth-fejl)
- længere deaktiveringer (fakturering/kredit-fejl)

### 6. Validering af Hooks-model

Hvis `hooks.gmail.model` er sat, validerer doctor modelreferencen mod kataloget og
tilladelseslisten og advarer, når den ikke kan slås op eller er forbudt.

### 7. Reparation af sandbox-image

Når sandboxing er aktiveret, tjekker doctor Docker-images og tilbyder at bygge
eller skifte til ældre navne, hvis det aktuelle image mangler.

### 8. Migrering af gateway-tjenester og oprydningshint

Læge registrerer ældre gatewaytjenester (launchd/systemd/schtasks) og
tilbyder at fjerne dem og installere OpenClaw tjenesten ved hjælp af den aktuelle gateway
-port. Det kan også scanne efter ekstra gateway-lignende tjenester og udskrive oprydning hints.
Profile-navngivne OpenClaw gateway tjenester betragtes som førsteklasses og er ikke
markeret som "ekstra".

### 9. Sikkerhedsadvarsler

Doctor udsender advarsler, når en udbyder er åben for DM’er uden en
tilladelsesliste, eller når en politik er konfigureret på en farlig måde.

### 10. systemd linger (Linux)

Hvis der køres som en systemd-brugertjeneste, sikrer doctor, at lingering er
aktiveret, så gatewayen forbliver kørende efter logout.

### 11. Skills-status

Doctor udskriver en hurtig oversigt over egnede/manglende/blokerede Skills for det
aktuelle workspace.

### 12. Gateway-auth-tjek (lokal token)

Læge advarer når `gateway.auth` mangler på en lokal gateway og tilbyder at
generere et token. Brug `openclaw læge --generate-gateway-token` at tvinge token
skabelse i automatisering.

### 13. Gateway-helbredstjek + genstart

Doctor kører et helbredstjek og tilbyder at genstarte gatewayen, når den ser
usund ud.

### 14. Kanalstatusadvarsler

Hvis gatewayen er sund, kører doctor en kanalstatus-probe og rapporterer
advarsler med foreslåede rettelser.

### 15. Revision og reparation af supervisor-konfiguration

Læge kontrollerer den installerede supervisor config (launchd/systemd/schtasks) for
mangler eller forældede standarder (f.eks. systemd network-online afhængigheder og
genstart forsinkelse). Når den finder en fejltagelse, den anbefaler en opdatering og kan
omskrive tjenesten fil / opgave til de aktuelle standardindstillinger.

Noter:

- `openclaw doctor` spørger, før supervisor-konfiguration omskrives.
- `openclaw doctor --yes` accepterer standardreparationsprompts.
- `openclaw doctor --repair` anvender anbefalede rettelser uden prompts.
- `openclaw doctor --repair --force` overskriver brugerdefinerede supervisor-konfigurationer.
- Du kan altid tvinge en fuld omskrivning via `openclaw gateway install --force`.

### 16. Gateway-runtime- og portdiagnostik

Læge inspicerer tjenesten driftstid (PID, sidste exit status) og advarer når
tjenesten er installeret, men faktisk ikke kører. Den kontrollerer også for port kollisioner
på gateway port (standard `18789`) og rapporterer sandsynlige årsager (gateway allerede
kører, SSH tunnel).

### 17. Gateway-runtime best practices

Læge advarer når gateway service kører på Bun eller en version-managed Node path
(`nvm`, `fnm`, `volta`, `asdf`, etc.). WhatsApp + Telegram kanaler kræver Node,
og version-manager stier kan bryde efter opgraderinger, fordi tjenesten ikke
indlæse din shell init. Læge tilbyder at migrere til et system Node installere, når
tilgængelig (Homebrew/apt/choco).

### 18. Skrivning af konfiguration + wizard-metadata

Doctor persisterer eventuelle konfigurationsændringer og stempler
wizard-metadata for at registrere doctor-kørslen.

### 19. Workspace-tips (backup + hukommelsessystem)

Doctor foreslår et workspace-hukommelsessystem, når det mangler, og udskriver et
backup-tip, hvis workspacet ikke allerede er under git.

Se [/concepts/agent-workspace](/concepts/agent-workspace) for en fuld guide til
workspace-struktur og git-backup (anbefalet privat GitHub eller GitLab).
