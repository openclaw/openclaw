---
summary: "Hooks: event-driven automation for commands and lifecycle events"
read_when:
  - You want event-driven automation for /new, /reset, /stop, and agent lifecycle events
  - You want to build, install, or debug hooks
title: "Hooks"
---

# Hooks

Hooks are small scripts that run when something happens inside the Gateway. They are automatically discovered from directories and can be inspected with `openclaw hooks`.

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

| Event                    | When it fires                                    |
| ------------------------ | ------------------------------------------------ |
| `command:new`            | `/new` command issued                            |
| `command:reset`          | `/reset` command issued                          |
| `command:stop`           | `/stop` command issued                           |
| `command`                | Any command event (general listener)             |
| `session:compact:before` | Before compaction summarizes history             |
| `session:compact:after`  | After compaction completes                       |
| `session:patch`          | When session properties are modified             |
| `agent:bootstrap`        | Before workspace bootstrap files are injected    |
| `gateway:startup`        | After channels start and hooks are loaded        |
| `message:received`       | Inbound message from any channel                 |
| `message:transcribed`    | After audio transcription completes              |
| `message:preprocessed`   | After all media and link understanding completes |
| `message:sent`           | Outbound message delivered                       |

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

Each event includes: `type`, `action`, `sessionKey`, `timestamp`, `messages` (push to send to user), and `context` (event-specific data).

### Event context highlights

**Command events** (`command:new`, `command:reset`): `context.sessionEntry`, `context.previousSessionEntry`, `context.commandSource`, `context.workspaceDir`, `context.cfg`.

**Message events** (`message:received`): `context.from`, `context.content`, `context.channelId`, `context.metadata` (provider-specific data including `senderId`, `senderName`, `guildId`).

**Message events** (`message:sent`): `context.to`, `context.content`, `context.success`, `context.channelId`.

**Message events** (`message:transcribed`): `context.transcript`, `context.from`, `context.channelId`, `context.mediaPath`.

**Message events** (`message:preprocessed`): `context.bodyForAgent` (final enriched body), `context.from`, `context.channelId`.

**Bootstrap events** (`agent:bootstrap`): `context.bootstrapFiles` (mutable array), `context.agentId`.

**Session patch events** (`session:patch`): `context.sessionEntry`, `context.patch` (only changed fields), `context.cfg`. Only privileged clients can trigger patch events.

**Compaction events**: `session:compact:before` includes `messageCount`, `tokenCount`. `session:compact:after` adds `compactedCount`, `summaryLength`, `tokensBefore`, `tokensAfter`.

## Hook discovery

Hooks are discovered from these directories, in order of increasing override precedence:

1. **Bundled hooks**: shipped with OpenClaw
2. **Plugin hooks**: hooks bundled inside installed plugins
3. **Managed hooks**: `~/.openclaw/hooks/` (user-installed, shared across workspaces). Extra directories from `hooks.internal.load.extraDirs` share this precedence.
4. **Workspace hooks**: `<workspace>/hooks/` (per-agent, disabled by default until explicitly enabled)

Workspace hooks can add new hook names but cannot override bundled, managed, or plugin-provided hooks with the same name.

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

### session-memory details

Extracts the last 15 user/assistant messages, generates a descriptive filename slug via LLM, and saves to `<workspace>/memory/YYYY-MM-DD-slug.md`. Requires `workspace.dir` to be configured.

- **`tool_result_persist`**: transform tool results before they are written to the session transcript. Must be synchronous; return the updated tool result payload or `undefined` to keep it as-is. See [Agent Loop](/concepts/agent-loop).

### Plugin Hook Events

#### before_tool_call

Runs before each tool call. Plugins can modify parameters, block the call, or request user approval.

Return fields:

- **`params`**: Override tool parameters (merged with original params)
- **`block`**: Set to `true` to block the tool call
- **`blockReason`**: Reason shown to the agent when blocked
- **`requireApproval`**: Pause execution and wait for user approval via channels

The `requireApproval` field triggers native platform approval (Telegram buttons, Discord components, `/approve` command) instead of relying on the agent to cooperate:

```typescript
{
  requireApproval: {
    title: "Sensitive operation",
    description: "This tool call modifies production data",
    severity: "warning",       // "info" | "warning" | "critical"
    timeoutMs: 120000,         // default: 120s
    timeoutBehavior: "deny",   // "allow" | "deny" (default)
    onResolution: async (decision) => {
      // Called after the user resolves: "allow-once", "allow-always", "deny", "timeout", or "cancelled"
    },
  }
}
```

The `onResolution` callback is invoked with the final decision string after the approval resolves, times out, or is cancelled. It runs in-process within the plugin (not sent to the gateway). Use it to persist decisions, update caches, or perform cleanup.

The `pluginId` field is stamped automatically by the hook runner from the plugin registration. When multiple plugins return `requireApproval`, the first one (highest priority) wins.

`block` takes precedence over `requireApproval`: if the merged hook result has both `block: true` and a `requireApproval` field, the tool call is blocked immediately without triggering the approval flow. This ensures a higher-priority plugin's block cannot be overridden by a lower-priority plugin's approval request.

If the gateway is unavailable or does not support plugin approvals, the tool call falls back to a soft block using the `description` as the block reason.

#### before_install

Runs after the built-in install security scan and before installation continues. OpenClaw fires this hook for interactive skill installs as well as plugin bundle, package, and single-file installs.

Default behavior differs by target type:

- Plugin install/update flows fail closed on built-in scan `critical` findings and scan errors unless the operator explicitly uses `openclaw plugins install --dangerously-force-unsafe-install` or `openclaw plugins update --dangerously-force-unsafe-install`.
- Skill installs still surface built-in scan findings and scan errors as warnings and continue by default.

Return fields:

- **`findings`**: Additional scan findings to surface as warnings
- **`block`**: Set to `true` to block the install
- **`blockReason`**: Human-readable reason shown when blocked

Event fields:

- **`targetType`**: Install target category (`skill` or `plugin`)
- **`targetName`**: Human-readable skill name or plugin id for the install target
- **`sourcePath`**: Absolute path to the install target content being scanned
- **`sourcePathKind`**: Whether the scanned content is a `file` or `directory`
- **`origin`**: Normalized install origin when available (for example `openclaw-bundled`, `openclaw-workspace`, `plugin-bundle`, `plugin-package`, or `plugin-file`)
- **`request`**: Provenance for the install request, including `kind`, `mode`, and optional `requestedSpecifier`
- **`builtinScan`**: Structured result of the built-in scanner, including `status`, summary counts, findings, and optional `error`
- **`skill`**: Skill install metadata when `targetType` is `skill`, including `installId` and the selected `installSpec`
- **`plugin`**: Plugin install metadata when `targetType` is `plugin`, including the canonical `pluginId`, normalized `contentType`, optional `packageName` / `manifestId` / `version`, and `extensions`

Example event (plugin package install):

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

## Plugin hooks

Plugins can register hooks through the Plugin SDK for deeper integration: intercepting tool calls, modifying prompts, controlling message flow, and more. The Plugin SDK exposes 28 hooks covering model resolution, agent lifecycle, message flow, tool execution, subagent coordination, and gateway lifecycle.

For the complete plugin hook reference including `before_tool_call`, `before_agent_reply`, `before_install`, and all other plugin hooks, see [Plugin Architecture](/plugins/architecture#provider-runtime-hooks).

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
- [Plugin Architecture](/plugins/architecture#provider-runtime-hooks) — full plugin hook reference
- [Configuration](/gateway/configuration-reference#hooks)
