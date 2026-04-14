# Commentary-Phase Chat Leak Investigation

## Summary

Commentary-phase assistant text is supposed to be replay/debug context, not user-visible chat output.
Current OpenClaw code mostly treats it that way, but two live broadcast surfaces bypass the phase-aware filters:

1. `chat` live events in `src/gateway/server-chat.ts`
2. `session.message` transcript update events in `src/gateway/server-session-events.ts`

That matches the reported symptom: a transcript entry can contain commentary text plus a tool call in the same assistant turn, and that commentary text can still show up in chat even though history endpoints hide it.

## What Commentary Means

Current architecture treats assistant `phase` / `textSignature.phase` as semantic metadata on assistant text blocks:

- `commentary` means interim assistant narration/replay text, often before a tool call.
- `final_answer` means the user-visible answer text.

The shared extraction helpers make that contract explicit:

- `resolveAssistantMessagePhase()` infers a message phase from `message.phase` or `textSignature.phase` metadata in text blocks. See `src/shared/chat-message-content.ts:64`.
- `extractAssistantVisibleText()` prefers `final_answer` text and otherwise only returns unphased legacy text. Commentary-only text is intentionally excluded. See `src/shared/chat-message-content.ts:182`.

## Exact Persistence Path

For OpenAI Responses / WebSocket turns, commentary metadata is preserved on the stored assistant message:

1. `buildAssistantMessageFromResponse()` converts model output items into an assistant transcript message. Commentary text is stored as `content[]` text blocks with `textSignature` carrying `{ phase: "commentary" }`, and tool calls are stored in the same assistant message as `toolCall` blocks. See `src/agents/openai-ws-message-conversion.ts:465`.
2. The embedded runner uses a guarded `SessionManager.appendMessage(...)` wrapper.
3. `installSessionToolResultGuard()` appends the final assistant message verbatim and immediately emits `emitSessionTranscriptUpdate({ message: finalMessage, ... })`. No commentary stripping happens there. See `src/agents/session-tool-result-guard.ts:171` and `src/agents/session-tool-result-guard.ts:247`.

So the transcript entry itself legitimately contains commentary text plus tool calls. That is not the bug by itself.

## Where Suppression Already Works

The phase-aware filtering exists and is already used in history-style surfaces:

- `sanitizeChatHistoryMessages()` drops assistant messages whose resolved phase is `commentary`, and strips commentary text blocks when explicit phased blocks are present. See `src/gateway/server-methods/chat.ts:691` and `src/gateway/server-methods/chat.ts:936`.
- `buildSessionHistorySnapshot()` always runs `sanitizeChatHistoryMessages(...)` before returning messages. See `src/gateway/session-history-state.ts:96`.
- `sessions-history-http` also uses the same sanitized state for inline SSE `message` updates. See `src/gateway/sessions-history-http.ts:227`.
- Existing tests already prove this contract for `chat.history`. See `src/gateway/server.chat.gateway-server-chat.test.ts:545` and `src/gateway/server-methods/server-methods.test.ts:266`.
- The embedded reply stream used for actual reply delivery also suppresses commentary before emitting assistant deltas/finals. See `src/agents/pi-embedded-subscribe.handlers.messages.ts:217`, `src/agents/pi-embedded-subscribe.handlers.messages.ts:303`, and `src/agents/pi-embedded-subscribe.handlers.messages.ts:456`.

## Where It Actually Leaks

### 1. Live `chat` stream

`createAgentEventHandler()` forwards any assistant event with `evt.data.text` into `emitChatDelta(...)` without checking `evt.data.phase`.

See `src/gateway/server-chat.ts:983`.

That means commentary-phase assistant events can become live user-visible `chat` deltas/finals if any upstream emitter includes `phase: "commentary"` alongside `text`.

### 2. `session.message` transcript broadcast

`createTranscriptUpdateBroadcastHandler()` forwards `update.message` directly as a `session.message` event after attaching only sequence/id metadata.

See `src/gateway/server-session-events.ts:83`.

Unlike history endpoints, this path does not run `sanitizeChatHistoryMessages(...)`, `resolveAssistantMessagePhase(...)`, or `extractAssistantVisibleText(...)`.

So when the session manager emits a transcript update for an assistant message containing commentary text plus tool calls, subscribers can receive the raw commentary text and render it directly.

## Likely Root Cause

The bug is inconsistent filtering across surfaces, not incorrect transcript storage.

OpenClaw intentionally preserves commentary-phase text in the transcript for replay/context continuity. The leak happens later because some live broadcast paths still treat raw assistant text as user-visible text:

- `server-chat` trusts `evt.data.text` and ignores `evt.data.phase`
- `server-session-events` trusts `update.message` and skips transcript sanitization

In other words, commentary is modeled correctly, persisted correctly, and filtered correctly in history endpoints, but not normalized at every live fan-out boundary.

## Most Likely Safe Fix Shape

The obvious safe fix is to make the live fan-out boundaries reuse the same phase-aware rules already used elsewhere:

1. In `src/gateway/server-chat.ts`, ignore assistant events whose `evt.data.phase === "commentary"` before calling `emitChatDelta(...)` / emitting final chat text.
2. In `src/gateway/server-session-events.ts`, sanitize `update.message` before broadcasting `session.message`, ideally by reusing the same history sanitization/extraction helpers.
3. Add regression tests for an assistant turn that contains:
   - a commentary text block with `textSignature.phase = "commentary"`
   - a `toolCall` in the same assistant message
   - a live `chat`/`session.message` subscriber

## Conclusion

The reported leak is plausible in current code.

The most likely root cause is that commentary-phase text is preserved in the transcript for replay, but `server-chat` and `server-session-events` still expose raw assistant text without applying the phase-aware visibility contract already enforced by `chat.history`, `sessions-history-http`, and the embedded reply stream.
