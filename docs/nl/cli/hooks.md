---
summary: "CLI-referentie voor `openclaw hooks` (agent hooks)"
read_when:
  - Je wilt agent hooks beheren
  - Je wilt hooks installeren of bijwerken
title: "hooks"
---

# `openclaw hooks`

Beheer agent hooks (eventgestuurde automatiseringen voor opdrachten zoals `/new`, `/reset` en het opstarten van de Gateway).

Gerelateerd:

- Hooks: [Hooks](/automation/hooks)
- Plugin hooks: [Plugins](/tools/plugin#plugin-hooks)

## Alle hooks weergeven

```bash
openclaw hooks list
```

Toon alle ontdekte hooks uit werkruimte-, beheerde en gebundelde mappen.

**Opties:**

- `--eligible`: Toon alleen geschikte hooks (vereisten voldaan)
- `--json`: Uitvoer als JSON
- `-v, --verbose`: Toon gedetailleerde informatie inclusief ontbrekende vereisten

**Voorbeelduitvoer:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**Voorbeeld (uitgebreid):**

```bash
openclaw hooks list --verbose
```

Toont ontbrekende vereisten voor niet-geschikte hooks.

**Voorbeeld (JSON):**

```bash
openclaw hooks list --json
```

Geeft gestructureerde JSON terug voor programmatisch gebruik.

## Hookinformatie ophalen

```bash
openclaw hooks info <name>
```

Toon gedetailleerde informatie over een specifieke hook.

**Argumenten:**

- `<name>`: Hooknaam (bijv. `session-memory`)

**Opties:**

- `--json`: Uitvoer als JSON

**Voorbeeld:**

```bash
openclaw hooks info session-memory
```

**Uitvoer:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## Geschiktheid van hooks controleren

```bash
openclaw hooks check
```

Toon een samenvatting van de geschiktheidsstatus van hooks (hoeveel gereed zijn vs. niet gereed).

**Opties:**

- `--json`: Uitvoer als JSON

**Voorbeelduitvoer:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Een hook inschakelen

```bash
openclaw hooks enable <name>
```

Schakel een specifieke hook in door deze aan je config toe te voegen (`~/.openclaw/config.json`).

**Let op:** Hooks die door plugins worden beheerd tonen `plugin:<id>` in `openclaw hooks list` en
kunnen hier niet worden in- of uitgeschakeld. Schakel in plaats daarvan de plugin in of uit.

**Argumenten:**

- `<name>`: Hooknaam (bijv. `session-memory`)

**Voorbeeld:**

```bash
openclaw hooks enable session-memory
```

**Uitvoer:**

```
✓ Enabled hook: 💾 session-memory
```

**Wat het doet:**

- Controleert of de hook bestaat en geschikt is
- Werkt `hooks.internal.entries.<name>.enabled = true` bij in je config
- Slaat de config op schijf op

**Na inschakelen:**

- Start de Gateway opnieuw zodat hooks opnieuw worden geladen (herstart de menubalk-app op macOS, of herstart je Gateway-proces in dev).

## Een hook uitschakelen

```bash
openclaw hooks disable <name>
```

Schakel een specifieke hook uit door je config bij te werken.

**Argumenten:**

- `<name>`: Hooknaam (bijv. `command-logger`)

**Voorbeeld:**

```bash
openclaw hooks disable command-logger
```

**Uitvoer:**

```
⏸ Disabled hook: 📝 command-logger
```

**Na uitschakelen:**

- Start de Gateway opnieuw zodat hooks opnieuw worden geladen

## Hooks installeren

```bash
openclaw hooks install <path-or-spec>
```

Installeer een hookpack vanuit een lokale map/archief of npm.

**Wat het doet:**

- Kopieert het hookpack naar `~/.openclaw/hooks/<id>`
- Schakelt de geïnstalleerde hooks in `hooks.internal.entries.*` in
- Registreert de installatie onder `hooks.internal.installs`

**Opties:**

- `-l, --link`: Koppel een lokale map in plaats van kopiëren (voegt deze toe aan `hooks.internal.load.extraDirs`)

**Ondersteunde archieven:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Voorbeelden:**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## Hooks bijwerken

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Werk geïnstalleerde hookpacks bij (alleen npm-installaties).

**Opties:**

- `--all`: Werk alle gevolgde hookpacks bij
- `--dry-run`: Toon wat er zou veranderen zonder te schrijven

## Gebundelde hooks

### session-memory

Slaat sessiecontext op in het geheugen wanneer je `/new` uitvoert.

**Inschakelen:**

```bash
openclaw hooks enable session-memory
```

**Uitvoer:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Zie:** [session-memory documentatie](/automation/hooks#session-memory)

### command-logger

Logt alle opdrachtgebeurtenissen naar een gecentraliseerd auditbestand.

**Inschakelen:**

```bash
openclaw hooks enable command-logger
```

**Uitvoer:** `~/.openclaw/logs/commands.log`

**Logboeken bekijken:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Zie:** [command-logger documentatie](/automation/hooks#command-logger)

### soul-evil

Vervangt geïnjecteerde `SOUL.md`-inhoud door `SOUL_EVIL.md` tijdens een purge-venster of willekeurig.

**Inschakelen:**

```bash
openclaw hooks enable soul-evil
```

**Zie:** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

Voert `BOOT.md` uit wanneer de Gateway start (nadat kanalen zijn gestart).

**Events**: `gateway:startup`

**Inschakelen**:

```bash
openclaw hooks enable boot-md
```

**Zie:** [boot-md documentatie](/automation/hooks#boot-md)
