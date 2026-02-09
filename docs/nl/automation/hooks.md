---
summary: "Hooks: gebeurtenisgestuurde automatisering voor opdrachten en levenscyclusgebeurtenissen"
read_when:
  - Je wilt gebeurtenisgestuurde automatisering voor /new, /reset, /stop en levenscyclusgebeurtenissen van agents
  - Je wilt hooks bouwen, installeren of debuggen
title: "Hooks"
---

# Hooks

Hooks bieden een uitbreidbaar gebeurtenisgestuurd systeem voor het automatiseren van acties als reactie op agentopdrachten en gebeurtenissen. Hooks worden automatisch ontdekt vanuit mappen en kunnen via CLI-opdrachten worden beheerd, vergelijkbaar met hoe Skills werken in OpenClaw.

## Gearchiveerd krijgen

Hooks zijn kleine scripts die worden uitgevoerd wanneer er iets gebeurt. Er zijn twee soorten:

- **Hooks** (deze pagina): draaien binnen de Gateway wanneer agentgebeurtenissen plaatsvinden, zoals `/new`, `/reset`, `/stop` of levenscyclusgebeurtenissen.
- **Webhooks**: externe HTTP-webhooks waarmee andere systemen werk kunnen triggeren in OpenClaw. Zie [Webhook Hooks](/automation/webhook) of gebruik `openclaw webhooks` voor Gmail-helperopdrachten.

Hooks kunnen ook worden gebundeld in plugins; zie [Plugins](/tools/plugin#plugin-hooks).

Veelvoorkomende toepassingen:

- Een geheugensnapshot opslaan wanneer je een sessie reset
- Een audittrail van opdrachten bijhouden voor probleemoplossing of compliance
- Vervolgautomatisering triggeren wanneer een sessie start of eindigt
- Bestanden schrijven in de agent-werkruimte of externe API’s aanroepen wanneer gebeurtenissen plaatsvinden

Als je een kleine TypeScript-functie kunt schrijven, kun je een hook schrijven. Hooks worden automatisch ontdekt en je schakelt ze in of uit via de CLI.

## Overzicht

Het hooks-systeem stelt je in staat om:

- Sessiecontext op te slaan in het geheugen wanneer `/new` wordt uitgegeven
- Alle opdrachten te loggen voor auditing
- Aangepaste automatiseringen te triggeren bij levenscyclusgebeurtenissen van agents
- Het gedrag van OpenClaw uit te breiden zonder de kerncode te wijzigen

## Aan de slag

### Gebundelde hooks

OpenClaw wordt geleverd met vier gebundelde hooks die automatisch worden ontdekt:

- **💾 session-memory**: Slaat sessiecontext op in je agent-werkruimte (standaard `~/.openclaw/workspace/memory/`) wanneer je `/new` uitvoert
- **📝 command-logger**: Logt alle opdrachtevents naar `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: Voert `BOOT.md` uit wanneer de gateway start (vereist interne hooks ingeschakeld)
- **😈 soul-evil**: Verwisselt geïnjecteerde `SOUL.md`-inhoud met `SOUL_EVIL.md` tijdens een purge-venster of met willekeurige kans

Beschikbare hooks weergeven:

```bash
openclaw hooks list
```

Een hook inschakelen:

```bash
openclaw hooks enable session-memory
```

Hookstatus controleren:

```bash
openclaw hooks check
```

Gedetailleerde informatie ophalen:

```bash
openclaw hooks info session-memory
```

### Onboarding

Tijdens onboarding (`openclaw onboard`) word je gevraagd aanbevolen hooks in te schakelen. De wizard ontdekt automatisch in aanmerking komende hooks en presenteert ze ter selectie.

## Hook-detectie

Hooks worden automatisch ontdekt vanuit drie mappen (in volgorde van prioriteit):

1. **Werkruimte-hooks**: `<workspace>/hooks/` (per agent, hoogste prioriteit)
2. **Beheerde hooks**: `~/.openclaw/hooks/` (door de gebruiker geïnstalleerd, gedeeld over werkruimtes)
3. **Gebundelde hooks**: `<openclaw>/dist/hooks/bundled/` (meegeleverd met OpenClaw)

Beheerde hookmappen kunnen óf een **enkele hook** zijn óf een **hook pack** (pakketmap).

Elke hook is een map die het volgende bevat:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archieven)

Hook packs zijn standaard npm-pakketten die één of meer hooks exporteren via `openclaw.hooks` in
`package.json`. Installeer ze met:

```bash
openclaw hooks install <path-or-spec>
```

Voorbeeld `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Elke entry verwijst naar een hookmap met `HOOK.md` en `handler.ts` (of `index.ts`).
Hook packs kunnen afhankelijkheden meeleveren; deze worden geïnstalleerd onder `~/.openclaw/hooks/<id>`.

## Hookstructuur

### HOOK.md-indeling

Het bestand `HOOK.md` bevat metadata in YAML-frontmatter plus Markdown-documentatie:

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Detailed documentation goes here...

## What It Does

- Listens for `/new` commands
- Performs some action
- Logs the result

## Requirements

- Node.js must be installed

## Configuration

No configuration needed.
```

### Metadatavelden

Het object `metadata.openclaw` ondersteunt:

- **`emoji`**: Weergave-emoji voor de CLI (bijv. `"💾"`)
- **`events`**: Array van gebeurtenissen om naar te luisteren (bijv. `["command:new", "command:reset"]`)
- **`export`**: Benoemde export om te gebruiken (standaard `"default"`)
- **`homepage`**: Documentatie-URL
- **`requires`**: Optionele vereisten
  - **`bins`**: Vereiste binaries op PATH (bijv. `["git", "node"]`)
  - **`anyBins`**: Ten minste één van deze binaries moet aanwezig zijn
  - **`env`**: Vereiste omgevingsvariabelen
  - **`config`**: Vereiste configpaden (bijv. `["workspace.dir"]`)
  - **`os`**: Vereiste platforms (bijv. `["darwin", "linux"]`)
- **`always`**: Geschiktheidscontroles omzeilen (boolean)
- **`install`**: Installatiemethoden (voor gebundelde hooks: `[{"id":"bundled","kind":"bundled"}]`)

### Handler-implementatie

Het bestand `handler.ts` exporteert een functie `HookHandler`:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // Your custom logic here

  // Optionally send message to user
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### Gebeurteniscontext

Elke gebeurtenis bevat:

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // e.g., 'new', 'reset', 'stop'
  sessionKey: string,          // Session identifier
  timestamp: Date,             // When the event occurred
  messages: string[],          // Push messages here to send to user
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## Gebeurtenistypen

### Opdrachtevents

Getriggerd wanneer agentopdrachten worden uitgevoerd:

- **`command`**: Alle opdrachtevents (algemene listener)
- **`command:new`**: Wanneer de opdracht `/new` wordt uitgevoerd
- **`command:reset`**: Wanneer de opdracht `/reset` wordt uitgevoerd
- **`command:stop`**: Wanneer de opdracht `/stop` wordt uitgevoerd

### Agentgebeurtenissen

- **`agent:bootstrap`**: Vóórdat bootstrapbestanden in de werkruimte worden geïnjecteerd (hooks kunnen `context.bootstrapFiles` muteren)

### Gateway-gebeurtenissen

Getriggerd wanneer de gateway start:

- **`gateway:startup`**: Nadat kanalen zijn gestart en hooks zijn geladen

### Toolresultaat-hooks (Plugin-API)

Deze hooks zijn geen event-streamlisteners; ze stellen plugins in staat toolresultaten synchroon aan te passen voordat OpenClaw ze opslaat.

- **`tool_result_persist`**: Transformeert toolresultaten voordat ze naar het sessietranscript worden geschreven. Moet synchroon zijn; retourneer de bijgewerkte toolresultaat-payload of `undefined` om deze ongewijzigd te laten. Zie [Agent Loop](/concepts/agent-loop).

### Toekomstige gebeurtenissen

Geplande gebeurtenistypen:

- **`session:start`**: Wanneer een nieuwe sessie begint
- **`session:end`**: Wanneer een sessie eindigt
- **`agent:error`**: Wanneer een agent een fout tegenkomt
- **`message:sent`**: Wanneer een bericht wordt verzonden
- **`message:received`**: Wanneer een bericht wordt ontvangen

## Aangepaste hooks maken

### 1. Locatie kiezen

- **Werkruimte-hooks** (`<workspace>/hooks/`): Per agent, hoogste prioriteit
- **Beheerde hooks** (`~/.openclaw/hooks/`): Gedeeld over werkruimtes

### 2. Mapstructuur maken

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. HOOK.md maken

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. handler.ts maken

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // Your logic here
};

export default handler;
```

### 5. Inschakelen en testen

```bash
# Verify hook is discovered
openclaw hooks list

# Enable it
openclaw hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## Configuratie

### Nieuw configformaat (aanbevolen)

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### Per-hookconfiguratie

Hooks kunnen een aangepaste configuratie hebben:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### Extra mappen

Laad hooks uit aanvullende mappen:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### Verouderd configformaat (nog ondersteund)

Het oude configformaat werkt nog steeds voor achterwaartse compatibiliteit:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

**Migratie**: Gebruik het nieuwe op detectie gebaseerde systeem voor nieuwe hooks. Verouderde handlers worden geladen na mapgebaseerde hooks.

## CLI-opdrachten

### Hooks weergeven

```bash
# List all hooks
openclaw hooks list

# Show only eligible hooks
openclaw hooks list --eligible

# Verbose output (show missing requirements)
openclaw hooks list --verbose

# JSON output
openclaw hooks list --json
```

### Hookinformatie

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### Geschiktheid controleren

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### In-/uitschakelen

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## Referentie voor gebundelde hooks

### session-memory

Slaat sessiecontext op in het geheugen wanneer je `/new` uitvoert.

**Gebeurtenissen**: `command:new`

**Vereisten**: `workspace.dir` moet zijn geconfigureerd

**Uitvoer**: `<workspace>/memory/YYYY-MM-DD-slug.md` (standaard `~/.openclaw/workspace`)

**Wat het doet**:

1. Gebruikt de pre-reset sessie-entry om het juiste transcript te vinden
2. Extraheert de laatste 15 regels van het gesprek
3. Gebruikt een LLM om een beschrijvende bestandsnaam-slug te genereren
4. Slaat sessiemetadata op in een gedateerd geheugenbestand

**Voorbeelduitvoer**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Voorbeelden van bestandsnamen**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (fallback-tijdstempel als slug-generatie mislukt)

**Inschakelen**:

```bash
openclaw hooks enable session-memory
```

### command-logger

Logt alle opdrachtevents naar een gecentraliseerd auditbestand.

**Gebeurtenissen**: `command`

**Vereisten**: Geen

**Uitvoer**: `~/.openclaw/logs/commands.log`

**Wat het doet**:

1. Legt gebeurtenisdetails vast (opdrachtactie, tijdstempel, sessiesleutel, afzender-ID, bron)
2. Voegt toe aan het logbestand in JSONL-formaat
3. Draait stil op de achtergrond

**Voorbeeldlogregels**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**Logs bekijken**:

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Inschakelen**:

```bash
openclaw hooks enable command-logger
```

### soul-evil

Verwisselt geïnjecteerde `SOUL.md`-inhoud met `SOUL_EVIL.md` tijdens een purge-venster of met willekeurige kans.

**Gebeurtenissen**: `agent:bootstrap`

**Documentatie**: [SOUL Evil Hook](/hooks/soul-evil)

**Uitvoer**: Er worden geen bestanden geschreven; verwisselingen gebeuren alleen in het geheugen.

**Inschakelen**:

```bash
openclaw hooks enable soul-evil
```

**Config**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

### boot-md

Voert `BOOT.md` uit wanneer de gateway start (nadat kanalen zijn gestart).
Interne hooks moeten zijn ingeschakeld om dit te laten werken.

**Gebeurtenissen**: `gateway:startup`

**Vereisten**: `workspace.dir` moet zijn geconfigureerd

**Wat het doet**:

1. Leest `BOOT.md` uit je werkruimte
2. Voert de instructies uit via de agent-runner
3. Verstuurt eventuele gevraagde uitgaande berichten via de message-tool

**Inschakelen**:

```bash
openclaw hooks enable boot-md
```

## Best practices

### Houd handlers snel

Hooks draaien tijdens de verwerking van opdrachten. Houd ze lichtgewicht:

```typescript
// ✓ Good - async work, returns immediately
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Fire and forget
};

// ✗ Bad - blocks command processing
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### Ga netjes om met fouten

Omwikkel risicovolle bewerkingen altijd:

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // Don't throw - let other handlers run
  }
};
```

### Filter gebeurtenissen vroegtijdig

Keer vroegtijdig terug als de gebeurtenis niet relevant is:

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### Gebruik specifieke gebeurtenissleutels

Specificeer waar mogelijk exacte gebeurtenissen in de metadata:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

In plaats van:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Debuggen

### Hook-logging inschakelen

De gateway logt het laden van hooks bij het opstarten:

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Detectie controleren

Alle ontdekte hooks weergeven:

```bash
openclaw hooks list --verbose
```

### Registratie controleren

Log in je handler wanneer deze wordt aangeroepen:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Geschiktheid verifiëren

Controleer waarom een hook niet geschikt is:

```bash
openclaw hooks info my-hook
```

Zoek in de uitvoer naar ontbrekende vereisten.

## Testen

### Gateway-logs

Monitor gateway-logs om de uitvoering van hooks te zien:

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Hooks direct testen

Test je handlers geïsoleerd:

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // Assert side effects
});
```

## Architectuur

### Kerncomponenten

- **`src/hooks/types.ts`**: Typedefinities
- **`src/hooks/workspace.ts`**: Mappen scannen en laden
- **`src/hooks/frontmatter.ts`**: Parsing van HOOK.md-metadata
- **`src/hooks/config.ts`**: Geschiktheidscontrole
- **`src/hooks/hooks-status.ts`**: Statusrapportage
- **`src/hooks/loader.ts`**: Dynamische moduleloader
- **`src/cli/hooks-cli.ts`**: CLI-opdrachten
- **`src/gateway/server-startup.ts`**: Laadt hooks bij het starten van de gateway
- **`src/auto-reply/reply/commands-core.ts`**: Triggert opdrachtevents

### Ontdekking Flow

```
Gateway startup
    ↓
Scan directories (workspace → managed → bundled)
    ↓
Parse HOOK.md files
    ↓
Check eligibility (bins, env, config, os)
    ↓
Load handlers from eligible hooks
    ↓
Register handlers for events
```

### Gebeurtenis flow

```
User sends /new
    ↓
Command validation
    ↓
Create hook event
    ↓
Trigger hook (all registered handlers)
    ↓
Command processing continues
    ↓
Session reset
```

## Problemen oplossen

### Hook niet ontdekt

1. Controleer de mapstructuur:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. Verifieer het HOOK.md-formaat:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. Toon alle ontdekte hooks:

   ```bash
   openclaw hooks list
   ```

### Hook niet geschikt

Controleer vereisten:

```bash
openclaw hooks info my-hook
```

Zoek naar ontbrekende:

- Binaries (controleer PATH)
- Omgevingsvariabelen
- Configwaarden
- OS-compatibiliteit

### Hook wordt niet uitgevoerd

1. Verifieer dat de hook is ingeschakeld:

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. Start je gatewayproces opnieuw zodat hooks opnieuw worden geladen.

3. Controleer gateway-logs op fouten:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Handlerfouten

Controleer op TypeScript-/importfouten:

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Migratiegids

### Van verouderde config naar detectie

**Voor**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**Na**:

1. Maak een hookmap:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Maak HOOK.md:

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. Config bijwerken:

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. Verifieer en start je gatewayproces opnieuw:

   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Voordelen van migratie**:

- Automatische detectie
- CLI-beheer
- Geschiktheidscontrole
- Betere documentatie
- Consistente structuur

## Zie ook

- [CLI Reference: hooks](/cli/hooks)
- [Bundled Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuratie](/gateway/configuration#hooks)
