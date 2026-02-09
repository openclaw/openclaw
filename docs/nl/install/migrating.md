---
summary: "Verplaats (migreer) een OpenClaw-installatie van de ene machine naar de andere"
read_when:
  - Je verplaatst OpenClaw naar een nieuwe laptop/server
  - Je wilt sessies, authenticatie en kanaalaanmeldingen (WhatsApp, enz.) behouden
title: "Migratiegids"
---

# OpenClaw migreren naar een nieuwe machine

Deze gids migreert een OpenClaw Gateway van de ene machine naar de andere **zonder onboarding opnieuw te doen**.

De migratie is conceptueel eenvoudig:

- Kopieer de **state directory** (`$OPENCLAW_STATE_DIR`, standaard: `~/.openclaw/`) — dit omvat config, authenticatie, sessies en kanaalstatus.
- Kopieer je **werkruimte** (standaard `~/.openclaw/workspace/`) — dit bevat je agentbestanden (geheugen, prompts, enz.).

Maar er zijn veelvoorkomende valkuilen rond **profielen**, **rechten** en **gedeeltelijke kopieën**.

## Voordat je begint (wat je migreert)

### 1. Identificeer je state directory

De meeste installaties gebruiken de standaard:

- **State dir:** `~/.openclaw/`

Maar deze kan anders zijn als je gebruikt:

- `--profile <name>` (wordt vaak `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Als je het niet zeker weet, voer op de **oude** machine uit:

```bash
openclaw status
```

Zoek in de uitvoer naar vermeldingen van `OPENCLAW_STATE_DIR` / profiel. Als je meerdere gateways draait, herhaal dit voor elk profiel.

### 2. Identificeer je werkruimte

Veelgebruikte standaarden:

- `~/.openclaw/workspace/` (aanbevolen werkruimte)
- een aangepaste map die je hebt aangemaakt

Je werkruimte is waar bestanden zoals `MEMORY.md`, `USER.md` en `memory/*.md` staan.

### 3. Begrijp wat je behoudt

Als je **zowel** de state dir als de werkruimte kopieert, behoud je:

- Gateway-configuratie (`openclaw.json`)
- Auth-profielen / API-sleutels / OAuth-tokens
- Sessiegeschiedenis + agentstatus
- Kanaalstatus (bijv. WhatsApp-aanmelding/sessie)
- Je werkruimtebestanden (geheugen, Skills-notities, enz.)

Als je **alleen** de werkruimte kopieert (bijv. via Git), behoud je **niet**:

- sessies
- inloggegevens
- kanaalaanmeldingen

Die staan onder `$OPENCLAW_STATE_DIR`.

## Migratiestappen (aanbevolen)

### Stap 0 — Maak een back-up (oude machine)

Stop op de **oude** machine eerst de Gateway zodat bestanden niet veranderen tijdens het kopiëren:

```bash
openclaw gateway stop
```

(Optioneel maar aanbevolen) archiveer de state dir en werkruimte:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Als je meerdere profielen/state dirs hebt (bijv. `~/.openclaw-main`, `~/.openclaw-work`), archiveer elk afzonderlijk.

### Stap 1 — Installeer OpenClaw op de nieuwe machine

Installeer op de **nieuwe** machine de CLI (en Node indien nodig):

- Zie: [Install](/install)

In deze fase is het prima als onboarding een nieuwe `~/.openclaw/` aanmaakt — je overschrijft deze in de volgende stap.

### Stap 2 — Kopieer de state dir + werkruimte naar de nieuwe machine

Kopieer **beide**:

- `$OPENCLAW_STATE_DIR` (standaard `~/.openclaw/`)
- je werkruimte (standaard `~/.openclaw/workspace/`)

Gemeenschappelijke benaderingen:

- `scp` de tarballs en uitpakken
- `rsync -a` via SSH
- externe schijf

Zorg na het kopiëren dat:

- Verborgen mappen zijn meegenomen (bijv. `.openclaw/`)
- Bestandsrechten/ownership correct zijn voor de gebruiker die de Gateway draait

### Stap 3 — Run Doctor (migraties + serviceherstel)

Op de **nieuwe** machine:

```bash
openclaw doctor
```

Doctor is het “veilig en saai”-commando. Het herstelt services, past config-migraties toe en waarschuwt voor mismatches.

Daarna:

```bash
openclaw gateway restart
openclaw status
```

## Veelvoorkomende valkuilen (en hoe je ze voorkomt)

### Valkuil: profiel-/state-dir-mismatch

Als je de oude Gateway met een profiel (of `OPENCLAW_STATE_DIR`) draaide en de nieuwe Gateway een ander gebruikt, zie je symptomen zoals:

- configwijzigingen die niet worden toegepast
- kanalen die ontbreken / uitgelogd zijn
- lege sessiegeschiedenis

Oplossing: start de Gateway/service met **hetzelfde** profiel/dezelfde state dir die je hebt gemigreerd en voer daarna opnieuw uit:

```bash
openclaw doctor
```

### Valkuil: alleen `openclaw.json` kopiëren

`openclaw.json` is niet genoeg. Veel providers slaan status op onder:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Migreer altijd de volledige map `$OPENCLAW_STATE_DIR`.

### Valkuil: rechten / ownership

Als je als root hebt gekopieerd of van gebruiker bent veranderd, kan de Gateway geen referenties/sessies lezen.

Oplossing: zorg dat de state dir + werkruimte eigendom zijn van de gebruiker die de Gateway draait.

### Valkuil: migreren tussen remote/lokale modi

- Als je UI (WebUI/TUI) naar een **remote** Gateway wijst, bezit de remote host de sessieopslag + werkruimte.
- Het migreren van je laptop verplaatst de status van de remote Gateway niet.

Als je in remote-modus werkt, migreer de **Gateway-host**.

### Valkuil: geheimen in back-ups

`$OPENCLAW_STATE_DIR` bevat geheimen (API-sleutels, OAuth-tokens, WhatsApp-referenties). Behandel back-ups als productiesecrets:

- versleuteld opslaan
- delen via onveilige kanalen vermijden
- sleutels roteren als je blootstelling vermoedt

## Verificatiechecklist

Controleer op de nieuwe machine:

- `openclaw status` toont dat de Gateway draait
- Je kanalen zijn nog verbonden (bijv. WhatsApp vereist geen her-koppeling)
- Het dashboard opent en toont bestaande sessies
- Je werkruimtebestanden (geheugen, configs) zijn aanwezig

## Gerelateerd

- [Doctor](/gateway/doctor)
- [Gateway-problemen oplossen](/gateway/troubleshooting)
- [Waar slaat OpenClaw zijn data op?](/help/faq#where-does-openclaw-store-its-data)
