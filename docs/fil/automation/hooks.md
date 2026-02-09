---
summary: "Hooks: event-driven na automation para sa mga command at lifecycle event"
read_when:
  - Gusto mo ng event-driven na automation para sa /new, /reset, /stop, at mga lifecycle event ng agent
  - Gusto mong bumuo, mag-install, o mag-debug ng mga hook
title: "Hooks"
---

# Hooks

Hooks provide an extensible event-driven system for automating actions in response to agent commands and events. Hooks are automatically discovered from directories and can be managed via CLI commands, similar to how skills work in OpenClaw.

## Getting Oriented

Hooks are small scripts that run when something happens. There are two kinds:

- **Hooks** (pahinang ito): tumatakbo sa loob ng Gateway kapag may nag-trigger na agent event, gaya ng `/new`, `/reset`, `/stop`, o mga lifecycle event.
- **Webhooks**: mga external HTTP webhook na nagbibigay-daan sa ibang mga sistema na mag-trigger ng trabaho sa OpenClaw. See [Webhook Hooks](/automation/webhook) or use `openclaw webhooks` for Gmail helper commands.

Maaari ring isama ang Hooks sa loob ng mga plugin; tingnan ang [Plugins](/tools/plugin#plugin-hooks).

Karaniwang gamit:

- Mag-save ng memory snapshot kapag ni-reset mo ang isang session
- Magpanatili ng audit trail ng mga command para sa pag-troubleshoot o compliance
- Mag-trigger ng follow-up na automation kapag nagsimula o nagtapos ang isang session
- Magsulat ng mga file sa agent workspace o tumawag ng mga external API kapag may nag-trigger na event

Kung kaya mong magsulat ng isang maliit na TypeScript function, kaya mo ring magsulat ng hook. Hooks are discovered automatically, and you enable or disable them via the CLI.

## Overview

Pinapahintulutan ka ng hooks system na:

- I-save ang session context sa memory kapag na-issue ang `/new`
- I-log ang lahat ng command para sa auditing
- Mag-trigger ng custom na automation sa mga lifecycle event ng agent
- Palawigin ang behavior ng OpenClaw nang hindi binabago ang core code

## Getting Started

### Bundled Hooks

May kasamang apat na bundled hook ang OpenClaw na awtomatikong nadidiskubre:

- **💾 session-memory**: Nagsa-save ng session context sa agent workspace mo (default `~/.openclaw/workspace/memory/`) kapag nag-issue ka ng `/new`
- **📝 command-logger**: Ini-log ang lahat ng command event sa `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: Pinapatakbo ang `BOOT.md` kapag nagsimula ang gateway (nangangailangan ng internal hooks na naka-enable)
- **😈 soul-evil**: Pinapalitan ang injected na `SOUL.md` content ng `SOUL_EVIL.md` sa panahon ng purge window o batay sa random na tsansa

Ilista ang mga available na hook:

```bash
openclaw hooks list
```

I-enable ang isang hook:

```bash
openclaw hooks enable session-memory
```

Suriin ang status ng hook:

```bash
openclaw hooks check
```

Kumuha ng detalyadong impormasyon:

```bash
openclaw hooks info session-memory
```

### Onboarding

During onboarding (`openclaw onboard`), you'll be prompted to enable recommended hooks. The wizard automatically discovers eligible hooks and presents them for selection.

## Hook Discovery

Awtomatikong nadidiskubre ang Hooks mula sa tatlong directory (ayon sa order ng precedence):

1. **Workspace hooks**: `<workspace>/hooks/` (per-agent, pinakamataas na precedence)
2. **Managed hooks**: `~/.openclaw/hooks/` (user-installed, shared sa lahat ng workspace)
3. **Bundled hooks**: `<openclaw>/dist/hooks/bundled/` (kasama sa OpenClaw)

Ang mga managed hook directory ay maaaring **isang hook** o isang **hook pack** (package directory).

Ang bawat hook ay isang directory na naglalaman ng:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archives)

Hook packs are standard npm packages that export one or more hooks via `openclaw.hooks` in
`package.json`. Install them with:

```bash
openclaw hooks install <path-or-spec>
```

Halimbawang `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Each entry points to a hook directory containing `HOOK.md` and `handler.ts` (or `index.ts`).
Hook packs can ship dependencies; they will be installed under `~/.openclaw/hooks/<id>`.

## Hook Structure

### HOOK.md Format

Ang file na `HOOK.md` ay naglalaman ng metadata sa YAML frontmatter at Markdown documentation:

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

### Metadata Fields

Sinusuportahan ng object na `metadata.openclaw` ang:

- **`emoji`**: Display emoji para sa CLI (hal., `"💾"`)
- **`events`**: Array ng mga event na pakikinggan (hal., `["command:new", "command:reset"]`)
- **`export`**: Named export na gagamitin (default ay `"default"`)
- **`homepage`**: URL ng dokumentasyon
- **`requires`**: Opsyonal na mga requirement
  - **`bins`**: Mga kinakailangang binary sa PATH (hal., `["git", "node"]`)
  - **`anyBins`**: Kahit isa sa mga binary na ito ay dapat naroroon
  - **`env`**: Mga kinakailangang environment variable
  - **`config`**: Mga kinakailangang config path (hal., `["workspace.dir"]`)
  - **`os`**: Mga kinakailangang platform (hal., `["darwin", "linux"]`)
- **`always`**: Laktawan ang eligibility checks (boolean)
- **`install`**: Mga paraan ng pag-install (para sa bundled hooks: `[{"id":"bundled","kind":"bundled"}]`)

### Handler Implementation

Ini-export ng file na `handler.ts` ang isang `HookHandler` function:

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

#### Event Context

Bawat event ay may kasamang:

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

## Event Types

### Command Events

Na-ti-trigger kapag nag-issue ng mga agent command:

- **`command`**: Lahat ng command event (pangkalahatang listener)
- **`command:new`**: Kapag na-issue ang `/new` na command
- **`command:reset`**: Kapag na-issue ang `/reset` na command
- **`command:stop`**: Kapag na-issue ang `/stop` na command

### Agent Events

- **`agent:bootstrap`**: Bago ma-inject ang workspace bootstrap files (maaaring baguhin ng mga hook ang `context.bootstrapFiles`)

### Gateway Events

Na-ti-trigger kapag nagsimula ang gateway:

- **`gateway:startup`**: Pagkatapos magsimula ang mga channel at ma-load ang mga hook

### Tool Result Hooks (Plugin API)

Ang mga hook na ito ay hindi event-stream listener; pinapayagan nilang i-adjust ng mga plugin nang synchronous ang mga tool result bago i-persist ng OpenClaw ang mga ito.

- **`tool_result_persist`**: transform tool results before they are written to the session transcript. Dapat ay synchronous; ibalik ang na-update na tool result payload o `undefined` upang panatilihin ito kung ano ito. See [Agent Loop](/concepts/agent-loop).

### Future Events

Mga planadong uri ng event:

- **`session:start`**: Kapag nagsimula ang bagong session
- **`session:end`**: Kapag nagtapos ang isang session
- **`agent:error`**: Kapag nakaranas ng error ang isang agent
- **`message:sent`**: Kapag may ipinadalang mensahe
- **`message:received`**: Kapag may natanggap na mensahe

## Creating Custom Hooks

### 1. Choose Location

- **Workspace hooks** (`<workspace>/hooks/`): Per-agent, pinakamataas na precedence
- **Managed hooks** (`~/.openclaw/hooks/`): Shared sa lahat ng workspace

### 2. Create Directory Structure

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Gumawa ng HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. Create handler.ts

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

### 5. Enable and Test

```bash
# Verify hook is discovered
openclaw hooks list

# Enable it
openclaw hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## Configuration

### New Config Format (Recommended)

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

### Per-Hook Configuration

Maaaring magkaroon ng custom na configuration ang mga hook:

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

### Extra Directories

Mag-load ng mga hook mula sa karagdagang directory:

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

### Legacy Config Format (Still Supported)

Gumagana pa rin ang lumang config format para sa backwards compatibility:

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

**Migration**: Use the new discovery-based system for new hooks. Legacy handlers are loaded after directory-based hooks.

## CLI Commands

### List Hooks

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

### Hook Information

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### Check Eligibility

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### Enable/Disable

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## Bundled hook reference

### session-memory

Nagsa-save ng session context sa memory kapag nag-issue ka ng `/new`.

**Events**: `command:new`

**Requirements**: Dapat naka-configure ang `workspace.dir`

**Output**: `<workspace>/memory/YYYY-MM-DD-slug.md` (default ay `~/.openclaw/workspace`)

**Ano ang ginagawa nito**:

1. Ginagamit ang pre-reset na session entry para mahanap ang tamang transcript
2. Kinukuha ang huling 15 linya ng pag-uusap
3. Gumagamit ng LLM para bumuo ng deskriptibong filename slug
4. Nagsa-save ng session metadata sa isang dated na memory file

**Halimbawang output**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Mga halimbawa ng filename**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (fallback na timestamp kung pumalya ang slug generation)

**I-enable**:

```bash
openclaw hooks enable session-memory
```

### command-logger

Ini-log ang lahat ng command event sa isang sentralisadong audit file.

**Events**: `command`

**Requirements**: Wala

**Output**: `~/.openclaw/logs/commands.log`

**Ano ang ginagawa nito**:

1. Kinukuha ang mga detalye ng event (command action, timestamp, session key, sender ID, source)
2. Ina-append sa log file sa JSONL format
3. Tahimik na tumatakbo sa background

**Mga halimbawang log entry**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**Tingnan ang mga log**:

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**I-enable**:

```bash
openclaw hooks enable command-logger
```

### soul-evil

Pinapalitan ang injected na `SOUL.md` content ng `SOUL_EVIL.md` sa panahon ng purge window o batay sa random na tsansa.

**Events**: `agent:bootstrap`

**Docs**: [SOUL Evil Hook](/hooks/soul-evil)

**Output**: Walang file na sinusulat; ang mga pagpapalit ay nangyayari lamang in-memory.

**I-enable**:

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

Pinapatakbo ang `BOOT.md` kapag nagsimula ang Gateway (pagkatapos magsimula ang mga channel).
Internal hooks must be enabled for this to run.

**Events**: `gateway:startup`

**Requirements**: Dapat naka-configure ang `workspace.dir`

**Ano ang ginagawa nito**:

1. Binabasa ang `BOOT.md` mula sa iyong workspace
2. Pinapatakbo ang mga tagubilin sa pamamagitan ng agent runner
3. Nagpapadala ng anumang hiniling na outbound message sa pamamagitan ng message tool

**I-enable**:

```bash
openclaw hooks enable boot-md
```

## Best Practices

### Keep Handlers Fast

Hooks run during command processing. Keep them lightweight:

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

### Handle Errors Gracefully

Palaging balutin ang mga mapanganib na operasyon:

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

### Filter Events Early

Mag-return kaagad kung hindi relevant ang event:

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### Use Specific Event Keys

Tukuyin ang eksaktong mga event sa metadata kung maaari:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

Sa halip na:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Debugging

### Enable Hook Logging

Ini-log ng gateway ang pag-load ng hook sa startup:

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Check Discovery

Ilista ang lahat ng nadiskubreng hook:

```bash
openclaw hooks list --verbose
```

### Check Registration

Sa iyong handler, mag-log kapag ito ay tinatawag:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Verify Eligibility

Suriin kung bakit hindi eligible ang isang hook:

```bash
openclaw hooks info my-hook
```

Hanapin ang mga nawawalang requirement sa output.

## Testing

### Gateway Logs

I-monitor ang gateway logs para makita ang pag-execute ng hook:

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Test Hooks Directly

Subukan ang iyong mga handler nang hiwalay:

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

## Architecture

### Core Components

- **`src/hooks/types.ts`**: Mga type definition
- **`src/hooks/workspace.ts`**: Directory scanning at loading
- **`src/hooks/frontmatter.ts`**: Pag-parse ng HOOK.md metadata
- **`src/hooks/config.ts`**: Eligibility checking
- **`src/hooks/hooks-status.ts`**: Status reporting
- **`src/hooks/loader.ts`**: Dynamic module loader
- **`src/cli/hooks-cli.ts`**: Mga CLI command
- **`src/gateway/server-startup.ts`**: Naglo-load ng mga hook sa pagsisimula ng gateway
- **`src/auto-reply/reply/commands-core.ts`**: Nagti-trigger ng mga command event

### Discovery Flow

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

### Event Flow

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

## Troubleshooting

### Hook Not Discovered

1. Suriin ang directory structure:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. I-verify ang HOOK.md format:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. Ilista ang lahat ng nadiskubreng hook:

   ```bash
   openclaw hooks list
   ```

### Hook Not Eligible

Suriin ang mga requirement:

```bash
openclaw hooks info my-hook
```

Hanapin ang mga nawawala:

- Mga binary (suriin ang PATH)
- Mga environment variable
- Mga config value
- OS compatibility

### Hook Not Executing

1. I-verify na naka-enable ang hook:

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. I-restart ang iyong gateway process para muling ma-load ang mga hook.

3. Suriin ang gateway logs para sa mga error:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Handler Errors

Suriin kung may TypeScript/import error:

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Migration Guide

### From Legacy Config to Discovery

**Bago**:

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

**Pagkatapos**:

1. Gumawa ng hook directory:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Gumawa ng HOOK.md:

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. I-update ang config:

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

4. I-verify at i-restart ang iyong gateway process:

   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Mga benepisyo ng migration**:

- Awtomatikong discovery
- Pamamahala sa pamamagitan ng CLI
- Eligibility checking
- Mas mahusay na dokumentasyon
- Pare-parehong istruktura

## See Also

- [CLI Reference: hooks](/cli/hooks)
- [Bundled Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuration](/gateway/configuration#hooks)
