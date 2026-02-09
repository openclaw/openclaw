---
summary: "Dokumentacja referencyjna CLI dla `openclaw hooks` (hooki agenta)"
read_when:
  - Chcesz zarządzać hookami agenta
  - Chcesz instalować lub aktualizować hooki
title: "hooks"
---

# `openclaw hooks`

Zarządzanie hookami agenta (automatyzacjami sterowanymi zdarzeniami dla poleceń takich jak `/new`, `/reset` oraz uruchamianie gateway).

Powiązane:

- Hooki: [Hooks](/automation/hooks)
- Hooki wtyczek: [Plugins](/tools/plugin#plugin-hooks)

## Lista wszystkich hooków

```bash
openclaw hooks list
```

Wyświetla listę wszystkich wykrytych hooków z katalogów roboczych, zarządzanych oraz dołączonych.

**Opcje:**

- `--eligible`: Pokaż tylko kwalifikujące się hooki (spełnione wymagania)
- `--json`: Wyjście w formacie JSON
- `-v, --verbose`: Pokaż szczegółowe informacje, w tym brakujące wymagania

**Przykładowe wyjście:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**Przykład (szczegółowy):**

```bash
openclaw hooks list --verbose
```

Pokazuje brakujące wymagania dla niekwalifikujących się hooków.

**Przykład (JSON):**

```bash
openclaw hooks list --json
```

Zwraca ustrukturyzowany JSON do użycia programistycznego.

## Pobierz informacje o hooku

```bash
openclaw hooks info <name>
```

Wyświetla szczegółowe informacje o konkretnym hooku.

**Argumenty:**

- `<name>`: Nazwa hooka (np. `session-memory`)

**Opcje:**

- `--json`: Wyjście w formacie JSON

**Przykład:**

```bash
openclaw hooks info session-memory
```

**Wyjście:**

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

## Sprawdź kwalifikowalność hooków

```bash
openclaw hooks check
```

Wyświetla podsumowanie statusu kwalifikowalności hooków (ile jest gotowych vs. niegotowych).

**Opcje:**

- `--json`: Wyjście w formacie JSON

**Przykładowe wyjście:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Włącz hook

```bash
openclaw hooks enable <name>
```

Włącza określony hook, dodając go do konfiguracji (`~/.openclaw/config.json`).

**Uwaga:** Hooki zarządzane przez wtyczki pokazują `plugin:<id>` w `openclaw hooks list` i
nie można ich włączać/wyłączać w tym miejscu. Zamiast tego włącz/wyłącz wtyczkę.

**Argumenty:**

- `<name>`: Nazwa hooka (np. `session-memory`)

**Przykład:**

```bash
openclaw hooks enable session-memory
```

**Wyjście:**

```
✓ Enabled hook: 💾 session-memory
```

**Co robi:**

- Sprawdza, czy hook istnieje i czy jest kwalifikowalny
- Aktualizuje `hooks.internal.entries.<name>.enabled = true` w konfiguracji
- Zapisuje konfigurację na dysku

**Po włączeniu:**

- Uruchom ponownie gateway, aby hooki zostały przeładowane (restart aplikacji paska menu na macOS lub restart procesu gateway w trybie deweloperskim).

## Wyłącz hook

```bash
openclaw hooks disable <name>
```

Wyłącza określony hook poprzez aktualizację konfiguracji.

**Argumenty:**

- `<name>`: Nazwa hooka (np. `command-logger`)

**Przykład:**

```bash
openclaw hooks disable command-logger
```

**Wyjście:**

```
⏸ Disabled hook: 📝 command-logger
```

**Po wyłączeniu:**

- Uruchom ponownie gateway, aby hooki zostały przeładowane

## Zainstaluj hooki

```bash
openclaw hooks install <path-or-spec>
```

Instaluje pakiet hooków z lokalnego folderu/archiwum lub z npm.

**Co robi:**

- Kopiuje pakiet hooków do `~/.openclaw/hooks/<id>`
- Włącza zainstalowane hooki w `hooks.internal.entries.*`
- Rejestruje instalację w `hooks.internal.installs`

**Opcje:**

- `-l, --link`: Podlinkuj lokalny katalog zamiast kopiowania (dodaje go do `hooks.internal.load.extraDirs`)

**Obsługiwane archiwa:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Przykłady:**

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

## Aktualizuj hooki

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Aktualizuje zainstalowane pakiety hooków (tylko instalacje z npm).

**Opcje:**

- `--all`: Zaktualizuj wszystkie śledzone pakiety hooków
- `--dry-run`: Pokaż, co by się zmieniło, bez zapisu

## Dołączone hooki

### session-memory

Zapisuje kontekst sesji do pamięci, gdy wydasz `/new`.

**Włącz:**

```bash
openclaw hooks enable session-memory
```

**Wyjście:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Zobacz:** [dokumentacja session-memory](/automation/hooks#session-memory)

### command-logger

Rejestruje wszystkie zdarzenia poleceń do scentralizowanego pliku audytu.

**Włącz:**

```bash
openclaw hooks enable command-logger
```

**Wyjście:** `~/.openclaw/logs/commands.log`

**Wyświetl logi:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Zobacz:** [dokumentacja command-logger](/automation/hooks#command-logger)

### soul-evil

Zamienia wstrzykniętą treść `SOUL.md` na `SOUL_EVIL.md` podczas okna czyszczenia lub losowo.

**Włącz:**

```bash
openclaw hooks enable soul-evil
```

**Zobacz:** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

Uruchamia `BOOT.md`, gdy gateway startuje (po uruchomieniu kanałów).

**Zdarzenia**: `gateway:startup`

**Włącz**:

```bash
openclaw hooks enable boot-md
```

**Zobacz:** [dokumentacja boot-md](/automation/hooks#boot-md)
