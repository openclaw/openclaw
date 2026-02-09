---
summary: "Hooks: händelsedriven automatisering för kommandon och livscykelhändelser"
read_when:
  - Du vill ha händelsedriven automatisering för /new, /reset, /stop och agentens livscykelhändelser
  - Du vill bygga, installera eller felsöka hooks
title: "Hooks"
---

# Hooks

Hooks ger ett utbyggbart händelsestyrt system för att automatisera åtgärder som svar på agentkommandon och händelser. Hooks upptäcks automatiskt från kataloger och kan hanteras via kommandon CLI, liknande hur färdigheter fungerar i OpenClaw.

## Kom igång

Krokar är små skript som körs när något händer. Det finns två typer:

- **Hooks** (denna sida): körs inuti Gateway när agenthändelser inträffar, som `/new`, `/reset`, `/stop` eller livscykelhändelser.
- **Webhooks**: externa HTTP-webhooks som låter andra system utlösa fungera i OpenClaw. Se [Webhook krokar](/automation/webhook) eller använd `openclaw webhooks` för Gmail hjälparkommandon.

Hooks kan också paketeras inuti plugins; se [Plugins](/tools/plugin#plugin-hooks).

Vanliga användningsområden:

- Spara en minnesögonblicksbild när du återställer en session
- Hålla ett revisionsspår av kommandon för felsökning eller regelefterlevnad
- Trigga uppföljande automatisering när en session startar eller slutar
- Skriva filer till agentens arbetsyta eller anropa externa API:er när händelser inträffar

Om du kan skriva en liten TypeScript funktion kan du skriva en krok. Krokar upptäcks automatiskt, och du aktiverar eller inaktiverar dem via CLI.

## Översikt

Hooks-systemet låter dig:

- Spara sessionskontext till minne när `/new` utfärdas
- Logga alla kommandon för revision
- Trigga anpassade automatiseringar vid agentens livscykelhändelser
- Utöka OpenClaws beteende utan att ändra kärnkod

## Kom igång

### Medföljande hooks

OpenClaw levereras med fyra medföljande hooks som upptäcks automatiskt:

- **💾 session-memory**: Sparar sessionskontext till agentens arbetsyta (standard `~/.openclaw/workspace/memory/`) när du utfärdar `/new`
- **📝 command-logger**: Loggar alla kommandon till `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: Kör `BOOT.md` när gatewayen startar (kräver att interna hooks är aktiverade)
- **😈 soul-evil**: Byter injicerat `SOUL.md`-innehåll mot `SOUL_EVIL.md` under ett rensningsfönster eller av slumpmässig chans

Lista tillgängliga hooks:

```bash
openclaw hooks list
```

Aktivera en hook:

```bash
openclaw hooks enable session-memory
```

Kontrollera hook-status:

```bash
openclaw hooks check
```

Hämta detaljerad information:

```bash
openclaw hooks info session-memory
```

### Introduktion

Under onboarding (`openclaw onboard`), kommer du bli ombedd att aktivera rekommenderade hooks. Guiden upptäcker automatiskt kvalificerade krokar och presenterar dem för urval.

## Hook-upptäckt

Hooks upptäcks automatiskt från tre kataloger (i prioritetsordning):

1. **Arbetsyte-hooks**: `<workspace>/hooks/` (per agent, högsta prioritet)
2. **Hanterade hooks**: `~/.openclaw/hooks/` (användarinstallerade, delas mellan arbetsytor)
3. **Medföljande hooks**: `<openclaw>/dist/hooks/bundled/` (levereras med OpenClaw)

Hanterade hook-kataloger kan vara antingen en **enskild hook** eller ett **hook-paket** (paketkatalog).

Varje hook är en katalog som innehåller:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook-paket (npm/arkiv)

Krokpaket är standard npm paket som exporterar en eller flera krokar via `openclaw.hooks` i
`package.json`. Installera dem med:

```bash
openclaw hooks install <path-or-spec>
```

Exempel på `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Varje post pekar på en krokkatalog som innehåller `HOOK.md` och `handler.ts` (eller `index.ts`).
Krokpaket kan skicka beroenden, de kommer att installeras under `~/.openclaw/hooks/<id>`.

## Hook-struktur

### HOOK.md-format

Filen `HOOK.md` innehåller metadata i YAML-frontmatter plus Markdown-dokumentation:

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

### Metadatafält

Objektet `metadata.openclaw` stöder:

- **`emoji`**: Visa emoji för CLI (t.ex., `"💾"`)
- **`händelser`**: En rad händelser att lyssna på (t.ex., `["kommand:new", "kommando: reset"]`)
- **`export`**: Namngiven export att använda (standard `"default"`)
- **`homepage`**: Dokumentations-URL
- **`requires`**: Valfria krav
  - **`bins`**: Obligatoriska binärer på PATH (t.ex., `["git", "node"]`)
  - **`anyBins`**: Minst en av dessa binärer måste finnas
  - **`env`**: Krävs miljövariabler
  - **`config`**: Obligatoriska konfigurationsvägar (t.ex., `["workspace.dir"]`)
  - **`os`**: Obligatoriska plattformar (t.ex., `["darwin", "linux"]`)
- **`always`**: Förbigå behörighetskontroller (boolean)
- **`install`**: Installationsmetoder (för medföljande hooks: `[{"id":"bundled","kind":"bundled"}]`)

### Handler-implementation

Filen `handler.ts` exporterar en `HookHandler`-funktion:

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

#### Händelsekontext

Varje händelse innehåller:

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

## Händelsetyper

### Kommandohändelser

Triggas när agentkommandon utfärdas:

- **`command`**: Alla kommandohändelser (generell lyssnare)
- **`command:new`**: När kommandot `/new` utfärdas
- **`command:reset`**: När kommandot `/reset` utfärdas
- **`command:stop`**: När kommandot `/stop` utfärdas

### Agenthändelser

- **`agent:bootstrap`**: Innan arbetsytans bootstrap-filer injiceras (hooks kan mutera `context.bootstrapFiles`)

### Gateway-händelser

Triggas när gatewayen startar:

- **`gateway:startup`**: Efter att kanaler startar och hooks har laddats

### Verktygsresultat-hooks (Plugin API)

Dessa hooks är inte händelseströmslyssnare; de låter plugins synkront justera verktygsresultat innan OpenClaw sparar dem.

- **`tool_result_persist`**: transformera verktygsresultat innan de skrivs till sessionsutskriften. Måste vara synkroniserad; returnera det uppdaterade verktygsresultatet nyttolast eller `odefinierad` för att behålla det som -is. Se [Agent Loop](/concepts/agent-loop).

### Framtida händelser

Planerade händelsetyper:

- **`session:start`**: När en ny session börjar
- **`session:end`**: När en session avslutas
- **`agent:error`**: När en agent stöter på ett fel
- **`message:sent`**: När ett meddelande skickas
- **`message:received`**: När ett meddelande tas emot

## Skapa anpassade hooks

### 1. Välj plats

- **Arbetsyte-hooks** (`<workspace>/hooks/`): Per agent, högsta prioritet
- **Hanterade hooks** (`~/.openclaw/hooks/`): Delas mellan arbetsytor

### 2. Skapa katalogstruktur

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Skapa HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. Skapa handler.ts

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

### 5. Aktivera och testa

```bash
# Verify hook is discovered
openclaw hooks list

# Enable it
openclaw hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## Konfiguration

### Nytt konfigformat (rekommenderat)

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

### Per-hook-konfiguration

Hooks kan ha anpassad konfiguration:

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

### Extra kataloger

Ladda hooks från ytterligare kataloger:

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

### Äldre konfigformat (stöds fortfarande)

Det gamla konfigformatet fungerar fortfarande för bakåtkompatibilitet:

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

**Migration**: Använd det nya upptäcktsbaserade systemet för nya krokar. Äldre hanterare laddas efter katalogbaserade krokar.

## CLI-kommandon

### Lista hooks

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

### Hook-information

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### Kontrollera behörighet

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### Aktivera/inaktivera

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## Referens för medföljande hooks

### session-memory

Sparar sessionskontext till minne när du utfärdar `/new`.

**Händelser**: `command:new`

**Krav**: `workspace.dir` måste vara konfigurerad

**Utdata**: `<workspace>/memory/YYYY-MM-DD-slug.md` (standard `~/.openclaw/workspace`)

**Vad den gör**:

1. Använder sessionsposten före återställning för att hitta rätt transkript
2. Extraherar de senaste 15 raderna av konversationen
3. Använder LLM för att generera en beskrivande filnamnsslug
4. Sparar sessionsmetadata till en daterad minnesfil

**Exempelutdata**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Exempel på filnamn**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (reservtidsstämpel om slug-generering misslyckas)

**Aktivera**:

```bash
openclaw hooks enable session-memory
```

### command-logger

Loggar alla kommandohändelser till en centraliserad revisionsfil.

**Händelser**: `command`

**Krav**: Inga

**Utdata**: `~/.openclaw/logs/commands.log`

**Vad den gör**:

1. Fångar händelsedetaljer (kommandoåtgärd, tidsstämpel, sessionsnyckel, avsändar-ID, källa)
2. Lägger till i loggfil i JSONL-format
3. Kör tyst i bakgrunden

**Exempel på loggposter**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**Visa loggar**:

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Aktivera**:

```bash
openclaw hooks enable command-logger
```

### soul-evil

Byter injicerat `SOUL.md`-innehåll mot `SOUL_EVIL.md` under ett rensningsfönster eller av slumpmässig chans.

**Händelser**: `agent:bootstrap`

**Dokumentation**: [SOUL Evil Hook](/hooks/soul-evil)

**Utdata**: Inga filer skrivs; byten sker endast i minnet.

**Aktivera**:

```bash
openclaw hooks enable soul-evil
```

**Konfig**:

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

Kör `BOOT.md` när gateway (nätverksgateway) startar (efter att kanalerna startat).
Interna krokar måste vara aktiverade för att detta ska kunna köras.

**Händelser**: `gateway:startup`

**Krav**: `workspace.dir` måste vara konfigurerad

**Vad den gör**:

1. Läser `BOOT.md` från din arbetsyta
2. Kör instruktionerna via agent-runnern
3. Skickar eventuella begärda utgående meddelanden via meddelandeverktyget

**Aktivera**:

```bash
openclaw hooks enable boot-md
```

## Bästa praxis

### Håll handlers snabba

Krokar körs under kommandobearbetning. Håll dem lätta:

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

### Hantera fel på ett robust sätt

Omslut alltid riskfyllda operationer:

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

### Filtrera händelser tidigt

Returnera tidigt om händelsen inte är relevant:

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### Använd specifika händelsenycklar

Specificera exakta händelser i metadata när det är möjligt:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

I stället för:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Felsökning

### Aktivera hook-loggning

Gatewayen loggar laddning av hooks vid uppstart:

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Kontrollera upptäckt

Lista alla upptäckta hooks:

```bash
openclaw hooks list --verbose
```

### Kontrollera registrering

Logga i din handler när den anropas:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Verifiera behörighet

Kontrollera varför en hook inte är behörig:

```bash
openclaw hooks info my-hook
```

Leta efter saknade krav i utdata.

## Testning

### Gateway-loggar

Övervaka gateway-loggar för att se hook-exekvering:

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Testa hooks direkt

Testa dina handlers isolerat:

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

## Arkitektur

### Kärnkomponenter

- **`src/hooks/types.ts`**: Typdefinitioner
- **`src/hooks/workspace.ts`**: Katalogskanning och laddning
- **`src/hooks/frontmatter.ts`**: Parsning av HOOK.md-metadata
- **`src/hooks/config.ts`**: Behörighetskontroll
- **`src/hooks/hooks-status.ts`**: Statusrapportering
- **`src/hooks/loader.ts`**: Dynamisk modulladdare
- **`src/cli/hooks-cli.ts`**: CLI-kommandon
- **`src/gateway/server-startup.ts`**: Laddar hooks vid gateway-start
- **`src/auto-reply/reply/commands-core.ts`**: Triggar kommandohändelser

### Upptäcktsflöde

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

### Händelseflöde

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

## Felsökning

### Hook upptäcks inte

1. Kontrollera katalogstrukturen:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. Verifiera HOOK.md-format:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. Lista alla upptäckta hooks:

   ```bash
   openclaw hooks list
   ```

### Hook inte behörig

Kontrollera kraven:

```bash
openclaw hooks info my-hook
```

Leta efter saknade:

- Binärer (kontrollera PATH)
- Miljövariabler
- Konfigvärden
- OS-kompatibilitet

### Hook körs inte

1. Verifiera att hooken är aktiverad:

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. Starta om din gateway-process så att hooks laddas om.

3. Kontrollera gateway-loggar efter fel:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Handler-fel

Kontrollera TypeScript-/importfel:

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Migreringsguide

### Från äldre konfig till upptäckt

**Före**:

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

**Efter**:

1. Skapa hook-katalog:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Skapa HOOK.md:

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. Uppdatera konfig:

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

4. Verifiera och starta om din gateway-process:

   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Fördelar med migrering**:

- Automatisk upptäckt
- CLI-hantering
- Behörighetskontroll
- Bättre dokumentation
- Konsekvent struktur

## Se även

- [CLI-referens: hooks](/cli/hooks)
- [README för medföljande hooks](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Konfiguration](/gateway/configuration#hooks)
