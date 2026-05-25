# Chat History Beta 2 Fix Report

Date: 2026-05-25
Branch: `fix/chat-history-turns-v2026.5.24-beta.2`
Base: `origin/main`
Runtime patch head after main-port: `d1b1d0c04a fix(chat): bound chat history display payloads`

## Status

The chat history patch was originally prepared against `v2026.5.24-beta.2`, then cleanly cherry-picked onto `origin/main` for PR publication.

`origin/main` at `e7c696a5b0ec30c0ad041887694ce7f7a81115dc` is the PR base. The main-port branch is 1 commit ahead of that base and keeps the PR scoped to the chat history fix.

## Runtime Changed Surface

The runtime patch changes 12 files; this report is the thirteenth changed file after documentation is added:

- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`
- `scripts/list-prod-store-packages.mjs`
- `src/gateway/chat-display-projection.ts`
- `src/gateway/chat-history-turns.ts`
- `src/gateway/protocol/schema/logs-chat.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/server.chat.gateway-server-chat-b.test.ts`
- `src/gateway/session-utils.fs.test.ts`
- `src/gateway/session-utils.fs.ts`
- `src/gateway/session-utils.ts`
- `test/scripts/list-prod-store-packages.test.ts`
- `ui/src/ui/controllers/chat.ts`

## Fixes Applied

### 1. `chat.history` display mode now defaults to bounded turns

WebChat requests `chat.history` with `mode: "turns"` instead of raw message replay.

The gateway groups recent projected transcript records into compact turn items and returns display-oriented messages for UI compatibility. Tool activity is summarized instead of replaying raw tool call and tool result payloads into normal display history.

### 2. Legacy `messages` mode is capped and tool-safe by default

Legacy `mode: "messages"` keeps message-shaped output, but tool payloads are replaced with safe placeholders unless the caller explicitly requests raw transcript access.

The gateway applies:

- per-message byte caps
- aggregate response byte caps
- placeholder emission accounting
- slow-path metrics including returned bytes, placeholders, read timings, and response mode

### 3. Raw transcript access is explicit

`mode: "raw-messages"` is exposed through the schema, and the unsafe raw tool payload path is gated by `unsafeRawToolPayloads`.

The Codex review found that raw mode was still using display-projected messages. That was fixed so raw mode returns from `rawMessages.slice(-scanMax)`, preserving mixed assistant text, tool call arguments, and raw tool results before display projection.

### 4. `turns` mode now bounds full response size, not only `messages`

The second Codex review found that `turnProjection.items` could exceed the history byte budget even when `messages` had already been capped.

The fix now caps turn items against the remaining response budget, updates returned item metadata, and falls back to an empty `items` array if the complete response would still exceed the configured history cap.

### 5. Transcript reads are bounded and instrumented

The session transcript reader now supports bounded recent reads with byte limits and read timing breakdowns. This targets the observed slow `chat.history` path where large tool-heavy transcript payloads could make history reads expensive.

### 6. Production store package listing no longer pulls dev-only lockfile packages

Codex review found that `scripts/list-prod-store-packages.mjs` added every lockfile package after calculating the production dependency closure. That could pull dev-only packages into Docker runtime assets.

The script now starts from `pnpm list` production dependencies and only expands through matching lockfile snapshot dependencies.

### 7. Peer-qualified pnpm lockfile entries are included in prod closure

The second Codex review found that snapshot lookups missed peer-qualified lockfile keys such as `source-map-support@0.5.21(acorn@8.16.0)`.

The script now builds normalized maps for package and snapshot entries so peer-qualified keys can participate in the closure without broadening to unrelated lockfile packages.

## Validation Run

The following validation passed on the main-port branch:

- `corepack pnpm vitest run test/scripts/list-prod-store-packages.test.ts src/gateway/session-utils.fs.test.ts src/gateway/server.chat.gateway-server-chat-b.test.ts -t 'chat.history turns mode bounds response items|chat.history turns mode preserves recent visible turns|chat.history raw-messages preserves raw tool payloads|chat.history messages mode omits raw tool payloads|readRecentSessionMessagesDetailedAsync|list-prod-store-packages'`
- `git diff --check origin/main...HEAD`
- `CI=true corepack pnpm check:changed`
- `CODEX_HOME=/home/lumadmin/.openclaw/codex-home /usr/bin/codex review --base origin/main`

Codex review result: no discrete correctness, security, performance, or maintainability regressions were identified.

## PR Caveat

This PR addresses display-history payload shape and bounding. It does not claim to solve reconnect or warmup behavior that can create concurrent `chat.history` reads for the same large session. During dogfood, that signal overlapped with other gateway activity, including observed Codex pretool slowness, so those numbers should be treated as diagnostic evidence rather than a clean benchmark.
