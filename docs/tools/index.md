---
summary: "OpenClaw tools and plugins overview: what the agent can do and how to extend it"
read_when:
  - You want to understand what tools OpenClaw provides
  - You need to configure, allow, or deny tools
  - You are deciding between built-in tools, skills, and plugins
title: "Tools and Plugins"
---

# Tools and Plugins

Everything the agent does beyond generating text happens through **tools**.
Tools are how the agent reads files, runs commands, browses the web, sends
messages, and interacts with devices.

## Tools, skills, and plugins

OpenClaw has three layers that work together:

<Steps>
  <Step title="Tools are what the agent calls">
    A tool is a typed function the agent can invoke (e.g. `exec`, `browser`,
    `web_search`, `message`). OpenClaw ships a set of **built-in tools** and
    plugins can register additional ones.

    The agent sees tools as structured function definitions sent to the model API.

  </Step>

  <Step title="Skills teach the agent when and how">
    A skill is a markdown file (`SKILL.md`) injected into the system prompt.
    Skills give the agent context, constraints, and step-by-step guidance for
    using tools effectively. Skills live in your workspace, in shared folders,
    or ship inside plugins.

    [Skills reference](/tools/skills) | [Creating skills](/tools/creating-skills)

  </Step>

  <Step title="Plugins package everything together">
    A plugin is a package that can register any combination of capabilities:
    channels, model providers, tools, skills, speech, image generation, and more.
    Some plugins are **core** (shipped with OpenClaw), others are **external**
    (published on npm by the community).

    [Install and configure plugins](/tools/plugin) | [Build your own](/plugins/building-plugins)

  </Step>
</Steps>

## Built-in tools

These tools ship with OpenClaw and are available without installing any plugins:

| Tool                                    | What it does                                             | Page                                    |
| --------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| `exec` / `process`                      | Run shell commands, manage background processes          | [Exec](/tools/exec)                     |
| `code_execution`                        | Run sandboxed remote Python analysis                     | [Code Execution](/tools/code-execution) |
| `browser`                               | Control a Chromium browser (navigate, click, screenshot) | [Browser](/tools/browser)               |
| `web_search` / `x_search` / `web_fetch` | Search the web, search X posts, fetch page content       | [Web](/tools/web)                       |
| `read` / `write` / `edit`               | File I/O in the workspace                                |                                         |
| `apply_patch`                           | Multi-hunk file patches                                  | [Apply Patch](/tools/apply-patch)       |
| `message`                               | Send messages across all channels                        | [Agent Send](/tools/agent-send)         |
| `canvas`                                | Drive node Canvas (present, eval, snapshot)              |                                         |
| `nodes`                                 | Discover and target paired devices                       |                                         |
| `cron` / `gateway`                      | Manage scheduled jobs, restart gateway                   |                                         |
| `image` / `image_generate`              | Analyze or generate images                               |                                         |
| `sessions_*` / `agents_list`            | Session management, sub-agents                           | [Sub-agents](/tools/subagents)          |

For image work, use `image` for analysis and `image_generate` for generation or editing. If you target `openai/*`, `google/*`, `fal/*`, or another non-default image provider, configure that provider's auth/API key first.

### Plugin-provided tools

Plugins can register additional tools. Some examples:

- [Lobster](/tools/lobster) — typed workflow runtime with resumable approvals
- [LLM Task](/tools/llm-task) — JSON-only LLM step for structured output
- [Diffs](/tools/diffs) — diff viewer and renderer
- [OpenProse](/prose) — markdown-first workflow orchestration

## Tool configuration

### Allow and deny lists

Control which tools the agent can call via `tools.allow` / `tools.deny` in
config. Deny always wins over allow.

```json5
{
  tools: {
    allow: ["group:fs", "browser", "web_search"],
    deny: ["exec"],
  },
}
```

### Tool profiles

`tools.profile` sets a base allowlist before `allow`/`deny` is applied.
Per-agent override: `agents.list[].tools.profile`.

| Profile     | What it includes                            |
| ----------- | ------------------------------------------- |
| `full`      | All tools (default)                         |
| `coding`    | File I/O, runtime, sessions, memory, image  |
| `messaging` | Messaging, session list/history/send/status |
| `minimal`   | `session_status` only                       |

### Tool groups

Use `group:*` shorthands in allow/deny lists:

| Group              | Tools                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `group:runtime`    | exec, bash, process, code_execution                                                                       |
| `group:fs`         | read, write, edit, apply_patch                                                                            |
| `group:sessions`   | sessions_list, sessions_history, sessions_send, sessions_spawn, sessions_yield, subagents, session_status |
| `group:memory`     | memory_search, memory_get                                                                                 |
| `group:web`        | web_search, x_search, web_fetch                                                                           |
| `group:ui`         | browser, canvas                                                                                           |
| `group:automation` | cron, gateway                                                                                             |
| `group:messaging`  | message                                                                                                   |
| `group:nodes`      | nodes                                                                                                     |
| `group:openclaw`   | All built-in OpenClaw tools (excludes plugin tools)                                                       |

### Provider-specific restrictions

Use `tools.byProvider` to restrict tools for specific providers without
changing global defaults:

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Example (provider/model-specific allowlist for a flaky endpoint):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Example (agent-specific override for a single provider):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Tool groups (shorthands)

Tool policies (global, agent, sandbox) support `group:*` entries that expand to multiple tools.
Use these in `tools.allow` / `tools.deny`.

Available groups:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: all built-in OpenClaw tools (excludes provider plugins)

Example (allow only file tools + browser):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + tools

Plugins can register **additional tools** (and CLI commands) beyond the core set.
See [Plugins](/tools/plugin) for install + config, and [Skills](/tools/skills) for how
tool usage guidance is injected into prompts. Some plugins ship their own skills
alongside tools (for example, the voice-call plugin).

Optional plugin tools:

- [Lobster](/tools/lobster): typed workflow runtime with resumable approvals (requires the Lobster CLI on the gateway host).
- [LLM Task](/tools/llm-task): JSON-only LLM step for structured workflow output (optional schema validation).
- [Diffs](/tools/diffs): read-only diff viewer and PNG or PDF file renderer for before/after text or unified patches.

## Tool inventory

### `apply_patch`

Apply structured patches across one or more files. Use for multi-hunk edits.
Experimental: enable via `tools.exec.applyPatch.enabled` (OpenAI models only).
`tools.exec.applyPatch.workspaceOnly` defaults to `true` (workspace-contained). Set it to `false` only if you intentionally want `apply_patch` to write/delete outside the workspace directory.

### `exec`

Run shell commands in the workspace.

Core parameters:

- `command` (required)
- `yieldMs` (auto-background after timeout, default 10000)
- `background` (immediate background)
- `timeout` (seconds; kills the process if exceeded, default 1800)
- `elevated` (bool; run on host if elevated mode is enabled/allowed; only changes behavior when the agent is sandboxed)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (node id/name for `host=node`)
- Need a real TTY? Set `pty: true`.

Notes:

- Returns `status: "running"` with a `sessionId` when backgrounded.
- Use `process` to poll/log/write/kill/clear background sessions.
- If `process` is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`.
- `elevated` is gated by `tools.elevated` plus any `agents.list[].tools.elevated` override (both must allow) and is an alias for `host=gateway` + `security=full`.
- `elevated` only changes behavior when the agent is sandboxed (otherwise it’s a no-op).
- `host=node` can target a macOS companion app or a headless node host (`openclaw node run`).
- gateway/node approvals and allowlists: [Exec approvals](/tools/exec-approvals).

### `process`

Manage background exec sessions.

Core actions:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Notes:

- `poll` returns new output and exit status when complete.
- `log` supports line-based `offset`/`limit` (omit `offset` to grab the last N lines).
- `process` is scoped per agent; sessions from other agents are not visible.

### `loop-detection` (tool-call loop guardrails)

OpenClaw tracks recent tool-call history and blocks or warns when it detects repetitive no-progress loops.
Enable with `tools.loopDetection.enabled: true` (default is `false`).

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      historySize: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

- `genericRepeat`: repeated same tool + same params call pattern.
- `knownPollNoProgress`: repeating poll-like tools with identical outputs.
- `pingPong`: alternating `A/B/A/B` no-progress patterns.
- Per-agent override: `agents.list[].tools.loopDetection`.

### `web_search`

Search the web using Perplexity, Brave, Gemini, Grok, or Kimi.

Core parameters:

- `query` (required)
- `count` (1–20; default from `tools.web.search.maxResults`)

Notes:

- Requires an API key for the chosen provider (recommended: `openclaw configure --section web`).
- Enable via `tools.web.search.enabled`.
- Responses are cached (default 15 min).
- See [Web tools](/tools/web) for setup.

### `web_fetch`

Fetch and extract readable content from a URL (HTML → markdown/text).

Core parameters:

- `url` (required)
- `extractMode` (`markdown` | `text`)
- `maxChars` (truncate long pages)

Notes:

- Enable via `tools.web.fetch.enabled`.
- `maxChars` is clamped by `tools.web.fetch.maxCharsCap` (default 50000).
- Responses are cached (default 15 min).
- For JS-heavy sites, prefer the browser tool.
- See [Web tools](/tools/web) for setup.
- See [Firecrawl](/tools/firecrawl) for the optional anti-bot fallback.

### `browser`

Control the dedicated OpenClaw-managed browser.

Core actions:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (returns image block + `MEDIA:<path>`)
- `act` (UI actions: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Profile management:

- `profiles` — list all browser profiles with status
- `create-profile` — create new profile with auto-allocated port (or `cdpUrl`)
- `delete-profile` — stop browser, delete user data, remove from config (local only)
- `reset-profile` — kill orphan process on profile's port (local only)

Common parameters:

- `profile` (optional; defaults to `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optional; picks a specific node id/name)
  Notes:
- Requires `browser.enabled=true` (default is `true`; set `false` to disable).
- All actions accept optional `profile` parameter for multi-instance support.
- When `profile` is omitted, uses `browser.defaultProfile` (defaults to "chrome").
- Profile names: lowercase alphanumeric + hyphens only (max 64 chars).
- Port range: 18800-18899 (~100 profiles max).
- Remote profiles are attach-only (no start/stop/reset).
- If a browser-capable node is connected, the tool may auto-route to it (unless you pin `target`).
- `snapshot` defaults to `ai` when Playwright is installed; use `aria` for the accessibility tree.
- `snapshot` also supports role-snapshot options (`interactive`, `compact`, `depth`, `selector`) which return refs like `e12`.
- `act` requires `ref` from `snapshot` (numeric `12` from AI snapshots, or `e12` from role snapshots); use `evaluate` for rare CSS selector needs.
- Avoid `act` → `wait` by default; use it only in exceptional cases (no reliable UI state to wait on).
- `upload` can optionally pass a `ref` to auto-click after arming.
- `upload` also supports `inputRef` (aria ref) or `element` (CSS selector) to set `<input type="file">` directly.

### `canvas`

Drive the node Canvas (present, eval, snapshot, A2UI).

Core actions:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (returns image block + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Notes:

- Uses gateway `node.invoke` under the hood.
- If no `node` is provided, the tool picks a default (single connected node or local mac node).
- A2UI is v0.8 only (no `createSurface`); the CLI rejects v0.9 JSONL with line errors.
- Quick smoke: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Discover and target paired nodes; send notifications; capture camera/screen.

Core actions:

- `status`, `describe`
- `pending`, `approve`, `reject` (pairing)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_list`, `camera_snap`, `camera_clip`, `screen_record`
- `location_get`, `notifications_list`, `notifications_action`
- `device_status`, `device_info`, `device_permissions`, `device_health`

Notes:

- Camera/screen commands require the node app to be foregrounded.
- Images return image blocks + `MEDIA:<path>`.
- Videos return `FILE:<path>` (mp4).
- Location returns a JSON payload (lat/lon/accuracy/timestamp).
- `run` params: `command` argv array; optional `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Example (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Analyze an image with the configured image model.

Core parameters:

- `image` (required path or URL)
- `prompt` (optional; defaults to "Describe the image.")
- `model` (optional override)
- `maxBytesMb` (optional size cap)

Notes:

- Only available when `agents.defaults.imageModel` is configured (primary or fallbacks), or when an implicit image model can be inferred from your default model + configured auth (best-effort pairing).
- Uses the image model directly (independent of the main chat model).

### `pdf`

Analyze one or more PDF documents.

For full behavior, limits, config, and examples, see [PDF tool](/tools/pdf).

### `message`

Send messages and channel actions across Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Core actions:

- `send` (text + optional media; MS Teams also supports `card` for Adaptive Cards)
- `poll` (WhatsApp/Discord/MS Teams polls)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Notes:

- `send` routes WhatsApp via the Gateway; other channels go direct.
- `poll` uses the Gateway for WhatsApp and MS Teams; Discord polls go direct.
- When a message tool call is bound to an active chat session, sends are constrained to that session’s target to avoid cross-context leaks.

### `cron`

Manage Gateway cron jobs and wakeups.

Core actions:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (enqueue system event + optional immediate heartbeat)

Notes:

- `add` expects a full cron job object (same schema as `cron.add` RPC).
- `update` uses `{ jobId, patch }` (`id` accepted for compatibility).

### `gateway`

Restart or apply updates to the running Gateway process (in-place).

Core actions:

- `restart` (authorizes + sends `SIGUSR1` for in-process restart; `openclaw gateway` restart in-place)
- `config.schema.lookup` (inspect one config path at a time without loading the full schema into prompt context)
- `config.get`
- `config.apply` (validate + write config + restart + wake)
- `config.patch` (merge partial update + restart + wake)
- `update.run` (run update + restart + wake)

Notes:

- `config.schema.lookup` expects a targeted config path such as `gateway.auth` or `agents.list.*.heartbeat`.
- Paths may include slash-delimited plugin ids when addressing `plugins.entries.<id>`, for example `plugins.entries.pack/one.config`.
- Use `delayMs` (defaults to 2000) to avoid interrupting an in-flight reply.
- `config.schema` remains available to internal Control UI flows and is not exposed through the agent `gateway` tool.
- `restart` is enabled by default; set `commands.restart: false` to disable it.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

List sessions, inspect transcript history, or send to another session.

Core parameters:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = none)
- `sessions_history`: `sessionKey` (or `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (or `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `runtime?`, `agentId?`, `model?`, `thinking?`, `cwd?`, `runTimeoutSeconds?`, `thread?`, `mode?`, `cleanup?`, `sandbox?`, `streamTo?`, `attachments?`, `attachAs?`
- `session_status`: `sessionKey?` (default current; accepts `sessionId`), `model?` (`default` clears override)

Notes:

- `main` is the canonical direct-chat key; global/unknown are hidden.
- `messageLimit > 0` fetches last N messages per session (tool messages filtered).
- Session targeting is controlled by `tools.sessions.visibility` (default `tree`: current session + spawned subagent sessions). If you run a shared agent for multiple users, consider setting `tools.sessions.visibility: "self"` to prevent cross-session browsing.
- `sessions_send` waits for final completion when `timeoutSeconds > 0`.
- Delivery/announce happens after completion and is best-effort; `status: "ok"` confirms the agent run finished, not that the announce was delivered.
- `sessions_spawn` supports `runtime: "subagent" | "acp"` (`subagent` default). For ACP runtime behavior, see [ACP Agents](/tools/acp-agents).
- For ACP runtime, `streamTo: "parent"` routes initial-run progress summaries back to the requester session as system events instead of direct child delivery.
- `sessions_spawn` starts a sub-agent run and posts an announce reply back to the requester chat.
  - Supports one-shot mode (`mode: "run"`) and persistent thread-bound mode (`mode: "session"` with `thread: true`).
  - If `thread: true` and `mode` is omitted, mode defaults to `session`.
  - `mode: "session"` requires `thread: true`.
  - If `runTimeoutSeconds` is omitted, OpenClaw uses `agents.defaults.subagents.runTimeoutSeconds` when set; otherwise timeout defaults to `0` (no timeout).
  - Discord thread-bound flows depend on `session.threadBindings.*` and `channels.discord.threadBindings.*`.
  - Reply format includes `Status`, `Result`, and compact stats.
  - `Result` is the assistant completion text; if missing, the latest `toolResult` is used as fallback.
- Manual completion-mode spawns send directly first, with queue fallback and retry on transient failures (`status: "ok"` means run finished, not that announce delivered).
- `sessions_spawn` supports inline file attachments for subagent runtime only (ACP rejects them). Each attachment has `name`, `content`, and optional `encoding` (`utf8` or `base64`) and `mimeType`. Files are materialized into the child workspace at `.openclaw/attachments/<uuid>/` with a `.manifest.json` metadata file. The tool returns a receipt with `count`, `totalBytes`, per file `sha256`, and `relDir`. Attachment content is automatically redacted from transcript persistence.
  - Configure limits via `tools.sessions_spawn.attachments` (`enabled`, `maxTotalBytes`, `maxFiles`, `maxFileBytes`, `retainOnSessionKeep`).
  - `attachAs.mountPath` is a reserved hint for future mount implementations.
- `sessions_spawn` is non-blocking and returns `status: "accepted"` immediately.
- ACP `streamTo: "parent"` responses may include `streamLogPath` (session-scoped `*.acp-stream.jsonl`) for tailing progress history.
- `sessions_send` runs a reply‑back ping‑pong (reply `REPLY_SKIP` to stop; max turns via `session.agentToAgent.maxPingPongTurns`, 0–5).
- After the ping‑pong, the target agent runs an **announce step**; reply `ANNOUNCE_SKIP` to suppress the announcement.
- Sandbox clamp: when the current session is sandboxed and `agents.defaults.sandbox.sessionToolsVisibility: "spawned"`, OpenClaw clamps `tools.sessions.visibility` to `tree`.

### `agents_list`

List agent ids that the current session may target with `sessions_spawn`.

Notes:

- Result is restricted to per-agent allowlists (`agents.list[].subagents.allowAgents`).
- When `["*"]` is configured, the tool includes all configured agents and marks `allowAny: true`.

## Parameters (common)

Gateway-backed tools (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (default `ws://127.0.0.1:18789`)
- `gatewayToken` (if auth enabled)
- `timeoutMs`

Note: when `gatewayUrl` is set, include `gatewayToken` explicitly. Tools do not inherit config
or environment credentials for overrides, and missing explicit credentials is an error.

Browser tool:

- `profile` (optional; defaults to `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optional; pin a specific node id/name)
- Troubleshooting guides:
  - Linux startup/CDP issues: [Browser troubleshooting (Linux)](/tools/browser-linux-troubleshooting)
  - WSL2 Gateway + Windows remote Chrome CDP: [WSL2 + Windows + remote Chrome CDP troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting)

## Recommended agent flows

Browser automation:

1. `browser` → `status` / `start`
2. `snapshot` (ai or aria)
3. `act` (click/type/press)
4. `screenshot` if you need visual confirmation

Canvas render:

1. `canvas` → `present`
2. `a2ui_push` (optional)
3. `snapshot`

Node targeting:

1. `nodes` → `status`
2. `describe` on the chosen node
3. `notify` / `run` / `camera_snap` / `screen_record`

## Safety

- Avoid direct `system.run`; use `nodes` → `run` only with explicit user consent.
- Respect user consent for camera/screen capture.
- Use `status/describe` to ensure permissions before invoking media commands.

## How tools are presented to the agent

Tools are exposed in two parallel channels:

1. **System prompt text**: a human-readable list + guidance.
2. **Tool schema**: the structured function definitions sent to the model API.

That means the agent sees both “what tools exist” and “how to call them.” If a tool
doesn’t appear in the system prompt or the schema, the model cannot call it.
>>>>>>> c05661e51d (feat: increase Brave search max count from 10 to 20)
