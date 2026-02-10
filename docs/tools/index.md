---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Agent tool surface for OpenClaw (browser, canvas, nodes, message, cron) replacing legacy `openclaw-*` skills"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying agent tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Retiring or changing `openclaw-*` skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Tools"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Tools (OpenClaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw exposes **first-class agent tools** for browser, canvas, nodes, and cron.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These replace the old `openclaw-*` skills: the tools are typed, no shelling,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and the agent should rely on them directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Disabling tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can globally allow/deny tools via `tools.allow` / `tools.deny` in `openclaw.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(deny wins). This prevents disallowed tools from being sent to model providers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: { deny: ["browser"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Matching is case-insensitive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `*` wildcards are supported (`"*"` means all tools).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `tools.allow` only references unknown or unloaded plugin tool names, OpenClaw logs a warning and ignores the allowlist so core tools stay available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool profiles (base allowlist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.profile` sets a **base tool allowlist** before `tools.allow`/`tools.deny`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent override: `agents.list[].tools.profile`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profiles:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `minimal`: `session_status` only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `full`: no restriction (same as unset)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (messaging-only by default, allow Slack + Discord tools too):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profile: "messaging",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allow: ["slack", "discord"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (coding profile, but deny exec/process everywhere):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profile: "coding",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    deny: ["group:runtime"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (global coding profile, messaging-only support agent):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: { profile: "coding" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "support",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        tools: { profile: "messaging", allow: ["slack"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Provider-specific tool policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `tools.byProvider` to **further restrict** tools for specific providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(or a single `provider/model`) without changing your global defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent override: `agents.list[].tools.byProvider`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is applied **after** the base tool profile and **before** allow/deny lists,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
so it can only narrow the tool set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider keys accept either `provider` (e.g. `google-antigravity`) or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`provider/model` (e.g. `openai/gpt-5.2`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (keep global coding profile, but minimal tools for Google Antigravity):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profile: "coding",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    byProvider: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "google-antigravity": { profile: "minimal" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (provider/model-specific allowlist for a flaky endpoint):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allow: ["group:fs", "group:runtime", "sessions_list"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    byProvider: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (agent-specific override for a single provider):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "support",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          byProvider: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "google-antigravity": { allow: ["message", "sessions_list"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool groups (shorthands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool policies (global, agent, sandbox) support `group:*` entries that expand to multiple tools.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use these in `tools.allow` / `tools.deny`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Available groups:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:runtime`: `exec`, `bash`, `process`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:fs`: `read`, `write`, `edit`, `apply_patch`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:memory`: `memory_search`, `memory_get`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:web`: `web_search`, `web_fetch`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:ui`: `browser`, `canvas`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:automation`: `cron`, `gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:messaging`: `message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:nodes`: `nodes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:openclaw`: all built-in OpenClaw tools (excludes provider plugins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (allow only file tools + browser):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allow: ["group:fs", "browser"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugins + tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can register **additional tools** (and CLI commands) beyond the core set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Plugins](/tools/plugin) for install + config, and [Skills](/tools/skills) for how（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tool usage guidance is injected into prompts. Some plugins ship their own skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
alongside tools (for example, the voice-call plugin).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional plugin tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Lobster](/tools/lobster): typed workflow runtime with resumable approvals (requires the Lobster CLI on the gateway host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [LLM Task](/tools/llm-task): JSON-only LLM step for structured workflow output (optional schema validation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool inventory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `apply_patch`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Apply structured patches across one or more files. Use for multi-hunk edits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Experimental: enable via `tools.exec.applyPatch.enabled` (OpenAI models only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `exec`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run shell commands in the workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `command` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `yieldMs` (auto-background after timeout, default 10000)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `background` (immediate background)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeout` (seconds; kills the process if exceeded, default 1800)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevated` (bool; run on host if elevated mode is enabled/allowed; only changes behavior when the agent is sandboxed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `host` (`sandbox | gateway | node`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `security` (`deny | allowlist | full`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ask` (`off | on-miss | always`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node` (node id/name for `host=node`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Need a real TTY? Set `pty: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Returns `status: "running"` with a `sessionId` when backgrounded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `process` to poll/log/write/kill/clear background sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `process` is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevated` is gated by `tools.elevated` plus any `agents.list[].tools.elevated` override (both must allow) and is an alias for `host=gateway` + `security=full`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevated` only changes behavior when the agent is sandboxed (otherwise it’s a no-op).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `host=node` can target a macOS companion app or a headless node host (`openclaw node run`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- gateway/node approvals and allowlists: [Exec approvals](/tools/exec-approvals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `process`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage background exec sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `poll` returns new output and exit status when complete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `log` supports line-based `offset`/`limit` (omit `offset` to grab the last N lines).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `process` is scoped per agent; sessions from other agents are not visible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `web_search`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Search the web using Brave Search API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `query` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `count` (1–10; default from `tools.web.search.maxResults`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires a Brave API key (recommended: `openclaw configure --section web`, or set `BRAVE_API_KEY`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable via `tools.web.search.enabled`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Responses are cached (default 15 min).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Web tools](/tools/web) for setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `web_fetch`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fetch and extract readable content from a URL (HTML → markdown/text).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `url` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `extractMode` (`markdown` | `text`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxChars` (truncate long pages)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable via `tools.web.fetch.enabled`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxChars` is clamped by `tools.web.fetch.maxCharsCap` (default 50000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Responses are cached (default 15 min).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For JS-heavy sites, prefer the browser tool.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Web tools](/tools/web) for setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Firecrawl](/tools/firecrawl) for the optional anti-bot fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `browser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Control the dedicated OpenClaw-managed browser.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `snapshot` (aria/ai)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `screenshot` (returns image block + `MEDIA:<path>`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `act` (UI actions: click/type/press/hover/drag/select/fill/resize/wait/evaluate)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `navigate`, `console`, `pdf`, `upload`, `dialog`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profile management:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `profiles` — list all browser profiles with status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `create-profile` — create new profile with auto-allocated port (or `cdpUrl`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `delete-profile` — stop browser, delete user data, remove from config (local only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reset-profile` — kill orphan process on profile's port (local only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `profile` (optional; defaults to `browser.defaultProfile`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `target` (`sandbox` | `host` | `node`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node` (optional; picks a specific node id/name)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires `browser.enabled=true` (default is `true`; set `false` to disable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All actions accept optional `profile` parameter for multi-instance support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `profile` is omitted, uses `browser.defaultProfile` (defaults to "chrome").（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Profile names: lowercase alphanumeric + hyphens only (max 64 chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Port range: 18800-18899 (~100 profiles max).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remote profiles are attach-only (no start/stop/reset).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a browser-capable node is connected, the tool may auto-route to it (unless you pin `target`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `snapshot` defaults to `ai` when Playwright is installed; use `aria` for the accessibility tree.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `snapshot` also supports role-snapshot options (`interactive`, `compact`, `depth`, `selector`) which return refs like `e12`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `act` requires `ref` from `snapshot` (numeric `12` from AI snapshots, or `e12` from role snapshots); use `evaluate` for rare CSS selector needs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid `act` → `wait` by default; use it only in exceptional cases (no reliable UI state to wait on).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `upload` can optionally pass a `ref` to auto-click after arming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `upload` also supports `inputRef` (aria ref) or `element` (CSS selector) to set `<input type="file">` directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `canvas`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Drive the node Canvas (present, eval, snapshot, A2UI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `present`, `hide`, `navigate`, `eval`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `snapshot` (returns image block + `MEDIA:<path>`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `a2ui_push`, `a2ui_reset`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses gateway `node.invoke` under the hood.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If no `node` is provided, the tool picks a default (single connected node or local mac node).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A2UI is v0.8 only (no `createSurface`); the CLI rejects v0.9 JSONL with line errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Quick smoke: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `nodes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discover and target paired nodes; send notifications; capture camera/screen.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `status`, `describe`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pending`, `approve`, `reject` (pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `notify` (macOS `system.notify`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `run` (macOS `system.run`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `camera_snap`, `camera_clip`, `screen_record`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `location_get`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Camera/screen commands require the node app to be foregrounded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Images return image blocks + `MEDIA:<path>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Videos return `FILE:<path>` (mp4).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Location returns a JSON payload (lat/lon/accuracy/timestamp).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `run` params: `command` argv array; optional `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (`run`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "run",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "node": "office-mac",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "command": ["echo", "Hello"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "env": ["FOO=bar"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "commandTimeoutMs": 12000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "invokeTimeoutMs": 45000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "needsScreenRecording": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `image`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Analyze an image with the configured image model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `image` (required path or URL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prompt` (optional; defaults to "Describe the image.")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model` (optional override)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxBytesMb` (optional size cap)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only available when `agents.defaults.imageModel` is configured (primary or fallbacks), or when an implicit image model can be inferred from your default model + configured auth (best-effort pairing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses the image model directly (independent of the main chat model).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Send messages and channel actions across Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `send` (text + optional media; MS Teams also supports `card` for Adaptive Cards)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `poll` (WhatsApp/Discord/MS Teams polls)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `react` / `reactions` / `read` / `edit` / `delete`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pin` / `unpin` / `list-pins`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `permissions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thread-create` / `thread-list` / `thread-reply`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `search`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sticker`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `member-info` / `role-info`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `emoji-list` / `emoji-upload` / `sticker-upload`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `role-add` / `role-remove`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel-info` / `channel-list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voice-status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `event-list` / `event-create`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeout` / `kick` / `ban`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `send` routes WhatsApp via the Gateway; other channels go direct.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `poll` uses the Gateway for WhatsApp and MS Teams; Discord polls go direct.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When a message tool call is bound to an active chat session, sends are constrained to that session’s target to avoid cross-context leaks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `cron`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage Gateway cron jobs and wakeups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `status`, `list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `add`, `update`, `remove`, `run`, `runs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wake` (enqueue system event + optional immediate heartbeat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `add` expects a full cron job object (same schema as `cron.add` RPC).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `update` uses `{ jobId, patch }` (`id` accepted for compatibility).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart or apply updates to the running Gateway process (in-place).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `restart` (authorizes + sends `SIGUSR1` for in-process restart; `openclaw gateway` restart in-place)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config.get` / `config.schema`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config.apply` (validate + write config + restart + wake)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config.patch` (merge partial update + restart + wake)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `update.run` (run update + restart + wake)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `delayMs` (defaults to 2000) to avoid interrupting an in-flight reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `restart` is disabled by default; enable with `commands.restart: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List sessions, inspect transcript history, or send to another session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = none)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_history`: `sessionKey` (or `sessionId`), `limit?`, `includeTools?`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_send`: `sessionKey` (or `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `session_status`: `sessionKey?` (default current; accepts `sessionId`), `model?` (`default` clears override)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `main` is the canonical direct-chat key; global/unknown are hidden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messageLimit > 0` fetches last N messages per session (tool messages filtered).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_send` waits for final completion when `timeoutSeconds > 0`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Delivery/announce happens after completion and is best-effort; `status: "ok"` confirms the agent run finished, not that the announce was delivered.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_spawn` starts a sub-agent run and posts an announce reply back to the requester chat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_spawn` is non-blocking and returns `status: "accepted"` immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessions_send` runs a reply‑back ping‑pong (reply `REPLY_SKIP` to stop; max turns via `session.agentToAgent.maxPingPongTurns`, 0–5).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After the ping‑pong, the target agent runs an **announce step**; reply `ANNOUNCE_SKIP` to suppress the announcement.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents_list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List agent ids that the current session may target with `sessions_spawn`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Result is restricted to per-agent allowlists (`agents.list[].subagents.allowAgents`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `["*"]` is configured, the tool includes all configured agents and marks `allowAny: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Parameters (common)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway-backed tools (`canvas`, `nodes`, `cron`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gatewayUrl` (default `ws://127.0.0.1:18789`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gatewayToken` (if auth enabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutMs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: when `gatewayUrl` is set, include `gatewayToken` explicitly. Tools do not inherit config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or environment credentials for overrides, and missing explicit credentials is an error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Browser tool:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `profile` (optional; defaults to `browser.defaultProfile`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `target` (`sandbox` | `host` | `node`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node` (optional; pin a specific node id/name)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Recommended agent flows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Browser automation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `browser` → `status` / `start`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `snapshot` (ai or aria)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `act` (click/type/press)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. `screenshot` if you need visual confirmation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Canvas render:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `canvas` → `present`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `a2ui_push` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `snapshot`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Node targeting:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `nodes` → `status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `describe` on the chosen node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `notify` / `run` / `camera_snap` / `screen_record`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid direct `system.run`; use `nodes` → `run` only with explicit user consent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Respect user consent for camera/screen capture.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `status/describe` to ensure permissions before invoking media commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How tools are presented to the agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tools are exposed in two parallel channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **System prompt text**: a human-readable list + guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Tool schema**: the structured function definitions sent to the model API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
That means the agent sees both “what tools exist” and “how to call them.” If a tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
doesn’t appear in the system prompt or the schema, the model cannot call it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
