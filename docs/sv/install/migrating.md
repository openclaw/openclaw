---
summary: "Flytta (migrera) en OpenClaw-installation från en maskin till en annan"
read_when:
  - Du flyttar OpenClaw till en ny laptop/server
  - Du vill bevara sessioner, autentisering och kanalinloggningar (WhatsApp m.fl.)
title: "Migreringsguide"
---

# Migrera OpenClaw till en ny maskin

Den här guiden migrerar en OpenClaw Gateway från en maskin till en annan **utan att göra om introduktionen**.

Migreringen är enkel i teorin:

- Kopiera **tillståndskatalogen** (`$OPENCLAW_STATE_DIR`, standard: `~/.openclaw/`) — den innehåller konfig, autentisering, sessioner och kanalstatus.
- Kopiera din **workspace** (`~/.openclaw/workspace/` som standard) — den innehåller dina agentfiler (minne, prompter m.m.).

Men det finns vanliga fallgropar kring **profiler**, **behörigheter** och **ofullständiga kopior**.

## Innan du börjar (vad du migrerar)

### 1. Identifiera din tillståndskatalog

De flesta installationer använder standarden:

- **Tillståndskatalog:** `~/.openclaw/`

Men den kan vara annorlunda om du använder:

- `--profile <name>` (blir ofta `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Om du är osäker, kör på den **gamla** maskinen:

```bash
openclaw status
```

Leta efter omnämnanden av `OPENCLAW_STATE_DIR` / profil i utgången. Om du kör flera gateways, upprepa för varje profil.

### 2. Identifiera din workspace

Vanliga standarder:

- `~/.openclaw/workspace/` (rekommenderad workspace)
- en anpassad mapp som du skapade

Din workspace är där filer som `MEMORY.md`, `USER.md` och `memory/*.md` finns.

### 3. Förstå vad du bevarar

Om du kopierar **både** tillståndskatalogen och workspace behåller du:

- Gateway-konfiguration (`openclaw.json`)
- Autentiseringsprofiler / API-nycklar / OAuth-token
- Sessionshistorik + agenttillstånd
- Kanalstatus (t.ex. WhatsApp-inloggning/session)
- Dina workspace-filer (minne, Skills-anteckningar m.m.)

Om du kopierar **endast** workspace (t.ex. via Git) bevarar du **inte**:

- sessioner
- autentiseringsuppgifter
- kanalinloggningar

Dessa finns under `$OPENCLAW_STATE_DIR`.

## Migreringssteg (rekommenderat)

### Steg 0 — Gör en backup (gammal maskin)

På den **gamla** maskinen, stoppa först gatewayn så att filer inte ändras mitt under kopieringen:

```bash
openclaw gateway stop
```

(Valfritt men rekommenderat) arkivera tillståndskatalogen och workspace:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Om du har flera profiler/status dirs (t.ex. `~/.openclaw-main`, `~/.openclaw-work`), arkivera varje.

### Steg 1 — Installera OpenClaw på den nya maskinen

På den **nya** maskinen, installera CLI (och Node vid behov):

- Se: [Install](/install)

I det här skedet är det OK om introduktionen skapar en ny `~/.openclaw/` — du kommer att skriva över den i nästa steg.

### Steg 2 — Kopiera tillståndskatalogen + workspace till den nya maskinen

Kopiera **båda**:

- `$OPENCLAW_STATE_DIR` (standard `~/.openclaw/`)
- din workspace (standard `~/.openclaw/workspace/`)

Vanliga tillvägagångssätt:

- `scp` tar-arkiven och extrahera
- `rsync -a` över SSH
- extern hårddisk

Efter kopieringen, säkerställ att:

- Dolda kataloger inkluderades (t.ex. `.openclaw/`)
- Filägarskap är korrekt för användaren som kör gatewayn

### Steg 3 — Kör Doctor (migreringar + service-reparation)

På den **nya** maskinen:

```bash
openclaw doctor
```

Doktor är det “säkra tråkiga” kommandot. Det reparerar tjänster, tillämpar konfigurationsmigrationer, och varnar för missförhållanden.

Sedan:

```bash
openclaw gateway restart
openclaw status
```

## Vanliga fallgropar (och hur du undviker dem)

### Fallgrop: profil-/tillståndskatalog-mismatch

Om du körde den gamla gatewayn med en profil (eller `OPENCLAW_STATE_DIR`), och den nya gatewayn använder en annan, ser du symptom som:

- konfigändringar som inte får effekt
- kanaler som saknas / är utloggade
- tom sessionshistorik

Lösning: kör gatewayn/tjänsten med **samma** profil/tillståndskatalog som du migrerade, och kör sedan igen:

```bash
openclaw doctor
```

### Fallgrop: att bara kopiera `openclaw.json`

`openclaw.json` är inte tillräckligt. Många leverantörer lagrar staten under:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Migrera alltid hela mappen `$OPENCLAW_STATE_DIR`.

### Fallgrop: behörigheter / ägarskap

Om du kopierade som root eller bytte användare kan gatewayn misslyckas med att läsa autentiseringsuppgifter/sessioner.

Lösning: säkerställ att tillståndskatalogen + workspace ägs av användaren som kör gatewayn.

### Fallgrop: migrering mellan fjärr-/lokala lägen

- Om ditt UI (WebUI/TUI) pekar på en **fjärr**-gateway äger fjärrvärden sessionslagret + workspace.
- Att migrera din laptop flyttar inte fjärr-gatewayns tillstånd.

Om du är i fjärrläge, migrera **gateway-värden**.

### Fallgrop: hemligheter i backuper

`$OPENCLAW_STATE_DIR` innehåller hemligheter (API-nycklar, OAuth tokens, WhatsApp creds). Behandla säkerhetskopior som produktionshemligheter:

- lagra krypterat
- undvik att dela via osäkra kanaler
- rotera nycklar om du misstänker exponering

## Verifieringschecklista

På den nya maskinen, bekräfta:

- `openclaw status` visar att gatewayn kör
- Dina kanaler är fortfarande anslutna (t.ex. WhatsApp kräver inte återkoppling)
- Instrumentpanelen öppnas och visar befintliga sessioner
- Dina workspace-filer (minne, konfiger) finns på plats

## Relaterat

- [Doctor](/gateway/doctor)
- [Gateway felsökning](/gateway/troubleshooting)
- [Var lagrar OpenClaw sina data?](/help/faq#where-does-openclaw-store-its-data)
