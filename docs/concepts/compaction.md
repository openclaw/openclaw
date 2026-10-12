---
summary: "How OpenClaw summarizes long conversations to stay within model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
---

Every model has a context window: the maximum number of tokens it can process. When a conversation approaches that limit, OpenClaw **compacts** older messages into a summary so the chat can continue.

## How it works

1. Older conversation turns are summarized into a compact entry.
2. The summary is saved in the session transcript.
3. Recent messages are kept intact.

OpenClaw keeps assistant tool calls paired with their matching `toolResult` entries when it picks a compaction split point. If the point lands inside a tool block, OpenClaw moves the boundary so the pair stays together and the current unsummarized tail is preserved.

Built-in compaction summarizes the older history in one model request, whatever the size of the session or the context window. A split turn adds one request for the turn prefix, and a failed safeguard quality audit adds one request per corrective attempt. Each request's conversation input is capped at 160,000 characters (about 40,000 tokens), or less when the summarizer's own context window is smaller. A larger history is filled in this order: the newest messages verbatim, in half of that budget; your older messages, which carry the asks, decisions and corrections, in a quarter, each trimmed to at most 2,000 characters and spread evenly across the history when they do not all fit; the oldest messages, in a tenth; and evenly spaced runs of the remaining messages, trimmed to 6,000 characters each. Each gap is marked with the number of messages left out, and the summarizer is told not to guess their content and to keep the previous summary's facts. Chinese, Japanese, and Korean (CJK) characters count by their approximate token weight. The bound applies to the summarizer input only; the transcript keeps every message.

The full conversation history stays on disk. Compaction only changes what the model sees on the next turn.

Built-in summarization receives text, not image pixels. Omitted images and other non-text input receive markers such as `[image data omitted from summary input]`, without claiming that a model processed the data. The first eight affected messages receive at most two fixed markers each; further omissions receive one aggregate statement. These additions, including newly retained role labels and separators, total at most 847 UTF-8 bytes per summarizer request and count toward token estimates. Existing text is not capped by this omission budget. Custom compaction providers still receive the original message content.

<Note>
New configs default `agents.defaults.compaction.mode` to `"safeguard"` (stricter guardrails, summary quality audits). Set `mode: "default"` explicitly to opt out.
</Note>

With the built-in safeguard quality guard enabled, OpenClaw budgets the final
summary using a CJK-aware token estimate, then checks its structure, pending asks,
and exact identifiers. Failed checks get only the configured number of corrective
attempts. If those attempts are exhausted, or required facts cannot fit, OpenClaw
stores the best available generated summary so the session can continue. A failed
corrective generation can also reuse an earlier summary.

This fallback is deliberately lossy. It keeps generated facts in a structured body
and tries to retain the latest request context, exact identifiers, split-turn
progress, and recent turns. If they cannot fit, it drops the longest identifiers
first, then relaxes required-fact retention. Older details, identifiers, and pending
requests may therefore leave the model context. The compaction entry records
`details.qualityDegraded`, `/status` shows the degraded state, and a visible warning
suggests `/new` or a larger model. This warning appears even when `notifyUser` is
`false`.

If no summary was generated, a generation, model-resolution, or credentials failure
keeps the original history. Caller-initiated cancellation is always respected.
A configured compaction provider that fails or returns an empty result, including
a provider-local timeout without caller cancellation, falls back to the built-in
summarizer. Automatic compaction also has a separate timeout fallback that can
commit without a generated summary; see [Auto-compaction](#auto-compaction).

## Auto-compaction

Auto-compaction is on by default. It runs when the session nears the context limit, or when the model returns a context-overflow error (in which case OpenClaw compacts and retries).

If the provider rejects a request after tool calls have completed, the built-in runtime can compact and continue from their recorded results. It keeps the current model and account, preserves the original request, and does not replay completed actions. This recovery requires settled tool results; pending tools, approvals, cancellation, and a tool that intentionally ended the turn retain their normal handling. If a Gateway restart later interrupts that continuing run, recovery preserves the accepted input even when compaction has summarized it.

For OpenAI-compatible Chat Completions, an automatically context-capped response that ends with `length` also enters this recovery. OpenClaw withholds the incomplete candidate and its tool calls until the finish reason is known. This buffering is bounded; an oversized response resumes ordinary streaming and retains its normal `length` result. Explicit output limits retain their normal behavior.

Before automatically reducing the output budget for an OpenAI-compatible tool request, OpenClaw uses a minimum output budget equal to one eighth of the model’s declared maximum output, bounded between 16 and 2,048 tokens. If that minimum cannot fit, compaction runs before the request is sent. Requests without active tools keep the 16-token floor, and explicit output limits that fit remain valid.

Overflow recovery trims tool results within the current model-context window. Older messages and reset boundaries remain in retained history without being copied into new transcript entries.

If overflow recovery cannot make the prompt fit, the failed reply suggests `/reset`, `/new`, or a larger-context model. The Control UI shows this guidance in Details and keeps it in saved chat history. For a single oversized prompt, shorten the prompt before resending it in a new session.

Stopping or timing out a run also stops its overflow or timeout recovery. The built-in OpenClaw runtime does not start further recovery hooks, maintenance, transcript truncation, or retries after cancellation. Cancellation is not rollback: a compaction that already completed remains in the transcript and is still counted, without sending a late reply. The context estimate follows the latest model or compaction observation; billing totals remain separate.

If an automatic compaction's summary times out while the turn is still active (the summary deadline expires, or the provider answers HTTP 408 or 504) and no earlier summary can be reused, OpenClaw commits that compaction without a summary instead of ending the turn. It keeps the same recent messages verbatim, including complete tool calls and results, the pending request, and a split turn's original request, carries the previous summary forward, and notes how many older messages were removed. The reply then continues, and the next turn does not wait for the same summary again. Gateway logs record `[compaction-diag] fallback ... reason=timeout summary=deterministic`; no chat notice is added. A timed-out summary does not move to the model fallback chain, because each extra model could add another full timeout window to the wait. Stop and run timeouts always cancel recovery. Manual `/compact` and other summarizer errors keep reporting the failure when no earlier summary can be reused.

This applies in safeguard mode too: older facts that were never summarized leave the model context, and later compactions do not bring them back, because each one starts from the previous compaction boundary. The transcript still keeps every message for history and explicit retrieval. Without this exception, every following turn would wait out the same timeout and the session would stay unusable.

The built-in OpenClaw runtime performs required checkpointing and compaction before inference. This includes helper-completion and approval-follow-up turns; their user-facing model selection remains unchanged. In persistent Gateway sessions, optional memory flushing and compaction wait until reply delivery has settled and its foreground owner has closed. That work uses a separate session owner and the turn's remaining time. A new message cancels and settles optional work before reading the session for its own inference.

One-shot `openclaw agent --local` commands skip optional post-turn work; the next command performs required maintenance before inference. Generic CLI backends keep their existing synchronous host compaction, and native runtimes retain their own compaction policy. Optional maintenance failures are logged without replacing an already completed reply. Cancellation, restart, or a replaced session still fences active writers.

Set `agents.defaults.compaction.enabled: false` to disable proactive threshold compaction and optional maintenance in the built-in runtime. Overflow-recovery compaction and manual `/compact` remain available.

You will see:

- `embedded run auto-compaction start` / `complete` in normal Gateway logs.
- `🧹 Auto-compaction complete` in verbose mode.
- `/status` showing `🧹 Compactions: <count>`.

<Info>
Before compacting, OpenClaw automatically reminds the agent to save important notes to [memory](/concepts/memory) files. This helps preserve durable context.
</Info>

<AccordionGroup>
  <Accordion title="Overflow error patterns OpenClaw recognizes">
    OpenClaw matches dozens of provider-specific overflow error strings (Anthropic, OpenAI, Bedrock, Gemini, Ollama, OpenRouter, and more). Common examples:

    - `request_too_large`
    - `context length exceeded`
    - `input exceeds the maximum number of tokens`
    - `input token count exceeds the maximum number of input tokens` (Bedrock)
    - `input is too long for the model`
    - `ollama error: context length exceeded`

  </Accordion>
</AccordionGroup>

## Manual compaction

Type `/compact` in a chat to force compaction when its runtime supports manual
compaction. In the built-in OpenClaw runtime, add instructions to guide the
summary, as in the example below. When manual compaction is available in native
Codex sessions with Codex login or an API key, use bare `/compact`; focus
instructions are not passed to Codex. Native Codex sessions using
[Sign in with ChatGPT](/providers/openai/authentication) support automatic
compaction, but cannot run manual `/compact`.

```text
/compact Focus on the API design decisions
```

If a turn is active, `/compact` gives it up to 60 seconds to finish before
cancelling it and waiting up to 15 more seconds for it to stop. When cancellation
succeeds, the command's reply asks you to resend the interrupted request, including
when the run is still stopping and compaction cannot proceed.

Client-side compaction in the built-in OpenClaw runtime passes focus to both older-history and split-turn-prefix summaries. The host limits operator-provided focus to 800 Unicode code points and escapes it as prompt data before adding it to model requests.

Automatic session title generation runs in the background and does not block manual compaction. Gateway compaction requests promptly refuse admitted turns and accepted queued work. Once foreground admission has ended, a completed reply that is still saving or cleaning up can take up to 15 seconds to settle before the request rechecks the session. In-band commands exclude their own execution from this wait, but still wait for other completed writers.

Client-side manual compaction uses `agents.defaults.compaction.keepRecentTokens` (default: 20,000) as its cut-point budget and keeps that recent tail in rebuilt context.

When the built-in OpenClaw runtime has prepared the foreground request,
client-side automatic compaction also accounts for its system prompt, tool
schemas, pending input, and output reserve when choosing the retained tail.
It may retain fewer recent messages so the summary and conversation fit together.
Choosing a larger summarization model does not increase the foreground model's
context window. The reserve is a preferred target, not a provider token limit.
When the fixed prompt or pending input consumes that target, OpenClaw can still reclaim older
history while preserving the unprocessed request. Such a replacement must
strictly reduce history; unchanged or larger results are rejected. Otherwise,
automatic compaction requires the complete replacement to fit the estimated target.
Early required preflight runs before those request facts are available and still
uses history-based sizing; it does not guarantee this preferred headroom.

## Configuration

Configure compaction under `agents.defaults.compaction` in your `openclaw.json`. The most common knobs are listed below; for the full reference, see [Session management deep dive](/reference/session-management-compaction).

### Using a different model

The built-in OpenClaw runtime starts compaction with the active session model. Set `agents.defaults.compaction.model` to select a different summarization model. The override accepts a `provider/model-id` string or a bare alias configured under `agents.defaults.models`:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "openrouter/anthropic/claude-sonnet-4-6"
      }
    }
  }
}
```

Bare configured aliases resolve to their canonical provider and model before compaction starts. If a bare value matches both an alias and a configured literal model ID, the literal model ID wins. An unmatched bare value remains a model ID on the active provider.

If Gateway configuration reloads while compaction is waiting to start, compaction uses the newly loaded context engine and model settings together. Its requested workspace and transcript stay the same.

This works with local models too, for example a second Ollama model dedicated to summarization:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "ollama/llama3.1:8b"
      }
    }
  }
}
```

When unset, compaction starts with the active session model. If summarization fails with a model-fallback-eligible provider error, OpenClaw retries that compaction attempt through the session's existing model fallback chain. The fallback choice is temporary and is not written back to session state. An explicit `agents.defaults.compaction.model` override remains exact and does not inherit the session fallback chain.

Preflight compaction also uses that chain when the primary auth profile is already in cooldown. Each candidate must pass auth admission before summarization; a healthy fallback can compact the session without waiting for the primary cooldown to expire.

In safeguard mode, provider timeouts and rate limits from built-in summarization remain eligible for that chain when no earlier summary can be reused. A summary deadline or an HTTP 408 or 504 instead uses the automatic timeout fallback (see [Auto-compaction](#auto-compaction)). Caller cancellation and failed safeguard quality checks do not trigger a model switch.

### Identifier preservation

Compaction summarization requests exact opaque identifier retention by default (`agents.defaults.compaction.identifierPolicy: "strict"`). Degraded summaries may omit identifiers that cannot fit. Set `agents.defaults.compaction.identifierPolicy: "off"` to disable the retention guidance. Custom guidance belongs in a compaction provider's `summarize()` implementation.

### Active transcript byte guard

When `agents.defaults.compaction.maxActiveTranscriptBytes` is set, OpenClaw
triggers normal local compaction before a run if transcript history reaches
that size. This is useful for long-running sessions where provider-side context
management may keep model context healthy while persisted transcript history
keeps growing. Set a positive byte count or size string such as `"20mb"` to opt
in; `0` or an unset value disables the guard. It does not split raw bytes; it
asks the normal compaction pipeline to create a semantic summary. If compaction
is declined or leaves history over the limit, the turn continues with a bounded
view of recent history. OpenClaw omits the oldest whole turns, keeps tool calls
with their results, and preserves the system instructions and current request.
An oversized historical turn may be omitted in full. This fallback does not
rewrite saved messages or count a failed attempt as successful compaction.
It shows a notice even with compaction notifications disabled; resend any
essential details from omitted history. The bound applies to selected history,
not the fixed instructions, tool definitions, or current request.

Suppressed byte-compaction retries still use a bounded view on subsequent turns.
Native compaction that leaves the host transcript unchanged preserves retry
suppression. Host compaction clears or refreshes it; changing the session or
limit, falling below the limit, or growing by another full threshold also rearms
the guard.
Retained history remains available on disk and may continue growing; this is not
a storage-retention limit. For Codex
app-server sessions, the same threshold caps native rollout transcripts and
oversized native threads restart fresh.

<Warning>
The byte guard applies to the active SQLite transcript history. Legacy JSONL
checkpoint artifacts are not the active compaction target.
</Warning>

### History hydration byte limit

The embedded runtime also bounds the history it loads for model replay, independently
of token-based compaction and `maxActiveTranscriptBytes`. Its byte cap is eight times
the effective context token budget, with a 1 KiB minimum and 64 MiB maximum. This is
a resource bound on serialized model-context events, not a token count. Private
transcript metadata and tool-result details are excluded, but event envelopes and
other content can still reach the byte cap before the model's token budget is full.

When this cap is exceeded, the history loader advances the omitted prefix in
quarter-cap steps. It prefers complete turns, keeps tool calls with their results,
and reserves the latest compaction summary. The retained history starts near 75%
of the available byte capacity, subject to event and turn sizes, then grows toward
the cap. Its existing prefix stays unchanged between steps, including across
worker or process restarts. An independent event-count limit can still shorten
unusually dense histories.

This selection does not delete saved history, create a summary, run a memory
flush, or trigger compaction notifications. Older context can therefore remain
outside the model's view while the token budget has room. Chunking trades some
immediate history for prefix-cache reuse; it does not solve that byte/token
mismatch. Use `/compact` when you want semantic summarization. The normal
compaction triggers and the opt-in active-transcript byte guard are unchanged.

### Compaction notices

Routine compaction runs silently by default. A degraded summary always produces a
warning that older details, identifiers, or pending requests may be lost, and that
`/new` or a larger model can help. Set `notifyUser` to also show brief status messages
when compaction starts and completes, and when a pre-compaction memory flush is
exhausted but the reply still continues:

```json5
{
  agents: {
    defaults: {
      compaction: {
        notifyUser: true,
      },
    },
  },
}
```

### Memory flush

Before compaction, OpenClaw can run a **silent memory flush** turn to save durable context. Memory Core appends to a workspace memory file; another selected memory plugin can persist through its own tools and use declared read-only lookup tools to check existing memory first. The tools retain the source conversation's memory audience and sandbox restrictions. Missing lookup tools produce a warning but do not block persistence. If policy removes every declared persistence tool, OpenClaw skips the flush and continues compaction.

Set `agents.defaults.compaction.memoryFlush.model` when this housekeeping turn should use a local model instead of the active conversation model:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "memoryFlush": {
          "model": "ollama/qwen3:8b"
        }
      }
    }
  }
}
```

Memory flush is optional maintenance: a failure, including exhausted retries, does not reset the session or discard conversation history. If compaction is unnecessary or succeeds, OpenClaw continues the reply; with `notifyUser` enabled, exhausted flush retries also produce a degraded notice. If required compaction fails, OpenClaw reports that failure and keeps the conversation intact instead of starting over automatically.

The memory-flush model override is exact and does not inherit the active session fallback chain. See [Memory](/concepts/memory) for details and config.

## Provider and engine behavior

### Provider checkpoints

When an embedded Responses provider returns a compacted window, OpenClaw preserves the complete returned context alongside the checkpoint. Recent-turn history limits do not discard an eligible checkpoint, and the retained context still counts toward the model's prompt budget. The saved checkpoint is limited to 16 MiB; oversized or incompatible endpoint output uses the normal client-side compaction path instead of being truncated.

After a successful continuation, OpenClaw uses the provider's measured context usage when the saved request prefix still matches the current checkpoint, conversation, and provider identity. New content and current request overhead still receive a local estimate. Edited or incompatible history falls back to estimation without changing the saved conversation.

The native ChatGPT sign-in route uses streamed Codex V2 compaction at the next normal model-request boundary, including between settled tool rounds. It preserves the normal request surface and saves retained user messages plus an opaque checkpoint through the existing session owner. Failed or cancelled streams do not install a checkpoint. On this route, manual `/compact` (with or without focus instructions) and provider-confirmed overflow use client-side compaction, not V2. See [OpenAI advanced configuration](/providers/openai/advanced#server-side-compaction-responses-api) for controls and fallback behavior.

For V2-eligible requests, reply-level token maintenance and the optional mid-turn precheck defer local recovery to this boundary so they cannot preempt provider compaction. Memory flushing and transcript-byte maintenance still run. Other requests keep the provider-bound precheck, including saved checkpoint pressure when no matching current-run usage is available.

Predicted context pressure uses budget compaction before the next request. The public OpenAI Responses API and native xAI use their compact endpoint by default for budget compaction and for `/compact` without focus instructions. `params.responsesCompactEndpoint: false` disables that endpoint for a model. `/compact <focus>` keeps client-side summarization so the instructions apply. A provider-confirmed overflow keeps the client recovery path because compact endpoints also require their input to fit. Endpoint failures fall back to client-side summarization.

Once the foreground request budget is prepared, a returned endpoint window must
also fit beside its fixed instructions, tools, pending input, and reserve before
OpenClaw saves it. If retained user messages still exceed that budget,
client-side compaction selects a smaller recent tail instead of retrying the
same oversized window.

A returned window keeps recent user messages verbatim, and on xAI the system
prompt too (the public OpenAI endpoint receives it as `instructions` instead).
If [transcript redaction](/gateway/config-observability) would change any of that content,
OpenClaw skips the endpoint before calling it and uses client-side compaction.
The skip, a discarded endpoint result, and an endpoint failure are each logged
as a warning with the reason.

If the pending input alone fills the model's context window, recovery asks for a
smaller message or a larger-context model without repeatedly compacting history.
Later messages retain their normal recovery budget.

If an older version or transcript redaction removes the complete window needed for replay, OpenClaw asks you to run `/compact`. That command rebuilds context from the saved conversation through client-side compaction. It does not guess the missing provider context or delete the transcript.

Direct Anthropic API-key requests on models that Anthropic documents for threshold compaction ask the API to compact inside an ordinary request once input reaches the threshold, and OpenClaw replays the returned summary on later requests. `params.anthropicServerCompaction: false` disables it for a model. If Anthropic returns an empty summary, OpenClaw keeps sending the existing history and its client-side compaction remains the fallback. See [Anthropic server-side compaction](/providers/anthropic#advanced-configuration).

Memory flush turns disable provider server-side compaction, including Anthropic threshold compaction and OpenAI inline compaction, so memory extraction sees the unsummarized history.

### Successor transcripts

A context engine may return an explicit compacted successor session identity within the same agent, session key, and store. OpenClaw publishes the accepted successor before maintenance, hooks, or retries use it, while retaining the current writer's ownership. Cancelling afterward does not roll that completed transition back. The active reply follows the accepted identity for its remaining session-state reads; unrelated resets and cancellation still stop stale work. Tool-policy classification retains its independently captured session identity. The built-in SQLite compactor keeps the current session identity and does not create a second runtime transcript.

A [worker placement](/gateway/cloud-workers) cannot transfer ownership to a different session identity during compaction. Custom engines must keep the current identity while the placement owns the session, or the operator must move the session back to the Gateway before retrying. A rejected transition leaves the original session and worker claim intact.

OpenClaw does not create compaction checkpoint records or snapshot copies.
Existing historical transcript references remain protected by normal session
cleanup; removing checkpoint controls does not delete stored conversation history.

## Pluggable compaction providers

Plugins can register a custom compaction provider via `registerCompactionProvider()` on the plugin API. When a provider is registered and configured, OpenClaw delegates summarization to it instead of the built-in LLM pipeline.

To use a registered provider, set its id in your config:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "provider": "my-provider"
      }
    }
  }
}
```

Setting a `provider` automatically forces `mode: "safeguard"`. Providers receive the same compaction instructions and identifier-preservation policy as the built-in path, and OpenClaw still preserves recent-turn and split-turn suffix context after provider output.

The built-in quality audit and its corrective retries apply only to built-in
summarization. Configured provider output keeps the provider's existing
validation semantics.

<Note>
If the provider fails or returns an empty result, OpenClaw falls back through the built-in safeguard summarizer and its configured quality checks. Provider-local timeouts do not bypass those checks; cancellation of the compaction request is still respected.
</Note>

## Compaction vs pruning

|                  | Compaction                    | Pruning                          |
| ---------------- | ----------------------------- | -------------------------------- |
| **What it does** | Summarizes older conversation | Trims old tool results           |
| **Saved?**       | Yes (in session transcript)   | No (in-memory only, per request) |
| **Scope**        | Entire conversation           | Tool results only                |

[Session pruning](/concepts/session-pruning) is a lighter-weight complement that trims tool output without summarizing.

## Troubleshooting

**Compacting too often?** The model's context window may be small, or tool outputs may be large. Try enabling [session pruning](/concepts/session-pruning).

**Context feels stale after compaction?** Use `/compact Focus on <topic>` to guide the summary, or enable the [memory flush](/concepts/memory) so notes survive.

**Need a clean slate?** `/new` starts a fresh session without compacting.

For advanced configuration (reserve tokens, identifier preservation, custom context engines, OpenAI server-side compaction), see the [Session management deep dive](/reference/session-management-compaction).

## Related

- [Agent loop](/concepts/agent-loop): the turn lifecycle that triggers auto-compaction.
- [Session](/concepts/session): session management and lifecycle.
- [Session pruning](/concepts/session-pruning): trimming tool results.
- [Context](/concepts/context): how context is built for agent turns.
- [Context engines](/concepts/context-engine): pluggable context assembly.
- [Hooks](/automation/hooks/event-types): internal compaction events (`session:compact:before`, `session:compact:after`).
- [Plugin hooks](/plugins/hooks/reference#hook-catalog): typed compaction hooks (`before_compaction`, `after_compaction`).
- [Goal](/tools/goal) — durable per-session objectives and the `/goal` controls
