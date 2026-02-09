---
summary: "Flyt (migrér) en OpenClaw-installation fra én maskine til en anden"
read_when:
  - Du flytter OpenClaw til en ny bærbar/server
  - Du vil bevare sessioner, autentificering og kanal-logins (WhatsApp m.fl.)
title: "Migreringsguide"
---

# Migrering af OpenClaw til en ny maskine

Denne guide migrerer en OpenClaw Gateway fra én maskine til en anden **uden at gentage introduktionen**.

Migreringen er konceptuelt enkel:

- Kopiér **state-mappen** (`$OPENCLAW_STATE_DIR`, standard: `~/.openclaw/`) — den indeholder konfiguration, autentificering, sessioner og kanaltilstand.
- Kopiér dit **workspace** (`~/.openclaw/workspace/` som standard) — det indeholder dine agentfiler (hukommelse, prompts osv.).

Men der er almindelige faldgruber omkring **profiler**, **tilladelser** og **ufuldstændige kopier**.

## Før du går i gang (hvad du migrerer)

### 1. Identificér din state-mappe

De fleste installationer bruger standarden:

- **State-mappe:** `~/.openclaw/`

Men den kan være anderledes, hvis du bruger:

- `--profile <name>` (bliver ofte til `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Hvis du er i tvivl, så kør på den **gamle** maskine:

```bash
openclaw status
```

Kig efter omtaler af `OPENCLAW_ STATE_ DIR` / profil i output. Hvis du kører flere gateways, gentages for hver profil.

### 2. Identificér dit workspace

Almindelige standarder:

- `~/.openclaw/workspace/` (anbefalet workspace)
- en brugerdefineret mappe, du har oprettet

Dit workspace er der, hvor filer som `MEMORY.md`, `USER.md` og `memory/*.md` ligger.

### 3. Forstå hvad du bevarer

Hvis du kopierer **både** state-mappen og workspace, bevarer du:

- Gateway-konfiguration (`openclaw.json`)
- Autentificeringsprofiler / API-nøgler / OAuth-tokens
- Sessionshistorik + agenttilstand
- Kanaltilstand (fx WhatsApp-login/session)
- Dine workspace-filer (hukommelse, Skills-noter osv.)

Hvis du **kun** kopierer workspace (fx via Git), bevarer du **ikke**:

- sessioner
- legitimationsoplysninger
- kanal-logins

Disse ligger under `$OPENCLAW_STATE_DIR`.

## Migreringstrin (anbefalet)

### Trin 0 — Lav en backup (gammel maskine)

På den **gamle** maskine skal du først stoppe gatewayen, så filer ikke ændrer sig midt i kopieringen:

```bash
openclaw gateway stop
```

(Valgfrit men anbefalet) arkivér state-mappen og workspace:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Hvis du har flere profiler/state-mapper (fx `~/.openclaw-main`, `~/.openclaw-work`), så arkivér hver.

### Trin 1 — Installér OpenClaw på den nye maskine

På den **nye** maskine skal du installere CLI’en (og Node hvis nødvendigt):

- Se: [Install](/install)

På dette tidspunkt er det OK, hvis introduktionen opretter en frisk `~/.openclaw/` — du overskriver den i næste trin.

### Trin 2 — Kopiér state-mappen + workspace til den nye maskine

Kopiér **begge**:

- `$OPENCLAW_STATE_DIR` (standard `~/.openclaw/`)
- dit workspace (standard `~/.openclaw/workspace/`)

Almindelige fremgangsmåder:

- `scp` tarball-arkiverne og udpak
- `rsync -a` over SSH
- ekstern harddisk

Efter kopieringen skal du sikre:

- At skjulte mapper blev inkluderet (fx `.openclaw/`)
- At fil-ejerskab er korrekt for den bruger, der kører gatewayen

### Trin 3 — Kør Doctor (migreringer + servicereparation)

På den **nye** maskine:

```bash
openclaw doctor
```

Læge er den “sikre kedelig” kommando. Det reparerer tjenester, anvender config migrationer, og advarer om uoverensstemmelser.

Derefter:

```bash
openclaw gateway restart
openclaw status
```

## Almindelige faldgruber (og hvordan du undgår dem)

### Faldgrube: profil- / state-mappe-uoverensstemmelse

Hvis du kørte den gamle gateway med en profil (eller `OPENCLAW_STATE_DIR`), og den nye gateway bruger en anden, vil du se symptomer som:

- konfigurationsændringer træder ikke i kraft
- kanaler mangler / er logget ud
- tom sessionshistorik

Løsning: kør gatewayen/servicen med **samme** profil/state-mappe, som du migrerede, og kør derefter igen:

```bash
openclaw doctor
```

### Faldgrube: kun at kopiere `openclaw.json`

`openclaw.json` er ikke nok. Mange udbydere opbevarer stat under:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Migrér altid hele `$OPENCLAW_STATE_DIR`-mappen.

### Faldgrube: tilladelser / ejerskab

Hvis du kopierede som root eller skiftede brugere, kan gatewayen ikke læse legitimationsoplysninger/sessioner.

Løsning: sørg for, at state-mappen + workspace ejes af den bruger, der kører gatewayen.

### Faldgrube: migrering mellem fjern-/lokal-tilstande

- Hvis dit UI (WebUI/TUI) peger på en **fjern** gateway, ejer den fjerne vært sessionslageret + workspace.
- Migrering af din bærbare flytter ikke den fjerne gateways tilstand.

Hvis du er i fjern-tilstand, så migrér **gateway-værten**.

### Faldgrube: hemmeligheder i backups

`$OPENCLAW_STATE_DIR` indeholder hemmeligheder (API-nøgler, OAuth tokens, WhatsApp creds). Behandl sikkerhedskopier som produktionshemmeligheder:

- opbevar krypteret
- undgå deling over usikre kanaler
- roter nøgler, hvis du mistænker eksponering

## Tjekliste til verifikation

På den nye maskine skal du bekræfte:

- `openclaw status` viser, at gatewayen kører
- Dine kanaler er stadig forbundet (fx kræver WhatsApp ikke genparring)
- Dashboardet åbner og viser eksisterende sessioner
- Dine workspace-filer (hukommelse, konfigurationer) er til stede

## Relateret

- [Doctor](/gateway/doctor)
- [Gateway-fejlfinding](/gateway/troubleshooting)
- [Hvor gemmer OpenClaw sine data?](/help/faq#where-does-openclaw-store-its-data)
