# Multi-Agent Context Hardening

## Problems addressed

- Context leakage risk between agents due to non-canonical session lookup paths.
- Session history growth and recursive summary degradation during repeated compaction.
- Missing hard-limit preflight compaction on the server side.
- Runtime state reuse across agent switch, archive, reset, and new chat flows.
- Startup migration safety and recoverability for long-lived session stores.
- Limited observability into context assembly and token budgeting.

## Fixes implemented

- Added agent-aware canonical session key resolution and runner-safe session identity lookup.
- Isolated synthetic summaries from source history and enforced single-summary context assembly.
- Preserved technical facts in summaries: commit hashes, env names, file paths, IDs, and error snippets.
- Added summary lineage metadata and repeated-compact safeguards.
- Added server-side hard-limit preflight compact while preserving the last user input.
- Unified runtime reset behavior for agent switch, archive, reset, and new chat flows.
- Prevented late assistant transcript writes into archived chats.
- Added idempotent startup migration with a barrier to avoid duplicate archive/summary writes.
- Added context budget breakdown and debug tracing for summary/recent/memory token visibility.

## Files changed

- Modified tracked files:
  - `docker-compose.yml`
  - `src/agents/pi-embedded-runner/run/attempt.ts`
  - `src/agents/system-prompt.ts`
  - `src/auto-reply/reply/commands-compact.ts`
  - `src/auto-reply/reply/session.test.ts`
  - `src/auto-reply/reply/session.ts`
  - `src/channels/dock.ts`
  - `src/channels/plugins/actions/telegram.test.ts`
  - `src/channels/plugins/actions/telegram.ts`
  - `src/config/sessions.test.ts`
  - `src/config/sessions/session-key.ts`
  - `src/config/sessions/types.ts`
  - `src/gateway/protocol/index.ts`
  - `src/gateway/protocol/schema/logs-chat.ts`
  - `src/gateway/protocol/schema/protocol-schemas.ts`
  - `src/gateway/protocol/schema/sessions.ts`
  - `src/gateway/protocol/schema/types.ts`
  - `src/gateway/server-methods/chat.ts`
  - `src/gateway/server-methods/sessions.ts`
  - `src/gateway/server-startup-memory.ts`
  - `src/gateway/server-startup.ts`
  - `src/gateway/server.chat.gateway-server-chat-b.e2e.test.ts`
  - `src/gateway/session-utils.ts`
  - `src/gateway/session-utils.types.ts`
  - `src/infra/outbound/message-action-params.ts`
  - `src/infra/outbound/message-action-runner.threading.test.ts`
  - `src/telegram/bot-message-context.ts`
  - `ui/src/ui/app-chat.ts`
  - `ui/src/ui/app-gateway.node.test.ts`
  - `ui/src/ui/app-render.ts`
  - `ui/src/ui/app-settings.test.ts`
  - `ui/src/ui/app-view-state.ts`
  - `ui/src/ui/app.ts`
  - `ui/src/ui/controllers/chat.ts`
  - `ui/src/ui/storage.ts`
  - `ui/src/ui/views/chat.ts`
- Added new files:
  - `Dockerfile.2026.2.19-ffmpeg`
  - `scripts/start_with_keychain.sh`
  - `src/agents/chat-context-store.test.ts`
  - `src/agents/chat-context-store.ts`
  - `src/agents/context-policy.ts`
  - `src/agents/pi-embedded-runner/run/attempt.session-identity.test.ts`
  - `src/gateway/chat-context.test.ts`
  - `src/gateway/chat-context.ts`
  - `src/gateway/server-methods/chat.preflight.test.ts`
  - `src/gateway/server-startup-agent-context.test.ts`
  - `src/gateway/server-startup-agent-context.ts`
  - `ui/src/ui/app-chat.test.ts`

## Tests added

- `src/agents/chat-context-store.test.ts`
- `src/agents/pi-embedded-runner/run/attempt.session-identity.test.ts`
- `src/gateway/chat-context.test.ts`
- `src/gateway/server-methods/chat.preflight.test.ts`
- `src/gateway/server-startup-agent-context.test.ts`
- `ui/src/ui/app-chat.test.ts`
- Extended `src/gateway/server.chat.gateway-server-chat-b.e2e.test.ts`
- Extended `src/config/sessions.test.ts`
- Extended `src/auto-reply/reply/session.test.ts`
- Extended `ui/src/ui/app-gateway.node.test.ts`
- Extended `ui/src/ui/app-settings.test.ts`

## Guarantees now provided

- Session resolution is agent-aware for direct/default and runner lookup paths.
- Synthetic summary messages never become the source of truth for future summaries.
- Context assembly contains at most one summary, and it always precedes the recent tail.
- Hard-limit compaction runs once per request flow and preserves the last user input.
- Agent switch, archive, reset, and new chat clear the same critical runtime state.
- Archived chats reject late assistant transcript writes.
- Startup migration is barrier-protected and repeatable without duplicate archive creation.
- Context budgeting is visible via structured debug breakdowns.

## Before merge, still verify

- Run a full repository test sweep if desired beyond the targeted suites already run.
- Manually inspect remaining raw session store callers outside the hardened gateway/runner paths.
- Optionally unify duplicate canonicalization helpers in `src/gateway/session-utils.ts`.
- Optionally type the migration marker fields directly in `src/config/sessions/types.ts`.
