# OpenClaw Gateway Stability Diagnostic — 2026-05-02

Branch: `fix/lcm-and-cli-backend-stability`
Time spent: ~75 minutes
Author: Claw (diagnostic agent)

## TL;DR

| #   | Bug                                                                                                            | Root cause owner                                                                                           | Fixed in this PR?                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | LCM 401 with `claude-cli/claude-sonnet-4-6` summary provider                                                   | `lossless-claw` plugin (third-party) + Boss config                                                         | No — config change required                                                                                             |
| 2   | LCM "auth error" with `openai-codex/gpt-5.5` summary provider on transcripts containing OpenAI reasoning blobs | `lossless-claw` plugin (third-party)                                                                       | No — upstream plugin fix required                                                                                       |
| 3   | `claude live session turn failed: error=AbortError` on long Claude-CLI turns                                   | `src/agents/cli-runner/claude-live-session.ts` (this repo) — opaque diagnostics, not a true root-cause bug | **Partially**: error message now carries the abort trigger so the next occurrence is diagnosable from a single log line |

The `lossless-claw` plugin lives at `/Users/bob/.openclaw/extensions/lossless-claw/` (`@martian-engineering/lossless-claw@0.5.1`) — it is **not** part of this repo. Per AGENTS.md "Owner boundary" rules, owner-specific behavior must be fixed in the owner module; LCM bugs 1 and 2 land in that plugin or in Boss's config, not here.

---

## Bug 1 — pre-2026-05-01: `summaryProvider: claude-cli` → 401 from `platform.openai.com`

### Symptom

`gateway.err.log` 2026-05-01 11:42 → 20:56 (six occurrences):

```
[lcm] compaction failed: provider auth error. Check that the configured summaryProvider has valid API credentials.
Current: claude-cli/claude-sonnet-4-6
Detail: 401 Incorrect API key provided: sk-ant-a***...pgAA. You can find your API key at https://platform.openai.com/account/api-keys.
```

The sk-ant-… key (Anthropic OAuth-derived) is being POSTed to `platform.openai.com` and rejected. This is a routing bug, not an auth bug. The 20+ silent days before this point were the same misconfiguration silently swallowing all compaction attempts.

### Root cause

`claude-cli` is **not a real HTTP provider** — it is a wrapper that shells out to the local `claude` CLI binary. There is no `claude-cli` HTTP API endpoint. When `lossless-claw`'s `summarize.ts` resolves the provider for the summarizer call, it falls through `inferApiFromProvider()` (in `extensions/lossless-claw/src/plugin/index.ts:1098` of the live install), which has no mapping for `claude-cli` and defaults to an OpenAI-shaped completions API. The Anthropic OAuth API key gets sent to the OpenAI host, which rightly rejects it as a foreign-format key.

References (live install — not in this repo):

- `extensions/lossless-claw/src/plugin/index.ts:1042` — `complete()` builds a `pi-ai` request with the resolved provider/api/apiKey.
- `extensions/lossless-claw/src/plugin/index.ts:1115` — `resolvedModel.api` falls back to `inferApiFromProvider(providerId)` when `pi-ai`'s `getModel(provider, model)` misses, which happens for `claude-cli`.

### Fix applied

None in this repo — this is a plugin/config bug.

### What Boss must do on the live install

Boss has already partially fixed this overnight by switching `plugins.entries.lossless-claw.config.{summaryProvider,summaryModel}` to `openai-codex` / `openai-codex/gpt-5.5` (visible in `~/.openclaw/openclaw.json` and confirmed by 4 successful condensed rows on 2026-05-01 at 12:26, 12:54, 22:07, 22:37 in `lcm.db`).

The durable fix is:

- **Never set `summaryProvider: claude-cli`.** It is not an HTTP provider and cannot serve LCM summarization calls.
- Use `summaryProvider: anthropic` with `summaryModel: anthropic/claude-haiku-4-5` (cheap and fast — this is what the pre-Apr-11 condensed rows used successfully) **or** keep the current `openai-codex` setup (subject to Bug 2).

Upstream issue worth filing against `@martian-engineering/lossless-claw`: validate `summaryProvider` against `pi-ai`'s known HTTP-provider registry at plugin load and emit a hard error if it's a CLI shell wrapper like `claude-cli` / `gemini-cli` / `codex-cli`. Today the misconfiguration is silently accepted and only surfaces when compaction is attempted hours/days later.

---

## Bug 2 — 2026-05-02: `openai-codex/gpt-5.5` rejects transcripts containing OpenAI reasoning blobs

### Symptom

`gateway.err.log` 2026-05-02 08:07 and 08:22 (two occurrences so far):

```
[lcm] compaction failed: provider auth error. Check that the configured summaryProvider has valid API credentials.
Current: openai-codex/gpt-5.5
Detail: assistant thinking {"id":"rs_0a4...","type":"reasoning","encrypted_content":"gAAAAABp9SQVW5lO...[truncated:6522 chars]
```

Two distinct misclassifications in this single log line:

1. **Misleading wrapper.** `lossless-claw`'s `extractProviderAuthFailure` (`extensions/lossless-claw/src/summarize.ts:393`) walks the `errorMessage`/`error`/`response` fields of the failed response and pattern-matches `\b401\b|unauthorized|invalid api key|authentication failed|...`. Some of those tokens appear inside the 6.7-KB OpenAI Codex error body it received, so it labels the failure "provider auth error" even though the actual cause is content rejection. The `Detail:` is then `truncateDiagnosticText(message, 240)` of the same long message.
2. **Real cause.** The error body that begins `assistant thinking {"id":"rs_…","type":"reasoning","encrypted_content":"gAA…"}` is the OpenAI Codex Responses API rejecting reasoning items it cannot pair against the current request. The encrypted reasoning blob (`rs_…` IDs, `gAAAAABp…` encrypted_content) was generated by a previous OpenAI request and is bound to that request's session — it cannot be replayed across requests, especially not from the _user_ role into a fresh summarize call.

### Why the user prompt contains it

`lossless-claw`'s leaf-pass summarizer (`extensions/lossless-claw/src/compaction.ts:1107` `leafPass`) builds the source text by concatenating raw `messages.content` strings from `lcm.db`:

```ts
const concatenated = messageContents
  .map((m) => `[${formatTimestamp(m.createdAt, ...)}]\n${m.content}`)
  .join("\n\n");
```

Per `~/.openclaw/lcm.db`, assistant rows are stored as JSON like:

```json
[
  {
    "type": "thinking",
    "thinking": "",
    "thinkingSignature": "{\"id\":\"rs_…\",\"type\":\"reasoning\",\"encrypted_content\":\"gAAAAABp…\"}"
  }
]
```

i.e. the `thinkingSignature` is a JSON-encoded OpenAI reasoning item. When that gets concatenated into the LCM user prompt and shipped to the OpenAI Codex Responses API, the Codex backend's input validator finds the embedded `rs_…` item, tries to validate it against this request's reasoning chain (which doesn't exist — it's a single user turn), and 4xx's with the offending blob in the error message.

This is exactly the "Anthropic-format reasoning block reaching a non-Anthropic summary provider" that the brief described. The summarizer should be stripping or redacting these before serializing the source text.

### Fix applied

None in this repo — this is a plugin bug. The fix belongs in `extensions/lossless-claw/src/compaction.ts` (or in a sanitize helper applied right before the `concatenated` string is handed to `summarizeWithEscalation`). Two viable approaches in the plugin:

1. **Per-message scrub**: parse `messages.content` JSON; for assistant blocks of type `thinking` or `reasoning`, replace with `[reasoning omitted]` (or drop entirely). The `thinkingSignature` payload is opaque encrypted data — there is no value in shipping it to the summarizer regardless.
2. **Provider-aware sanitization**: only scrub when `summaryProvider` differs from the provider that produced the reasoning blob. Today every single condensed row in `lcm.db` was produced by a different provider than the one that emitted the reasoning, so option (1) is functionally equivalent and simpler.

Either way, also fix `extractProviderAuthFailure` to **not** classify an error as "auth" when the matched token came from inside an obviously-non-auth payload (e.g., the offending text starts with `assistant ` or contains `encrypted_content`). The current heuristic is too eager and misled Boss for several hours today.

### What Boss must do on the live install

Until the plugin ships a fix:

- **Switch `summaryProvider` back to `anthropic`** with `summaryModel: anthropic/claude-haiku-4-5`. Anthropic's Messages API accepts `thinking` blocks in user-text content (it's just text to the API) and historically produced 11 condensed rows successfully (Mar 24 → Apr 11). The 401-on-OpenAI bug from Bug 1 does not apply because `anthropic` is a real HTTP provider with the right key.
- File an issue against `@martian-engineering/lossless-claw` with the `Detail: assistant thinking {…encrypted_content…}` excerpt and a link to one of the failing requests. The repo is at https://github.com/martian-engineering/lossless-claw (per the package.json author field).

Concrete `~/.openclaw/openclaw.json` change Boss needs to apply:

```json
"plugins": {
  "entries": {
    "lossless-claw": {
      "config": {
        "summaryModel": "anthropic/claude-haiku-4-5",
        "summaryProvider": "anthropic"
      }
    }
  }
}
```

(Hot-reload-safe per `[reload] config change requires gateway restart` log evidence — restart the gateway after the swap.)

---

## Bug 3 — `[agent/cli-backend] claude live session turn failed: error=AbortError` on long CLI turns

### Symptom

20+ AbortError lines across `2026-04-24` → `2026-05-02` in `gateway.err.log`. Durations span 4s → 165s — no single timeout trigger. Every line is shaped:

```
[agent/cli-backend] claude live session turn failed: provider=claude-cli model=claude-opus-4-7 durationMs=… error=AbortError
Embedded agent failed before reply: CLI run aborted
```

Boss has feedback memory (`~/.openclaw/backups/2026-05-02/auto-memory/feedback_abort_error_pattern.md`) noting "AbortError spike post-2026.4.26 with 120s stuck-session correlation" and that they cannot pin the trigger from inside the agent.

### Root cause investigation

The AbortError is thrown by `src/agents/cli-runner/claude-live-session.ts:282` `createAbortError()`, fired from one of two paths:

1. The reply operation's `AbortSignal` triggers (`abortFromSignal` listener at `claude-live-session.ts:961`).
2. The reply backend handle's `cancel()` is invoked (`abortFromReplyBackend` at `claude-live-session.ts:951`).

These in turn are triggered by:

- `ReplyOperation.abortByUser()` — user typed an abort word (`stop`, `wait`, `exit`, `abort`, …) — see `src/auto-reply/reply/abort-primitives.ts:5` `ABORT_TRIGGERS`.
- `ReplyOperation.abortForRestart()` — `abortActiveReplyRuns({mode:"compacting"|"all"})` from `src/auto-reply/reply/reply-run-registry.ts:502`. Triggered by gateway draining and by compaction-restart paths.
- `requestLiveSessionModelSwitch()` — `/model` switch mid-turn (`src/agents/live-model-switch.ts:76`).
- `chat.abort` RPC and `tryFastAbortFromMessage` (operator stop word).
- Session-fingerprint mismatch on a follow-up `chat.send` causes `closeLiveSession(session, "restart")` at `claude-live-session.ts:828`. **This path does not throw AbortError** — it kills the CLI managed-run with `manual-cancel`, which surfaces as `FailoverError` via `handleClaudeExit`. Confirmed by reading `closeLiveSession()` at `claude-live-session.ts:354–377`. So fingerprint-restart is **not** the AbortError source.

Correspondingly, the `[diagnostic] stuck session` warning fires at 120s+ but `recoverStuckDiagnosticSession` (`src/logging/diagnostic-stuck-session-recovery.runtime.ts:78`) is observe-only when `allowActiveAbort` is false (production default). So the stuck-session diagnostic does **not** abort active turns either, contradicting the operating hypothesis in Boss's feedback memory.

The actual culprit, on every `AbortError` we see, is one of the four explicit triggers above. The diagnostic log line **does not record which one** — `failTurn` only logs `error=AbortError` with no detail. That is why Boss cannot pin the cause from logs.

### Fix applied (in this repo)

`src/agents/cli-runner/claude-live-session.ts`:

1. `createAbortError(reason?)` (was: zero-arg, fixed `"CLI run aborted"` message). Now pulls a string out of the abort reason — including the upstream `Error` name + message — and appends it to the error message.
2. `failTurn` now appends `detail="…"` (truncated to 240 chars) so the offending error message reaches the log line.
3. The two abort paths are split: `abortFromSignal` reads `params.context.params.abortSignal.reason` (which is the upstream `controller.abort(reason)` payload — a `UserAbortError` for stop-words, `Error("Reply operation aborted for restart")` for compaction/drain, etc.); `abortFromReplyBackend` tags the error with `replyBackend:<reason>` (`user_abort`, `restart`, or `superseded`).

`src/agents/cli-runner/execute.ts`:

4. Same `createCliAbortError(reason?)` upgrade and abort-signal-reason wiring for the non-live CLI path.

`src/gateway/chat-abort.ts`:

5. `abortChatRunById` now calls `controller.abort("chat-abort:<stopReason>")` instead of `.abort()` — the existing `stopReason` (e.g., `"rpc"`, `"stop"`, `"timeout"`) is now propagated through the AbortSignal so the `claude-live-session.ts` listener can include it in the AbortError message.

Net effect: from the next gateway restart onward, every AbortError line will look like one of:

```
... error=AbortError detail="CLI run aborted: AbortError: Reply operation aborted by user"
... error=AbortError detail="CLI run aborted: AbortError: Reply operation aborted for restart"
... error=AbortError detail="CLI run aborted: replyBackend:restart"
... error=AbortError detail="CLI run aborted: chat-abort:rpc"
```

That is sufficient for Boss to attribute each abort to its real source (operator stop-word vs. compaction restart vs. model switch vs. RPC-driven abort) without re-investigating from scratch.

### What is NOT fixed

- The brief asks for a "real fix" to the AbortError pattern. **A real fix requires knowing which trigger is firing**, and the existing logs do not say. The ride-along change above is the prerequisite — once a few new aborts arrive with attributed reasons, the actual fix becomes obvious (e.g., "raise the stuck-session warn threshold", "stop calling `abortForRestart` on memory-flush failure", "stop the cron from sending bare 'wait' messages", etc.).
- I did **not** raise the abort grace timeout, change the `ABORT_TRIGGERS` set, or alter compaction-restart policy — any of those without the trigger evidence would be a guess. The architecture rule "do not introduce hypothetical-future-requirement abstractions or guesses" applies.

### What Boss should do after the next AbortError

1. `grep "claude live session turn failed.*AbortError" ~/.openclaw/logs/gateway.err.log | tail -5`
2. The new `detail="…"` on each line tells you which trigger fired.
3. If the detail is `"replyBackend:restart"` or `"Reply operation aborted for restart"` → the gateway is calling `abortForRestart` mid-turn. Follow with `grep "abortActiveReplyRuns\|memory_flushing\|preflight_compacting" gateway.err.log` near the same timestamp to find the caller (likely an LCM/compaction restart).
4. If the detail is `"AbortError: Reply operation aborted by user"` → operator (or a tool/cron) sent an abort word. Check the channel transcript at the timestamp for the offending message.
5. If the detail starts `"chat-abort:"` → an explicit `chat.abort` RPC. Check the WS log for the originating client.

---

## Tests added

- `src/agents/cli-runner/abort-reason.test.ts` — 7 unit tests covering string / Error / object / nullish abort-reason inputs for both `createAbortError` (live-session path) and `createCliAbortError` (non-live path). Run: `pnpm test src/agents/cli-runner/abort-reason.test.ts` — passes.
- Existing tests still green:
  - `pnpm test src/gateway/chat-abort.test.ts` — 4/4 passed.
  - `pnpm test src/agents/cli-runner/` — 35/35 passed.

`pnpm tsgo -p tsconfig.core.json` and `pnpm tsgo -p tsconfig.core.test.json` both clean.

I did not run the broader `pnpm check:changed` gate — per AGENTS.md "Testbox by default for broad/shared validation on maintainer machines"; this branch is for local review only and Boss/Claw will re-run gates before any push.

## Config changes Boss needs to apply on the live install

In `~/.openclaw/openclaw.json`, change `plugins.entries.lossless-claw.config`:

```json
{
  "freshTailCount": 64,
  "contextThreshold": 0.65,
  "incrementalMaxDepth": -1,
  "summaryModel": "anthropic/claude-haiku-4-5",
  "summaryProvider": "anthropic",
  "ignoreSessionPatterns": ["agent:*:cron:**", "agent:*:subagent:**"]
}
```

Then restart the gateway. This unblocks compaction immediately (Bug 1 + Bug 2) without waiting for an upstream `lossless-claw` fix.

Optional, recommended: file the two upstream issues against `@martian-engineering/lossless-claw` so the plugin ships proper fixes:

1. "summaryProvider validation should reject CLI-shell providers (`claude-cli`, `gemini-cli`, `codex-cli`)" — fixes Bug 1 silent acceptance.
2. "Strip OpenAI-format `reasoning`/`encrypted_content` items from leaf-pass source text before sending to non-Anthropic summarizers" — fixes Bug 2.
