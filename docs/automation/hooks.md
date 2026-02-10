---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Hooks: event-driven automation for commands and lifecycle events"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want event-driven automation for /new, /reset, /stop, and agent lifecycle events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to build, install, or debug hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Hooks"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hooks provide an extensible event-driven system for automating actions in response to agent commands and events. Hooks are automatically discovered from directories and can be managed via CLI commands, similar to how skills work in OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Getting Oriented（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hooks are small scripts that run when something happens. There are two kinds:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hooks** (this page): run inside the Gateway when agent events fire, like `/new`, `/reset`, `/stop`, or lifecycle events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Webhooks**: external HTTP webhooks that let other systems trigger work in OpenClaw. See [Webhook Hooks](/automation/webhook) or use `openclaw webhooks` for Gmail helper commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hooks can also be bundled inside plugins; see [Plugins](/tools/plugin#plugin-hooks).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common uses:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Save a memory snapshot when you reset a session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep an audit trail of commands for troubleshooting or compliance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Trigger follow-up automation when a session starts or ends（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Write files into the agent workspace or call external APIs when events fire（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you can write a small TypeScript function, you can write a hook. Hooks are discovered automatically, and you enable or disable them via the CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The hooks system allows you to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Save session context to memory when `/new` is issued（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Log all commands for auditing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Trigger custom automations on agent lifecycle events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Extend OpenClaw's behavior without modifying core code（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Getting Started（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bundled Hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw ships with four bundled hooks that are automatically discovered:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **💾 session-memory**: Saves session context to your agent workspace (default `~/.openclaw/workspace/memory/`) when you issue `/new`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **📝 command-logger**: Logs all command events to `~/.openclaw/logs/commands.log`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **🚀 boot-md**: Runs `BOOT.md` when the gateway starts (requires internal hooks enabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **😈 soul-evil**: Swaps injected `SOUL.md` content with `SOUL_EVIL.md` during a purge window or by random chance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List available hooks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable a hook:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks enable session-memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check hook status:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Get detailed information:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks info session-memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
During onboarding (`openclaw onboard`), you'll be prompted to enable recommended hooks. The wizard automatically discovers eligible hooks and presents them for selection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Hook Discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hooks are automatically discovered from three directories (in order of precedence):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Workspace hooks**: `<workspace>/hooks/` (per-agent, highest precedence)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Managed hooks**: `~/.openclaw/hooks/` (user-installed, shared across workspaces)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Bundled hooks**: `<openclaw>/dist/hooks/bundled/` (shipped with OpenClaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Managed hook directories can be either a **single hook** or a **hook pack** (package directory).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each hook is a directory containing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
my-hook/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── HOOK.md          # Metadata + documentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── handler.ts       # Handler implementation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Hook Packs (npm/archives)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hook packs are standard npm packages that export one or more hooks via `openclaw.hooks` in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`package.json`. Install them with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks install <path-or-spec>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example `package.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "@acme/my-hooks",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "version": "0.1.0",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "openclaw": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each entry points to a hook directory containing `HOOK.md` and `handler.ts` (or `index.ts`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hook packs can ship dependencies; they will be installed under `~/.openclaw/hooks/<id>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Hook Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### HOOK.md Format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `HOOK.md` file contains metadata in YAML frontmatter plus Markdown documentation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: "Short description of what this hook does"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://docs.openclaw.ai/hooks#my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# My Hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Detailed documentation goes here...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What It Does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Listens for `/new` commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Performs some action（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logs the result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node.js must be installed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No configuration needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Metadata Fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `metadata.openclaw` object supports:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`emoji`**: Display emoji for CLI (e.g., `"💾"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`events`**: Array of events to listen for (e.g., `["command:new", "command:reset"]`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`export`**: Named export to use (defaults to `"default"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`homepage`**: Documentation URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`requires`**: Optional requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **`bins`**: Required binaries on PATH (e.g., `["git", "node"]`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **`anyBins`**: At least one of these binaries must be present（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **`env`**: Required environment variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **`config`**: Required config paths (e.g., `["workspace.dir"]`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **`os`**: Required platforms (e.g., `["darwin", "linux"]`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`always`**: Bypass eligibility checks (boolean)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`install`**: Installation methods (for bundled hooks: `[{"id":"bundled","kind":"bundled"}]`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Handler Implementation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `handler.ts` file exports a `HookHandler` function:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import type { HookHandler } from "../../src/hooks/hooks.js";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const myHandler: HookHandler = async (event) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Only trigger on 'new' command（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if (event.type !== "command" || event.action !== "new") {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    return;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  console.log(`[my-hook] New command triggered`);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  console.log(`  Session: ${event.sessionKey}`);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Your custom logic here（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Optionally send message to user（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  event.messages.push("✨ My hook executed!");（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default myHandler;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Event Context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each event includes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  type: 'command' | 'session' | 'agent' | 'gateway',（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  action: string,              // e.g., 'new', 'reset', 'stop'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sessionKey: string,          // Session identifier（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  timestamp: Date,             // When the event occurred（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: string[],          // Push messages here to send to user（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sessionEntry?: SessionEntry,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sessionId?: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sessionFile?: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    senderId?: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    workspaceDir?: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bootstrapFiles?: WorkspaceBootstrapFile[],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    cfg?: OpenClawConfig（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Event Types（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Command Events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Triggered when agent commands are issued:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`command`**: All command events (general listener)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`command:new`**: When `/new` command is issued（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`command:reset`**: When `/reset` command is issued（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`command:stop`**: When `/stop` command is issued（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Agent Events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`agent:bootstrap`**: Before workspace bootstrap files are injected (hooks may mutate `context.bootstrapFiles`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway Events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Triggered when the gateway starts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`gateway:startup`**: After channels start and hooks are loaded（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tool Result Hooks (Plugin API)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These hooks are not event-stream listeners; they let plugins synchronously adjust tool results before OpenClaw persists them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`tool_result_persist`**: transform tool results before they are written to the session transcript. Must be synchronous; return the updated tool result payload or `undefined` to keep it as-is. See [Agent Loop](/concepts/agent-loop).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Future Events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Planned event types:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`session:start`**: When a new session begins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`session:end`**: When a session ends（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`agent:error`**: When an agent encounters an error（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`message:sent`**: When a message is sent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`message:received`**: When a message is received（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Creating Custom Hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1. Choose Location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Workspace hooks** (`<workspace>/hooks/`): Per-agent, highest precedence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Managed hooks** (`~/.openclaw/hooks/`): Shared across workspaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2. Create Directory Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p ~/.openclaw/hooks/my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/.openclaw/hooks/my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3. Create HOOK.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: "Does something useful"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# My Custom Hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This hook does something useful when you issue `/new`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4. Create handler.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import type { HookHandler } from "../../src/hooks/hooks.js";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const handler: HookHandler = async (event) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if (event.type !== "command" || event.action !== "new") {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    return;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  console.log("[my-hook] Running!");（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Your logic here（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default handler;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5. Enable and Test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify hook is discovered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Enable it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks enable my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Trigger the event（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Send /new via your messaging channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### New Config Format (Recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "hooks": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "internal": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "session-memory": { "enabled": true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "command-logger": { "enabled": false }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Per-Hook Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hooks can have custom configuration:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "hooks": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "internal": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "my-hook": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "env": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "MY_CUSTOM_VAR": "value"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Extra Directories（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Load hooks from additional directories:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "hooks": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "internal": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "load": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "extraDirs": ["/path/to/more/hooks"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Legacy Config Format (Still Supported)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The old config format still works for backwards compatibility:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "hooks": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "internal": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "handlers": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "event": "command:new",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "module": "./hooks/handlers/my-handler.ts",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "export": "default"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Migration**: Use the new discovery-based system for new hooks. Legacy handlers are loaded after directory-based hooks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### List Hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# List all hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Show only eligible hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks list --eligible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verbose output (show missing requirements)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks list --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# JSON output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks list --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Hook Information（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Show detailed info about a hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks info session-memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# JSON output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks info session-memory --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Check Eligibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Show eligibility summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# JSON output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks check --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Enable/Disable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Enable a hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks enable session-memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Disable a hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks disable command-logger（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Bundled hook reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### session-memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Saves session context to memory when you issue `/new`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Events**: `command:new`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Requirements**: `workspace.dir` must be configured（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Output**: `<workspace>/memory/YYYY-MM-DD-slug.md` (defaults to `~/.openclaw/workspace`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What it does**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Uses the pre-reset session entry to locate the correct transcript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Extracts the last 15 lines of conversation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Uses LLM to generate a descriptive filename slug（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Saves session metadata to a dated memory file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example output**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Session: 2026-01-16 14:30:00 UTC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session Key**: agent:main:main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Session ID**: abc123def456（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Source**: telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Filename examples**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `2026-01-16-vendor-pitch.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `2026-01-16-api-design.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `2026-01-16-1430.md` (fallback timestamp if slug generation fails)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Enable**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks enable session-memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### command-logger（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Logs all command events to a centralized audit file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Events**: `command`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Requirements**: None（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Output**: `~/.openclaw/logs/commands.log`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What it does**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Captures event details (command action, timestamp, session key, sender ID, source)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Appends to log file in JSONL format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Runs silently in the background（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Example log entries**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**View logs**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# View recent commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tail -n 20 ~/.openclaw/logs/commands.log（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pretty-print with jq（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat ~/.openclaw/logs/commands.log | jq .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Filter by action（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Enable**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks enable command-logger（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### soul-evil（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Swaps injected `SOUL.md` content with `SOUL_EVIL.md` during a purge window or by random chance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Events**: `agent:bootstrap`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Docs**: [SOUL Evil Hook](/hooks/soul-evil)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Output**: No files written; swaps happen in-memory only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Enable**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks enable soul-evil（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Config**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "hooks": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "internal": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "soul-evil": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "file": "SOUL_EVIL.md",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "chance": 0.1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "purge": { "at": "21:00", "duration": "15m" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### boot-md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Runs `BOOT.md` when the gateway starts (after channels start).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Internal hooks must be enabled for this to run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Events**: `gateway:startup`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Requirements**: `workspace.dir` must be configured（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What it does**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Reads `BOOT.md` from your workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Runs the instructions via the agent runner（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Sends any requested outbound messages via the message tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Enable**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks enable boot-md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Best Practices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Keep Handlers Fast（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hooks run during command processing. Keep them lightweight:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// ✓ Good - async work, returns immediately（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const handler: HookHandler = async (event) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  void processInBackground(event); // Fire and forget（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// ✗ Bad - blocks command processing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const handler: HookHandler = async (event) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  await slowDatabaseQuery(event);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  await evenSlowerAPICall(event);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Handle Errors Gracefully（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Always wrap risky operations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const handler: HookHandler = async (event) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  try {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    await riskyOperation(event);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  } catch (err) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // Don't throw - let other handlers run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Filter Events Early（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Return early if the event isn't relevant:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const handler: HookHandler = async (event) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Only handle 'new' commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if (event.type !== "command" || event.action !== "new") {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    return;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Your logic here（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Use Specific Event Keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Specify exact events in metadata when possible:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata: { "openclaw": { "events": ["command:new"] } } # Specific（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Rather than:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debugging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Enable Hook Logging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The gateway logs hook loading at startup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Registered hook: session-memory -> command:new（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Registered hook: command-logger -> command（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Registered hook: boot-md -> gateway:startup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Check Discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List all discovered hooks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks list --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Check Registration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In your handler, log when it's called:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const handler: HookHandler = async (event) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  console.log("[my-handler] Triggered:", event.type, event.action);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Your logic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Verify Eligibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check why a hook isn't eligible:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks info my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for missing requirements in the output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway Logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Monitor gateway logs to see hook execution:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
./scripts/clawlog.sh -f（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Other platforms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tail -f ~/.openclaw/gateway.log（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Test Hooks Directly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Test your handlers in isolation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```typescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import { test } from "vitest";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import { createHookEvent } from "./src/hooks/hooks.js";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import myHandler from "./hooks/my-hook/handler.js";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
test("my handler works", async () => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  const event = createHookEvent("command", "new", "test-session", {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    foo: "bar",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  await myHandler(event);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Assert side effects（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Core Components（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`src/hooks/types.ts`**: Type definitions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`src/hooks/workspace.ts`**: Directory scanning and loading（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`src/hooks/frontmatter.ts`**: HOOK.md metadata parsing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`src/hooks/config.ts`**: Eligibility checking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`src/hooks/hooks-status.ts`**: Status reporting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`src/hooks/loader.ts`**: Dynamic module loader（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`src/cli/hooks-cli.ts`**: CLI commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`src/gateway/server-startup.ts`**: Loads hooks at gateway start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`src/auto-reply/reply/commands-core.ts`**: Triggers command events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Discovery Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway startup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Scan directories (workspace → managed → bundled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Parse HOOK.md files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check eligibility (bins, env, config, os)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Load handlers from eligible hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Register handlers for events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Event Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
User sends /new（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Command validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create hook event（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Trigger hook (all registered handlers)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Command processing continues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ↓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Hook Not Discovered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Check directory structure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ls -la ~/.openclaw/hooks/my-hook/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Should show: HOOK.md, handler.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Verify HOOK.md format:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   cat ~/.openclaw/hooks/my-hook/HOOK.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Should have YAML frontmatter with name and metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. List all discovered hooks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw hooks list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Hook Not Eligible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check requirements:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks info my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for missing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Binaries (check PATH)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Environment variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config values（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OS compatibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Hook Not Executing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Verify hook is enabled:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw hooks list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Should show ✓ next to enabled hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Restart your gateway process so hooks reload.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Check gateway logs for errors:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ./scripts/clawlog.sh | grep hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Handler Errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check for TypeScript/import errors:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Test import directly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node -e "import('./path/to/handler.ts').then(console.log)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Migration Guide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### From Legacy Config to Discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Before**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "hooks": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "internal": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "handlers": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "event": "command:new",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "module": "./hooks/handlers/my-handler.ts"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**After**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create hook directory:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   mkdir -p ~/.openclaw/hooks/my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create HOOK.md:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   name: my-hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   description: "My custom hook"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # My Hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   Does something useful.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Update config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     "hooks": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       "internal": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
           "my-hook": { "enabled": true }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Verify and restart your gateway process:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   openclaw hooks list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Should show: 🎯 my-hook ✓（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Benefits of migration**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Automatic discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Eligibility checking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Better documentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Consistent structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [CLI Reference: hooks](/cli/hooks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Bundled Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Webhook Hooks](/automation/webhook)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Configuration](/gateway/configuration#hooks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
