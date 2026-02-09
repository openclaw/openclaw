---
summary: "CLI-reference for `openclaw hooks` (agent-hooks)"
read_when:
  - Du vil administrere agent-hooks
  - Du vil installere eller opdatere hooks
title: "hooks"
---

# `openclaw hooks`

Administrér agent-hooks (hændelsesdrevne automatiseringer for kommandoer som `/new`, `/reset` og gateway-opstart).

Relateret:

- Hooks: [Hooks](/automation/hooks)
- Plugin-hooks: [Plugins](/tools/plugin#plugin-hooks)

## Vis alle hooks

```bash
openclaw hooks list
```

Viser alle fundne hooks fra workspace-, managed- og bundled-mapper.

**Indstillinger:**

- `--eligible`: Vis kun kvalificerede hooks (krav opfyldt)
- `--json`: Output som JSON
- `-v, --verbose`: Vis detaljerede oplysninger, herunder manglende krav

**Eksempel på output:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**Eksempel (udvidet):**

```bash
openclaw hooks list --verbose
```

Viser manglende krav for ikke‑kvalificerede hooks.

**Eksempel (JSON):**

```bash
openclaw hooks list --json
```

Returnerer struktureret JSON til programmatisk brug.

## Hent hook-oplysninger

```bash
openclaw hooks info <name>
```

Viser detaljerede oplysninger om et specifikt hook.

**Argumenter:**

- `<name>`: Hook name (fx, `session-memory`)

**Indstillinger:**

- `--json`: Output som JSON

**Eksempel:**

```bash
openclaw hooks info session-memory
```

**Output:**

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

## Tjek hooks’ kvalificering

```bash
openclaw hooks check
```

Viser en oversigt over hook-kvalificeringsstatus (hvor mange er klar vs. ikke klar).

**Indstillinger:**

- `--json`: Output som JSON

**Eksempel på output:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Aktivér et hook

```bash
openclaw hooks enable <name>
```

Aktivér et specifikt hook ved at tilføje det til din konfiguration (`~/.openclaw/config.json`).

**Bemærk:** Kroge håndteret af plugins vis `plugin:<id>` i `openclaw hooks list` og
kan ikke aktiveres / deaktiveres her. Aktiver/deaktiver i stedet plugin'et.

**Argumenter:**

- `<name>`: Hook name (fx, `session-memory`)

**Eksempel:**

```bash
openclaw hooks enable session-memory
```

**Output:**

```
✓ Enabled hook: 💾 session-memory
```

**Hvad den gør:**

- Tjekker om hook’et findes og er kvalificeret
- Opdaterer `hooks.internal.entries.<name>.enabled = sand` i din config
- Gemmer konfigurationen på disk

**Efter aktivering:**

- Genstart gateway’en, så hooks genindlæses (genstart menulinje-appen på macOS, eller genstart din gateway-proces i dev).

## Deaktivér et hook

```bash
openclaw hooks disable <name>
```

Deaktivér et specifikt hook ved at opdatere din konfiguration.

**Argumenter:**

- `<name>`: Hook name (fx, `kommando-logger`)

**Eksempel:**

```bash
openclaw hooks disable command-logger
```

**Output:**

```
⏸ Disabled hook: 📝 command-logger
```

**Efter deaktivering:**

- Genstart gateway’en, så hooks genindlæses

## Installér hooks

```bash
openclaw hooks install <path-or-spec>
```

Installér en hook-pakke fra en lokal mappe/arkiv eller npm.

**Hvad den gør:**

- Kopierer hook-pakken til `~/.openclaw/hooks/<id>`
- Aktiverer de installerede hooks i `hooks.internal.entries.*`
- Registrerer installationen under `hooks.internal.installs`

**Indstillinger:**

- `-l, --link`: Knyt en lokal mappe i stedet for at kopiere (tilføjer den til `hooks.internal.load.extraDirs`)

**Understøttede arkiver:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Eksempler:**

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

## Opdatér hooks

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Opdatér installerede hook-pakker (kun npm-installationer).

**Indstillinger:**

- `--all`: Opdatér alle sporede hook-pakker
- `--dry-run`: Vis hvad der ville ændre sig uden at skrive

## Bundled hooks

### session-memory

Gemmer sessionskontekst i hukommelsen, når du udsteder `/new`.

**Aktivér:**

```bash
openclaw hooks enable session-memory
```

**Output:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Se:** [session-memory dokumentation](/automation/hooks#session-memory)

### command-logger

Logger alle kommandohændelser til en centraliseret revisionsfil.

**Aktivér:**

```bash
openclaw hooks enable command-logger
```

**Output:** `~/.openclaw/logs/commands.log`

**Se logs:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Se:** [command-logger dokumentation](/automation/hooks#command-logger)

### soul-evil

Udskifter indsprøjtet `SOUL.md`-indhold med `SOUL_EVIL.md` under et purge-vindue eller ved tilfældig chance.

**Aktivér:**

```bash
openclaw hooks enable soul-evil
```

**Se:** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

Kører `BOOT.md`, når gateway’en starter (efter kanaler starter).

**Hændelser**: `gateway:startup`

**Aktivér**:

```bash
openclaw hooks enable boot-md
```

**Se:** [boot-md dokumentation](/automation/hooks#boot-md)
