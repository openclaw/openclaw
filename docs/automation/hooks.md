---
summary: "Hooks: event-driven automation for commands and lifecycle events"
read_when:
  - You want event-driven automation for /new, /reset, /stop, and agent lifecycle events
  - You want to build, install, or debug hooks
title: "Hooks"
---

Hooks are small scripts that run when something happens inside the Gateway. They can be discovered from directories and inspected with `openclaw hooks`. The Gateway loads internal hooks only after you enable hooks or configure at least one hook entry, hook pack, legacy handler, or extra hook directory.

There are two kinds of hooks in OpenClaw:

- **Internal hooks** (this page): run inside the Gateway when agent events fire, like `/new`, `/reset`, `/stop`, or lifecycle events.
- **Webhooks**: external HTTP endpoints that let other systems trigger work in OpenClaw. See [Webhooks](/automation/cron-jobs#webhooks).

Hooks can also be bundled inside plugins. `openclaw hooks list` shows both standalone hooks and plugin-managed hooks.

## Quick start

```bash
# List available hooks
openclaw hooks list

# Enable a hook
openclaw hooks enable session-memory

# Check hook status
openclaw hooks check

# Get detailed information
openclaw hooks info session-memory
```

## Event types

| Event                    | When it fires                                              |
| ------------------------ | ---------------------------------------------------------- |
| `command:new`            | `/new` command issued                                      |
| `command:reset`          | `/reset` command issued                                    |
| `command:stop`           | `/stop` command issued                                     |
| `command`                | Any command event (general listener)                       |
| `session:compact:before` | Before compaction summarizes history                       |
| `session:compact:after`  | After compaction completes                                 |
| `session:patch`          | When session properties are modified                       |
| `agent:bootstrap`        | Before workspace bootstrap files are injected              |
| `gateway:startup`        | After channels start and hooks are loaded                  |
| `gateway:shutdown`       | When gateway shutdown begins                               |
| `gateway:pre-restart`    | Before an expected gateway restart                         |
| `message:received`       | Inbound message from any channel                           |
| `message:transcribed`    | After audio transcription completes                        |
| `message:preprocessed`   | After media and link preprocessing completes or is skipped |
| `message:sent`           | Outbound message delivered                                 |

## Writing hooks

### Hook structure

Each hook is a directory containing two files:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

### HOOK.md format

```markdown
---
name: my-hook
description: "Short description of what this hook does"
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Detailed documentation goes here.
```

**Metadata fields** (`metadata.openclaw`):

| Field      | Description                                          |
| ---------- | ---------------------------------------------------- |
| `emoji`    | Display emoji for CLI                                |
| `events`   | Array of events to listen for                        |
| `export`   | Named export to use (defaults to `"default"`)        |
| `os`       | Required platforms (e.g., `["darwin", "linux"]`)     |
| `requires` | Required `bins`, `anyBins`, `env`, or `config` paths |
| `always`   | Bypass eligibility checks (boolean)                  |
| `install`  | Installation methods                                 |

### Handler implementation

```typescript
const handler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  // Your logic here

  // Optionally send message to user
  event.messages.push("Hook executed!");
};

export default handler;
```

Each event includes: `type`, `action`, `sessionKey`, `timestamp`, `messages` (push to send to user), and `context` (event-specific data). Agent and tool plugin hook contexts can also include `trace`, a read-only W3C-compatible diagnostic trace context that plugins may pass into structured logs for OTEL correlation.

### Event context highlights

**Command events** (`command:new`, `command:reset`): `context.sessionEntry`, `context.previousSessionEntry`, `context.commandSource`, `context.workspaceDir`, `context.cfg`.

**Message events** (`message:received`): `context.from`, `context.content`, `context.channelId`, `context.metadata` (provider-specific data including `senderId`, `senderName`, `guildId`).

**Message events** (`message:sent`): `context.to`, `context.content`, `context.success`, `context.channelId`.

**Message events** (`message:transcribed`): `context.transcript`, `context.from`, `context.channelId`, `context.mediaPath`.

**Message events** (`message:preprocessed`): `context.bodyForAgent` (final enriched body), `context.from`, `context.channelId`.

**Bootstrap events** (`agent:bootstrap`): `context.bootstrapFiles` (mutable array), `context.agentId`.

**Session patch events** (`session:patch`): `context.sessionEntry`, `context.patch` (only changed fields), `context.cfg`. Only privileged clients can trigger patch events.

**Compaction events**: `session:compact:before` includes `messageCount`, `tokenCount`. `session:compact:after` adds `compactedCount`, `summaryLength`, `tokensBefore`, `tokensAfter`.

`command:stop` observes the user issuing `/stop`; it is cancellation/command
lifecycle, not an agent-finalization gate. Plugins that need to inspect a
natural final answer and ask the agent for one more pass should use the typed
plugin hook `before_agent_finalize` instead. See [Plugin hooks](/plugins/hooks).

**Gateway lifecycle events**: `gateway:shutdown` includes `reason` and `restartExpectedMs` and fires when gateway shutdown begins. `gateway:pre-restart` includes the same context but only fires when shutdown is part of an expected restart and a finite `restartExpectedMs` value is supplied. During shutdown, each lifecycle hook wait is best-effort and bounded so shutdown continues if a handler stalls.

## Hook discovery

Hooks are discovered from these directories, in order of increasing override precedence:

1. **Bundled hooks**: shipped with OpenClaw
2. **Plugin hooks**: hooks bundled inside installed plugins
3. **Managed hooks**: `~/.openclaw/hooks/` (user-installed, shared across workspaces). Extra directories from `hooks.internal.load.extraDirs` share this precedence.
4. **Workspace hooks**: `<workspace>/hooks/` (per-agent, disabled by default until explicitly enabled)

Workspace hooks can add new hook names but cannot override bundled, managed, or plugin-provided hooks with the same name.

The Gateway skips internal hook discovery on startup until internal hooks are configured. Enable a bundled or managed hook with `openclaw hooks enable <name>`, install a hook pack, or set `hooks.internal.enabled=true` to opt in. When you enable one named hook, the Gateway loads only that hook's handler; `hooks.internal.enabled=true`, extra hook directories, and legacy handlers opt into broad discovery.

### Hook packs

Hook packs are npm packages that export hooks via `openclaw.hooks` in `package.json`. Install with:

```bash
openclaw plugins install <path-or-spec>
```

Npm specs are registry-only (package name + optional exact version or dist-tag). Git/URL/file specs and semver ranges are rejected.

## Bundled hooks

| Hook                  | Events                         | What it does                                          |
| --------------------- | ------------------------------ | ----------------------------------------------------- |
| session-memory        | `command:new`, `command:reset` | Saves session context to `<workspace>/memory/`        |
| bootstrap-extra-files | `agent:bootstrap`              | Injects additional bootstrap files from glob patterns |
| command-logger        | `command`                      | Logs all commands to `~/.openclaw/logs/commands.log`  |
| boot-md               | `gateway:startup`              | Runs `BOOT.md` when the gateway starts                |

Enable any bundled hook:

```bash
openclaw hooks enable <hook-name>
```

<a id="session-memory"></a>

### session-memory details

Extracts the last 15 user/assistant messages, generates a descriptive filename slug via LLM, and saves to `<workspace>/memory/YYYY-MM-DD-slug-xxxxxxxx.md` using the host local date. The trailing `xxxxxxxx` is an 8-hex-char random suffix that guarantees filename uniqueness across concurrent or rapid-fire saves; it eliminates a previous silent-overwrite data-loss path when two sessions produced the same slug on the same day. Requires `workspace.dir` to be configured.

#### Controlling session-memory writes from other hooks

Upstream and downstream hooks can suppress or replace what session-memory writes by setting two fields on `event.context`:

| Field                | Type      | Effect                                                                                                       |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `blockSessionSave`   | `boolean` | When `true`, no memory file is created (or the inline file is retracted via post-hook if blocked late).      |
| `sessionSaveContent` | `string`  | Replaces the file body with custom content. The filename slug is still derived from the original transcript. |

Precedence: `blockSessionSave` always wins over `sessionSaveContent`. When both are set, the file is suppressed entirely.

**Pre-set vs. late-set semantics**

- **Pre-set** (a hook registered _before_ `session-memory` sets the fields): transcript loading and LLM slug generation are skipped entirely — nothing sensitive is read or sent to a model. This is the recommended path for privacy-critical suppression.
- **Late-set** (a hook registered _after_ `session-memory` sets the fields, or sets them via `postHookActions`): `session-memory` has already written the file inline (fail-safe); the post-hook callback then retracts (`blockSessionSave`) or rewrites the body (`sessionSaveContent`). Note: with late-set `sessionSaveContent`, the filename slug derived from the original transcript remains on disk — use `blockSessionSave` instead if the topic itself is sensitive.

**`postHookActions` for ordering-independent behavior**

Hook handlers can append callbacks to `event.postHookActions` (an optional `Array<() => void | Promise<void>>` on `InternalHookEvent`). Every action queued by any handler is drained after all FIFO-ordered handlers have run, so a late-registered hook can make decisions that affect work the bundled handlers performed earlier. The drain is snapshot-before-execute (CWE-834 guard — actions added during drain do not re-trigger), each action is invoked in its own `try/catch`, and errors are routed to `onError` without aborting subsequent actions.

Example (a managed hook that blocks save when the session involved a `secret:` channel):

```ts
export const handler = async (event) => {
  event.postHookActions ??= [];
  event.postHookActions.push(() => {
    if (event.context?.sessionEntry?.channelId?.startsWith("secret:")) {
      event.context.blockSessionSave = true;
    }
  });
};
```

<a id="bootstrap-extra-files"></a>

### bootstrap-extra-files config

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md", "packages/*/TOOLS.md"]
        }
      }
    }
  }
}
```

Paths resolve relative to workspace. Only recognized bootstrap basenames are loaded (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`).

<a id="command-logger"></a>

### command-logger details

Logs every slash command to `~/.openclaw/logs/commands.log`.

<a id="boot-md"></a>

### boot-md details

Runs `BOOT.md` from the active workspace when the gateway starts.

## Plugin hooks

Plugins can register typed hooks through the Plugin SDK for deeper integration:
intercepting tool calls, modifying prompts, controlling message flow, and more.
Use plugin hooks when you need `before_tool_call`, `before_agent_reply`,
`before_install`, or other in-process lifecycle hooks.

For the complete plugin hook reference, see [Plugin hooks](/plugins/hooks).

## Configuration

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

Per-hook environment variables:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": { "MY_CUSTOM_VAR": "value" }
        }
      }
    }
  }
}
```

Extra hook directories:

```json
{
  "hooks": {
    "internal": {
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

<Note>
The legacy `hooks.internal.handlers` array config format is still supported for backwards compatibility, but new hooks should use the discovery-based system.
</Note>

## CLI reference

```bash
# List all hooks (add --eligible, --verbose, or --json)
openclaw hooks list

# Show detailed info about a hook
openclaw hooks info <hook-name>

# Show eligibility summary
openclaw hooks check

# Enable/disable
openclaw hooks enable <hook-name>
openclaw hooks disable <hook-name>
```

## Best practices

- **Keep handlers fast.** Hooks run during command processing. Fire-and-forget heavy work with `void processInBackground(event)`.
- **Handle errors gracefully.** Wrap risky operations in try/catch; do not throw so other handlers can run.
- **Filter events early.** Return immediately if the event type/action is not relevant.
- **Use specific event keys.** Prefer `"events": ["command:new"]` over `"events": ["command"]` to reduce overhead.

## Troubleshooting

### Hook not discovered

```bash
# Verify directory structure
ls -la ~/.openclaw/hooks/my-hook/
# Should show: HOOK.md, handler.ts

# List all discovered hooks
openclaw hooks list
```

### Hook not eligible

```bash
openclaw hooks info my-hook
```

Check for missing binaries (PATH), environment variables, config values, or OS compatibility.

### Hook not executing

1. Verify the hook is enabled: `openclaw hooks list`
2. Restart your gateway process so hooks reload.
3. Check gateway logs: `./scripts/clawlog.sh | grep hook`

## Related

- [CLI Reference: hooks](/cli/hooks)
- [Webhooks](/automation/cron-jobs#webhooks)
- [Plugin hooks](/plugins/hooks) — in-process plugin lifecycle hooks
- [Configuration](/gateway/configuration-reference#hooks)
