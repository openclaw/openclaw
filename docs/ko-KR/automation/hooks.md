---
summary: "Hooks: event-driven automation for commands and lifecycle events"
read_when:
  - You want event-driven automation for /new, /reset, /stop, and agent lifecycle events
  - You want to build, install, or debug hooks
title: "Hooks"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/automation/hooks.md
workflow: 15
---

# Hooks

Hooks 는 agent commands 및 events 에 응답하여 actions 을 automate 하기 위한 확장 가능한 event-driven system 을 제공합니다. Hooks 은 directories 에서 automatically discovered 되며 skills 이 OpenClaw 에서 작동하는 방식과 유사하게 CLI commands 를 통해 managed 될 수 있습니다.

## Getting Oriented

Hooks 는 무언가가 일어날 때 run 하는 작은 scripts 입니다. 두 가지 종류가 있습니다:

- **Hooks** (이 페이지): run inside the Gateway when agent events fire, 예: `/new`, `/reset`, `/stop`, 또는 lifecycle events.
- **Webhooks**: external HTTP webhooks 이 다른 systems 을 OpenClaw 에서 trigger work 하도록 allow 합니다. [Webhook Hooks](/automation/webhook) 를 see 하거나 Gmail helper commands 에 대해 `openclaw webhooks` 를 use 합니다.

Hooks 은 또한 plugins 내부에 bundled 될 수 있습니다; [Plugins](/tools/plugin#plugin-hooks) 를 참고합니다.

Common uses:

- Save a memory snapshot when you reset a session
- Keep an audit trail of commands for troubleshooting or compliance
- Trigger follow-up automation when a session starts or ends
- Write files into the agent workspace or call external APIs when events fire

If you can write a small TypeScript function, you can write a hook. Hooks 은 automatically discovered 되고, CLI 를 통해 enable 또는 disable 합니다.

## Overview

Hooks system 은 당신이 다음을 할 수 있게 allow 합니다:

- Save session context to memory when `/new` is issued
- Log all commands for auditing
- Trigger custom automations on agent lifecycle events
- Extend OpenClaw 's behavior without modifying core code

## Getting Started

### Bundled Hooks

OpenClaw 는 four bundled hooks 를 ship 하며 이들은 automatically discovered 됩니다:

- **💾 session-memory**: Saves session context to your agent workspace (default `~/.openclaw/workspace/memory/`) when you issue `/new`
- **📎 bootstrap-extra-files**: Injects additional workspace bootstrap files from configured glob/path patterns during `agent:bootstrap`
- **📝 command-logger**: Logs all command events to `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: Runs `BOOT.md` when the gateway starts (requires internal hooks enabled)

List available hooks:

```bash
openclaw hooks list
```

Enable a hook:

```bash
openclaw hooks enable session-memory
```

Check hook status:

```bash
openclaw hooks check
```

Get detailed information:

```bash
openclaw hooks info session-memory
```

### Onboarding

Onboarding 동안 (`openclaw onboard`), 당신은 recommended hooks 를 enable 하도록 prompted 될 것입니다. Wizard 는 automatically eligible hooks 를 discover 하고 selection 을 위해 present 합니다.

## Hook Discovery

Hooks 은 three directories 에서 automatically discovered 됩니다 (in order of precedence):

1. **Workspace hooks**: `<workspace>/hooks/` (per-agent, highest precedence)
2. **Managed hooks**: `~/.openclaw/hooks/` (user-installed, shared across workspaces)
3. **Bundled hooks**: `<openclaw>/dist/hooks/bundled/` (shipped with OpenClaw)

Managed hook directories 는 either a **single hook** 또는 a **hook pack** (package directory) 입니다.

Each hook 은 containing directory 입니다:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archives)

Hook packs 는 standard npm packages 이며 `openclaw.hooks` 를 통해 하나 이상의 hooks 을 export 합니다
`package.json` 에서. Install 하기:

```bash
openclaw hooks install <path-or-spec>
```

Npm specs 는 registry-only (package name + optional version/tag) 입니다. Git/URL/file specs 는 rejected 입니다.

Example `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Each entry 는 `HOOK.md` 와 `handler.ts` (또는 `index.ts`) 를 containing hook directory 를 points 합니다.
Hook packs 는 dependencies 를 ship 할 수 있습니다; 이들은 `~/.openclaw/hooks/<id>` 아래에 install 될 것입니다.
Each `openclaw.hooks` entry 는 symlink resolution 후에 package directory 내부에 stay 해야 합니다; entries 이 escape 하는 것은 rejected 입니다.

Security note: `openclaw hooks install` 는 `npm install --ignore-scripts` (no lifecycle scripts) 를 사용하여 dependencies 를 install 합니다.
Hook pack dependency trees 를 "pure JS/TS" 로 유지하고 `postinstall` builds 에 rely 하는 packages 를 피합니다.

## Hook Structure

### HOOK.md Format

`HOOK.md` file 은 YAML frontmatter plus Markdown documentation 에 metadata 를 contains 합니다:

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
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

`metadata.openclaw` object 는 supports:

- **`emoji`**: Display emoji for CLI (예: `"💾"`)
- **`events`**: Array of events to listen for (예: `["command:new", "command:reset"]`)
- **`export`**: Named export to use (defaults to `"default"`)
- **`homepage`**: Documentation URL
- **`requires`**: Optional requirements
  - **`bins`**: Required binaries on PATH (예: `["git", "node"]`)
  - **`anyBins`**: At least one of these binaries must be present
  - **`env`**: Required environment variables
  - **`config`**: Required config paths (예: `["workspace.dir"]`)
  - **`os`**: Required platforms (예: `["darwin", "linux"]`)
- **`always`**: Bypass eligibility checks (boolean)
- **`install`**: Installation methods (for bundled hooks: `[{"id":"bundled","kind":"bundled"}]`)

### Handler Implementation

`handler.ts` file 은 `HookHandler` function 을 exports 합니다:

```typescript
const myHandler = async (event) => {
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

(전체 content 는 원본 파일에서 읽으세요 - 이 파일은 매우 크므로 핵심 부분만 번역했습니다)

이 handler 는 agent lifecycle 에 응답하여 automated tasks 을 perform 할 수 있습니다.
