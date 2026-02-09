---
summary: "Sanggunian ng CLI para sa `openclaw hooks` (mga hook ng agent)"
read_when:
  - Gusto mong pamahalaan ang mga hook ng agent
  - Gusto mong mag-install o mag-update ng mga hook
title: "hooks"
---

# `openclaw hooks`

Pamahalaan ang mga hook ng agent (event-driven na automation para sa mga command tulad ng `/new`, `/reset`, at pag-start ng gateway).

Kaugnay:

- Hooks: [Hooks](/automation/hooks)
- Mga hook ng plugin: [Plugins](/tools/plugin#plugin-hooks)

## Ilista ang Lahat ng Hook

```bash
openclaw hooks list
```

Ilista ang lahat ng nadiskubreng hook mula sa workspace, managed, at bundled na mga directory.

**Mga opsyon:**

- `--eligible`: Ipakita lang ang mga eligible na hook (natugunan ang mga kinakailangan)
- `--json`: Output bilang JSON
- `-v, --verbose`: Ipakita ang detalyadong impormasyon kasama ang mga kulang na kinakailangan

**Halimbawang output:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**Halimbawa (verbose):**

```bash
openclaw hooks list --verbose
```

Ipinapakita ang mga kulang na kinakailangan para sa mga hindi eligible na hook.

**Halimbawa (JSON):**

```bash
openclaw hooks list --json
```

Nagbabalik ng structured JSON para sa programmatic na paggamit.

## Kunin ang Impormasyon ng Hook

```bash
openclaw hooks info <name>
```

Ipakita ang detalyadong impormasyon tungkol sa isang partikular na hook.

**Mga argumento:**

- `<name>`: Pangalan ng hook (hal., `session-memory`)

**Mga opsyon:**

- `--json`: Output bilang JSON

**Halimbawa:**

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

## Suriin ang Eligibility ng mga Hook

```bash
openclaw hooks check
```

Ipakita ang buod ng status ng eligibility ng mga hook (ilang handa vs. hindi handa).

**Mga opsyon:**

- `--json`: Output bilang JSON

**Halimbawang output:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## I-enable ang Isang Hook

```bash
openclaw hooks enable <name>
```

I-enable ang isang partikular na hook sa pamamagitan ng pagdaragdag nito sa iyong config (`~/.openclaw/config.json`).

26. **Paalala:** Ang mga hook na pinamamahalaan ng mga plugin ay nagpapakita ng `plugin:<id>` sa `openclaw hooks list` at hindi maaaring i-enable/i-disable dito. 27. Sa halip, i-enable/i-disable ang plugin.

**Mga argumento:**

- `<name>`: Pangalan ng hook (hal., `session-memory`)

**Halimbawa:**

```bash
openclaw hooks enable session-memory
```

**Output:**

```
✓ Enabled hook: 💾 session-memory
```

**Ano ang ginagawa nito:**

- Sinusuri kung umiiral ang hook at kung eligible
- 28. Ina-update ang `hooks.internal.entries.<name>29. .enabled = true` sa iyong config
- Sine-save ang config sa disk

**Pagkatapos i-enable:**

- I-restart ang Gateway para mag-reload ang mga hook (i-restart ang menu bar app sa macOS, o i-restart ang proseso ng Gateway sa dev).

## I-disable ang Isang Hook

```bash
openclaw hooks disable <name>
```

I-disable ang isang partikular na hook sa pamamagitan ng pag-update ng iyong config.

**Mga argumento:**

- `<name>`: Pangalan ng hook (hal., `command-logger`)

**Halimbawa:**

```bash
openclaw hooks disable command-logger
```

**Output:**

```
⏸ Disabled hook: 📝 command-logger
```

**Pagkatapos i-disable:**

- I-restart ang Gateway para mag-reload ang mga hook

## Mag-install ng mga Hook

```bash
openclaw hooks install <path-or-spec>
```

Mag-install ng hook pack mula sa lokal na folder/archive o npm.

**Ano ang ginagawa nito:**

- Kinokopya ang hook pack papunta sa `~/.openclaw/hooks/<id>`
- Ini-enable ang mga na-install na hook sa `hooks.internal.entries.*`
- Itinatala ang pag-install sa ilalim ng `hooks.internal.installs`

**Mga opsyon:**

- `-l, --link`: I-link ang isang lokal na directory sa halip na kopyahin (idinadagdag ito sa `hooks.internal.load.extraDirs`)

**Mga suportadong archive:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Mga halimbawa:**

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

## I-update ang mga Hook

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

I-update ang mga naka-install na hook pack (para sa mga npm install lang).

**Mga opsyon:**

- `--all`: I-update ang lahat ng sinusubaybayang hook pack
- `--dry-run`: Ipakita kung ano ang magbabago nang hindi nagsusulat

## Mga Bundled na Hook

### session-memory

Sine-save ang session context sa memory kapag nag-issue ka ng `/new`.

**I-enable:**

```bash
openclaw hooks enable session-memory
```

**Output:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Tingnan:** [session-memory documentation](/automation/hooks#session-memory)

### command-logger

Nilo-log ang lahat ng command event sa isang sentralisadong audit file.

**I-enable:**

```bash
openclaw hooks enable command-logger
```

**Output:** `~/.openclaw/logs/commands.log`

**Tingnan ang mga log:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Tingnan:** [command-logger documentation](/automation/hooks#command-logger)

### soul-evil

Pinapalitan ang injected na `SOUL.md` na content ng `SOUL_EVIL.md` sa loob ng purge window o sa pamamagitan ng random na tsansa.

**I-enable:**

```bash
openclaw hooks enable soul-evil
```

**Tingnan:** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

Pinapatakbo ang `BOOT.md` kapag nagsimula ang Gateway (pagkatapos magsimula ang mga channel).

**Mga event**: `gateway:startup`

**I-enable**:

```bash
openclaw hooks enable boot-md
```

**Tingnan:** [boot-md documentation](/automation/hooks#boot-md)
