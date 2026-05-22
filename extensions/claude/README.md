# @openclaw/claude

OpenClaw harness plugin that delegates Anthropic-provider turns to a local
`@zeroaltitude/claude-app-server` process via the codex-shaped JSON-RPC
protocol.

## Architecture

This package is the **in-tree client bridge** to an external JSON-RPC server.
Three pieces, two repos:

| Component                                    | Repo                        | Package                                  |
| -------------------------------------------- | --------------------------- | ---------------------------------------- |
| Client bridge (this package)                 | `openclaw/openclaw`         | `@openclaw/claude` (bundled extension)   |
| Plugin manifest + harness wiring             | `openclaw/openclaw-plugins` | `@openclaw/claude` (plugin distribution) |
| **JSON-RPC server** (spawned by this bridge) | `openclaw/openclaw-plugins` | `@zeroaltitude/claude-app-server`        |

The directory name `src/app-server/` mirrors `extensions/codex/src/app-server/`
for visual symmetry with the codex extension. In both cases the directory
holds the **client side** of the codex-app-server protocol; the actual
server is an external binary spawned over stdio. Codex's server is
`@openai/codex` (third-party); ours is `@zeroaltitude/claude-app-server`
(fork-preview publish path; will migrate to `@openclaw/claude-app-server`
once the upstream PR lands and maintainers republish).

## Runtime dependency on the server

This bridge spawns `openclaw-claude-app-server` (the binary published by
[`@zeroaltitude/claude-app-server`](https://www.npmjs.com/package/@zeroaltitude/claude-app-server))
at turn-start. The server package is declared as a regular dependency in
`extensions/claude/package.json`, so installing `@openclaw/claude` pulls
the binary into `node_modules/.bin/openclaw-claude-app-server`
automatically — no separate install step needed.

The `@zeroaltitude` scope is a fork-preview publish path. Once the
upstream OpenClaw PR lands and maintainers republish under
`@openclaw/claude-app-server`, this dependency will switch to the
`@openclaw` scope in a future patch.

If a turn fails with `claude-app-server is not initialized` or
`spawn openclaw-claude-app-server ENOENT`, the most likely cause is a
broken install — confirm `which openclaw-claude-app-server` (or
`ls node_modules/.bin/openclaw-claude-app-server` from the OpenClaw
checkout root) returns a path before debugging further.

## Slash commands

This extension registers `/claude` with subcommands:

- `/claude status` — shared-client liveness + last server stderr
- `/claude version` — bridge + installed server package versions
- `/claude threads` — the active session's `.claude-binding.json` sidecar
- `/claude resume <thread_id>` — rotate the session's binding to a specific thread
- `/claude help` — subcommand listing (default when no args)

## Hot-path features

- **Rate-limit surfacing** (server-side): Anthropic 429 metadata is parsed
  and folded into the user-visible error message (server's `rate-limits.ts`).
- **Image payload sanitizer** (server-side): pre-flight validates image
  content blocks against Anthropic's 5 MB / 100-images-per-request limits
  before they hit the API (server's `image-payload-sanitizer.ts`).
- **Plugin inventory + thread config** (server-side): captures plugin tool
  inventories per thread so resume can detect catalog drift (server's
  `plugin-inventory.ts` + `plugin-thread-config.ts`).
- **Vision tools filter** (bridge-side): when the model has native vision
  AND the turn carries inbound images, the redundant `image` tool is
  filtered out (`src/app-server/vision-tools.ts`).
- **Doctor contract** (bridge-side): legacy-config rules and session-route
  ownership consumed by `openclaw doctor` (`doctor-contract-api.ts`).
- **Event projection** (bridge-side): item/started/completed and
  assistant/reasoning deltas are projected into the OpenClaw harness's
  notification + accumulator surface via `src/app-server/event-projector.ts`,
  decoupling the JSON-RPC event shape from `run-attempt.ts`.
- **Transcript mirroring** (bridge-side): turn output is mirrored into the
  OpenClaw session transcript with stable `claude/${threadId}/${turnId}/...`
  idempotency keys; replays and crash recovery skip already-appended entries
  (`src/app-server/transcript-mirror.ts`).
- **Aggregate tool-result cap** (bridge-side): dynamic-tool output is
  budgeted across all text blocks in a single result (not per-block); the
  cap reads from `agents.list[].contextLimits.toolResultMaxChars` with
  fallback to `agents.defaults.contextLimits.toolResultMaxChars` and then
  to the 16 000-char default (`src/app-server/dynamic-tools.ts`).

## Known limitations

- **Tool-catalog change resets conversation transcript.** When the
  active dynamic-tool catalog changes mid-session (plugin
  enabled/disabled/upgraded, allowlist edited, sandbox toggled), the
  bridge calls `thread/start` rather than `thread/resume` and the
  underlying Claude Agent SDK's session transcript resets. The SDK's
  MCP server registration happens at `thread/start` and isn't
  refreshable on resume, so an in-place patch isn't possible today.
  Tracked at `src/app-server/thread-lifecycle.ts` (KNOWN LIMITATION
  docblock). Mitigations under consideration: (a) extend the server
  to support `thread/fork` semantics that carry the SDK transcript
  forward across catalog changes, or (b) get SDK support for
  refreshable MCP registration. In practice catalog churn is rare for
  stable plugin sets, so this is most visible after plugin upgrades.

- **Scope migration pending**: `@zeroaltitude/claude-app-server` is a
  fork-preview publish path. Once the upstream OpenClaw PR lands and
  maintainers republish under `@openclaw/claude-app-server`, this
  package's dependency declaration will switch.

- **Codex middleware — three deferred items**: the dynamic-tool path
  here implements aggregate `toolResultMaxChars` budgeting (see
  "Aggregate tool-result cap" above), but three pieces of codex's
  middleware chain are not yet ported:
  - `createAgentToolResultMiddlewareRunner({ runtime: "claude" })`
    wiring — needs the middleware registry to recognize the "claude"
    runtime label so reply/audit middlewares can target this bridge.
  - `messagingToolSourceReplyPayloads` telemetry — needs an
    equivalent reply-source pipeline on the claude side so messaging
    tools can attribute outbound payloads back to a source message.
  - Namespace / `deferLoading` for searchable dynamic tools — needs
    server-side support before the bridge can declare a namespace
    or mark tools as deferred-loaded.

  Tracked in beads `openclaw-7w9`.
