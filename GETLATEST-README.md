# GetLatest OpenClaw Fork

This is GetLatest's fork of [OpenClaw](https://github.com/openclaw/openclaw) with additional plugins for **audit logging**, **response verification**, and **task accountability**.

## Why This Fork?

We built these plugins to solve a real problem: agents sometimes claim they completed work without actually doing it. This fork adds:

1. **Independent audit trail** — Every tool call logged, verifiable
2. **Completion verification** — Claims checked against actual actions before delivery
3. **Task accountability** — Enforces workflows (e.g., GitHub issues) with custom instructions

## Added Plugins

| Plugin                 | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `audit-logger`         | Logs all tool calls to `~/.openclaw/logs/audit.jsonl` |
| `response-verifier`    | Verifies completion claims against audit log          |
| `task-accountability`  | Injects custom instructions + verifies compliance     |
| `instruction-injector` | Generic plugin for custom instruction injection       |

## Core Changes

- Added `before_response` hook — fires before responses are delivered, enables verification

## Quick Start

```bash
# Clone and build
cd ~/dev
git clone https://github.com/get-latest/openclaw.git openclaw-getlatest
cd openclaw-getlatest
npm install
npm run build

# Switch to this version
openclaw gateway stop
npm link
openclaw gateway start

# Verify
openclaw --version  # Should show 2026.2.13+
```

## Enable Plugins

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "audit-logger": { "enabled": true },
      "response-verifier": { "enabled": true },
      "task-accountability": { "enabled": true }
    }
  }
}
```

Then restart: `openclaw gateway restart`

## Custom Instructions

The `task-accountability` plugin looks for custom workflow instructions at:

```
~/.openclaw/protocols/github-workflow.md
```

If this file exists, those instructions are injected into every session. Each bot can have different instructions tailored to their workflow.

Example: require GitHub issues for all work, enforce specific repos/projects, control issue lifecycle.

## Modes

- **Warning mode (default)** — Prepends warnings to responses that fail verification
- **Strict mode** — Blocks responses entirely (`"strictMode": true` in plugin config)

## Rolling Back

If something breaks:

```bash
openclaw gateway stop
npm install -g openclaw@latest
openclaw gateway start
```

Takes ~30 seconds.

## Full Documentation

See the complete usage guide: [openclaw-fork-usage.md](https://github.com/get-latest/company/blob/main/guides/openclaw-fork-usage.md)

## Upstream PR

These changes are submitted upstream: [openclaw/openclaw#16359](https://github.com/openclaw/openclaw/pull/16359)

If merged, you can switch back to stock OpenClaw and keep the plugins.

---

_Fork maintained by GetLatest AI_
