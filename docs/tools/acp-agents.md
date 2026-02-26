---
summary: "Use ACP runtime sessions for Pi, Claude Code, Codex, OpenCode, Gemini CLI, and other harness agents"
read_when:
  - Running coding harnesses through ACP
  - Setting up thread-bound ACP sessions on thread-capable channels
  - Troubleshooting ACP backend and plugin wiring
title: "ACP Agents"
---

# ACP agents

ACP sessions let OpenClaw run external coding harnesses (for example Pi, Claude Code, Codex, OpenCode, and Gemini CLI) through an ACP backend plugin.

If you ask OpenClaw in plain language to "run this in Codex" or "start Claude Code in a thread", OpenClaw should route that request to the ACP runtime (not the native sub-agent runtime).

## Quick start for humans

Examples of natural requests:

- "Start a persistent Codex session in a thread here and keep it focused."
- "Run this as a one-shot Claude Code ACP session and summarize the result."
- "Use Gemini CLI for this task in a thread, then keep follow-ups in that same thread."

What OpenClaw should do:

1. Pick `runtime: "acp"`.
2. Resolve the requested harness target (`agentId`, for example `codex`).
3. If thread binding is requested and the current channel supports it, bind the ACP session to the thread.
4. Route follow-up thread messages to that same ACP session until unfocused/closed/expired.

## ACP versus sub-agents

Use ACP when you want an external harness runtime. Use sub-agents when you want OpenClaw-native delegated runs.

| Area          | ACP session                           | Sub-agent run                      |
| ------------- | ------------------------------------- | ---------------------------------- |
| Runtime       | ACP backend plugin (for example acpx) | OpenClaw native sub-agent runtime  |
| Session key   | `agent:<agentId>:acp:<uuid>`          | `agent:<agentId>:subagent:<uuid>`  |
| Main commands | `/acp ...`                            | `/subagents ...`                   |
| Spawn tool    | `sessions_spawn` with `runtime:"acp"` | `sessions_spawn` (default runtime) |

See also [Sub-agents](/tools/subagents).

## Thread-bound sessions (channel-agnostic)

When thread bindings are enabled for a channel adapter, ACP sessions can be bound to threads:

- OpenClaw binds a thread to a target ACP session.
- Follow-up messages in that thread route to the bound ACP session.
- ACP output is delivered back to the same thread.
- Unfocus/close/archive/TTL expiry removes the binding.

Thread binding support is adapter-specific. If the active channel adapter does not support thread bindings, OpenClaw returns a clear unsupported/unavailable message.

Required feature flags for thread-bound ACP:

- `acp.enabled=true`
- `acp.dispatch.enabled=true`
- Channel-adapter ACP thread-spawn flag enabled (adapter-specific)
  - Discord: `channels.discord.threadBindings.spawnAcpSessions=true`

### Thread supporting channels

- Any channel adapter that exposes session/thread binding capability.
- Current built-in support: Discord.
- Plugin channels can add support through the same binding interface.

## Start ACP sessions (interfaces)

### From `sessions_spawn`

Use `runtime: "acp"` to start an ACP session from an agent turn or tool call.

```json
{
  "task": "Open the repo and summarize failing tests",
  "runtime": "acp",
  "agentId": "codex",
  "thread": true,
  "mode": "session"
}
```

Notes:

- `runtime` defaults to `subagent`, so set `runtime: "acp"` explicitly for ACP sessions.
- If `agentId` is omitted, OpenClaw uses `acp.defaultAgent` when configured.
- `mode: "session"` requires `thread: true` to keep a persistent bound conversation.

Interface details:

- `task` (required): initial prompt sent to the ACP session.
- `runtime` (required for ACP): must be `"acp"`.
- `agentId` (optional): ACP target harness id. Falls back to `acp.defaultAgent` if set.
- `thread` (optional, default `false`): request thread binding flow where supported.
- `mode` (optional): `run` (one-shot) or `session` (persistent).
  - default is `run`
  - if `thread: true` and mode omitted, OpenClaw may default to persistent behavior per runtime path
  - `mode: "session"` requires `thread: true`
- `cwd` (optional): requested runtime working directory (validated by backend/runtime policy).
- `label` (optional): operator-facing label used in session/banner text.

### From `/acp` command

Use `/acp spawn` for explicit operator control from chat when needed.

```text
/acp spawn codex --mode persistent --thread auto
/acp spawn codex --mode oneshot --thread off
/acp spawn codex --thread here
```

Key flags:

- `--mode persistent|oneshot`
- `--thread auto|here|off`
- `--cwd <absolute-path>`
- `--label <name>`

See [Slash Commands](/tools/slash-commands).

## ACP controls

Available command family:

- `/acp spawn`
- `/acp cancel`
- `/acp steer`
- `/acp close`
- `/acp status`
- `/acp set-mode`
- `/acp set`
- `/acp cwd`
- `/acp permissions`
- `/acp timeout`
- `/acp model`
- `/acp reset-options`
- `/acp sessions`
- `/acp doctor`
- `/acp install`

`/acp status` shows the effective runtime options and, when available, both runtime-level and backend-level session identifiers.

Some controls depend on backend capabilities. If a backend does not support a control, OpenClaw returns a clear unsupported-control error.

## acpx harness support (current)

Current acpx built-in harness aliases:

- `pi`
- `claude`
- `codex`
- `opencode`
- `gemini`

When OpenClaw uses the acpx backend, prefer these values for `agentId` unless your acpx config defines custom agent aliases.

Direct acpx CLI usage can also target arbitrary adapters via `--agent <command>`, but that raw escape hatch is an acpx CLI feature (not the normal OpenClaw `agentId` path).

## Required config

Core ACP baseline:

```json5
{
  acp: {
    enabled: true,
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: ["pi", "claude", "codex", "opencode", "gemini"],
    maxConcurrentSessions: 8,
    stream: {
      coalesceIdleMs: 300,
      maxChunkChars: 1200,
    },
    runtime: {
      ttlMinutes: 120,
    },
  },
}
```

Thread binding config is channel-adapter specific. Example for Discord:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      ttlHours: 24,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
      },
    },
  },
}
```

If thread-bound ACP spawn does not work, verify the adapter feature flag first:

- Discord: `channels.discord.threadBindings.spawnAcpSessions=true`

See [Configuration Reference](/gateway/configuration-reference).

## Plugin setup for acpx backend

Install and enable plugin:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Local workspace install during development:

```bash
openclaw plugins install ./extensions/acpx
```

Then verify backend health:

```text
/acp doctor
```

### Pinned acpx install strategy (current behavior)

`@openclaw/acpx` now enforces a strict plugin-local pinning model:

1. The extension pins an exact acpx dependency in `extensions/acpx/package.json`.
2. Runtime command is fixed to the plugin-local binary (`extensions/acpx/node_modules/.bin/acpx`), not global `PATH`.
3. Plugin config does not expose `command` or `commandArgs`, so runtime command drift is blocked.
4. Startup registers the ACP backend immediately as not-ready.
5. A background ensure job verifies `acpx --version` against the pinned version.
6. If missing/mismatched, it runs plugin-local install (`npm install --omit=dev --no-save acpx@<pinned>`) and re-verifies before healthy.

Notes:

- OpenClaw startup stays non-blocking while acpx ensure runs.
- If network/install fails, backend remains unavailable and `/acp doctor` reports an actionable fix.

See [Plugins](/tools/plugin).

## Troubleshooting

- Error: `ACP runtime backend is not configured`  
  Install and enable the configured backend plugin, then run `/acp doctor`.

- Error: ACP dispatch disabled  
  Enable `acp.dispatch.enabled=true`.

- Error: target agent not allowed  
  Pass an allowed `agentId` or update `acp.allowedAgents`.

- Error: thread binding unavailable on this channel  
  Use a channel adapter that supports thread bindings, or run ACP in non-thread mode.

- Error: missing ACP metadata for a bound session  
  Recreate the session with `/acp spawn` (or `sessions_spawn` with `runtime:"acp"`) and rebind the thread.
