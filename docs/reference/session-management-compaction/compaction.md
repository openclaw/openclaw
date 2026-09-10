---
summary: "What compaction does, when auto-compaction runs, its settings, pluggable providers, and where it surfaces"
read_when:
  - 'You are changing auto-compaction behavior or adding "pre-compaction" housekeeping'
  - "Tuning compaction thresholds, reserves, or a compaction provider plugin"
title: "Compaction behavior and settings"
---

## Context windows vs tracked tokens

Two different concepts:

1. **Model context window**: hard cap per model (tokens visible to the model). Comes from the model catalog and can be overridden via config.
2. **Session store counters**: rolling stats written into the session row (used for `/status` and dashboards). `contextTokens` is a runtime estimate/reporting value - do not treat it as a strict guarantee.

Completed turns update session counters even when no compaction occurred. An ordered context replacement takes precedence over earlier model usage; if its size is unknown, the counters are marked stale instead of borrowing an older request's total. A superseded run cannot overwrite the current writer's counters.

More on limits: [/reference/token-use](/reference/token-use).

## Compaction: what it is

Compaction summarizes older conversation into a persisted `compaction` entry in the transcript and keeps recent messages intact. After compaction, future turns see the compaction summary plus messages after `firstKeptEntryId`. Compaction is **persistent**, unlike session pruning - see [/concepts/session-pruning](/concepts/session-pruning).

Embedded OpenClaw compaction uses the provider's compaction thinking preference, falling back to `low`. Native local Ollama prefers `off` to keep summarization within its request budget. Set `agents.defaults.compaction.thinkingLevel: "inherit"` to reuse the session level, or choose an explicit level for summary calls; the runtime clamps it to each concrete compaction model or fallback. Native Codex app-server compaction owns its compact request and cannot accept a per-compaction thinking override, so OpenClaw warns and leaves that setting to Codex.

Each summarization request uses one primary format. Safeguard history summaries use its structured checkpoint format, while split-turn prefixes use the prefix format. Operator focus and identifier-preservation guidance remain additional instructions; they do not add a competing set of required headings.

AGENTS.md section reinjection after compaction remains opt-in via `agents.defaults.compaction.postCompactionSections`. Plugins can add other prompt context through `before_prompt_build`.

### Chunk boundaries and tool pairing

When splitting a long transcript into compaction chunks, OpenClaw keeps assistant tool calls paired with their matching `toolResult` entries:

- If the token-share split would land between a tool call and its result, OpenClaw shifts the boundary to the assistant tool-call message instead of separating the pair.
- If a trailing tool-result block would otherwise push the chunk over target, OpenClaw preserves that pending tool block and keeps the unsummarized tail intact.
- Aborted/error tool-call blocks do not hold a pending split open.

## When auto-compaction happens

The built-in OpenClaw runtime has three scheduling paths:

1. **Overflow recovery**: the model returns a context-overflow error (`request_too_large`, `context length exceeded`, `input exceeds the maximum number of tokens`, `input token count exceeds the maximum number of input tokens`, `input is too long for the model`, `ollama error: context length exceeded`, and other provider-shaped variants) - compact, then retry. When the provider reports the attempted token count, OpenClaw forwards that observed count into overflow-recovery compaction; if the provider confirms overflow but exposes no parseable count, OpenClaw passes a minimally over-budget synthetic count to compaction engines and diagnostics. If overflow recovery still fails, OpenClaw surfaces explicit guidance and preserves the current session mapping instead of silently rotating to a fresh session id - retry the message, run `/compact`, or run `/new`.

   One provider shape is terminal rather than compaction-recoverable. When the refusal states a single request larger than the provider's entire token limit - Groq answers an oversized request with an HTTP 413 naming TPM and stating `Limit <n>, Requested <m>` - no bucket state can admit it. Compaction budgets against the model's context window rather than that per-request ceiling, and its own summarization request is refused by the same ceiling, so it can only spend further calls that cannot succeed. OpenClaw surfaces the reset guidance immediately instead of compacting, adopting a successor transcript, or retrying. Ordinary TPM throttling, which states a requested size within the limit, stays a rate limit and keeps its normal backoff.

2. **Usage-based maintenance**: replies and direct commands using OpenClaw's managed loop check projected usage before inference. Required memory checkpointing precedes compaction at or above the active model window minus the selected compaction reserve, subject to an applicable server compaction threshold floor. Successful Gateway commands using that loop also schedule optional maintenance after delivering their completed reply; one-shot local commands skip that optional work. Generic CLI backends retain their existing host compaction before delivery, and native backends retain their own compaction policy. The memory-flush soft margin does not lower the blocking threshold. Disabling memory flush does not disable compaction. Direct-command maintenance respects `compaction.enabled: false` and skips a second post-turn compaction when the completed run already compacted.
3. **Session-internal threshold maintenance**: default-mode sessions can also compact when actual context usage exceeds the model window minus the session reserve. Safeguard mode disables this competing session-internal path and leaves proactive scheduling to the maintenance owner above.

The persisted `contextBudgetStatus` is a pre-prompt pressure estimate, not an execution command. Completed direct commands, normal replies, and queued follow-up replies record it when the runtime supplies one. `/status` can show this estimate, marked with `~` and `est`, when fresh token usage is unavailable. Compaction and session resets invalidate old estimates; a completed run without a diagnostic clears the previous one unless that run preserves the session's model state (for example, a heartbeat). Its `route` and `shouldCompact` fields can report pressure while the provider attempt is still admitted. Use completed compaction counts and transcript entries to verify that compaction actually happened.

Two additional guards run outside these paths:

- **Preflight local compaction**: set `agents.defaults.compaction.maxActiveTranscriptBytes` to a positive byte threshold (bytes or a string like `"20mb"`) to trigger local compaction before opening the next run once the active transcript reaches that size. Normal semantic compaction still runs. For Codex app-server sessions, the same threshold caps native rollout transcripts and oversized native threads restart fresh. Unset or `0` disables the guard.
- **Mid-turn precheck**: set `agents.defaults.compaction.midTurnPrecheck.enabled: true` (default `false`) to add a tool-loop guard. After a tool result is appended and before the next model call, OpenClaw estimates prompt pressure using the same preflight budget logic used at turn start. If context no longer fits, the guard does not compact inline - it raises a structured mid-turn precheck signal, stops the current prompt submission, and lets the outer run loop use the existing recovery path (truncate oversized tool results when that is enough, or trigger the configured compaction mode and retry). Works with both `default` and `safeguard` compaction modes, including provider-backed safeguard compaction. Independent of `maxActiveTranscriptBytes`: the byte-size guard runs before a turn opens, mid-turn precheck runs later, after new tool results are appended.

## Compaction settings

```json5
{
  agents: {
    defaults: {
      compaction: {
        enabled: true,
        keepRecentTokens: 20000,
      },
    },
  },
}
```

OpenClaw enforces a built-in reserve for embedded runs and caps it at one quarter of the active model context window. The default reserve remains 20,000 tokens for windows of 80,000 tokens or larger. Smaller windows retain at least three quarters of their capacity for prompts and conversation, while the reserve leaves room for compaction summaries and housekeeping such as the memory flush.

Optional maintenance for chat replies and managed Gateway agent commands has a
fresh session owner and shares the turn's remaining timeout allowance across
memory flushing and compaction. It starts after actual delivery and persistence
settle, even if the bounded follow-up admission wait has already expired.
The completed reply returns first. A new foreground turn cancels and settles
optional maintenance before acquiring the session lane. Restart and session
replacement also cancel stale work. Accepted compaction commits remain accounted
for, and an unlimited command timeout remains unlimited. One-shot local commands using OpenClaw's managed loop
record an intentional skip without marking a memory flush successful.

Set `enabled: false` to disable threshold-driven auto-compaction inside the embedded agent runtime and direct-command post-turn maintenance. OpenClaw's reply preflight and overflow-recovery compaction paths remain available, and manual `/compact` continues to work.

Manual `/compact` uses `agents.defaults.compaction.keepRecentTokens` (default: `20000`) and keeps that recent-tail cut point.

OpenClaw adopts an explicit successor identity returned by a context engine. The built-in SQLite compactor keeps the current session identity. Branch/restore checkpoint actions use a returned successor when present; legacy pre-compaction checkpoint files remain readable while referenced.

## Pluggable compaction providers

Plugins register a compaction provider via `registerCompactionProvider()` on the plugin API. When `agents.defaults.compaction.provider` is set to a registered provider id, the safeguard extension delegates summarization to that provider instead of the built-in `summarizeInStages` pipeline.

- `provider`: id of a registered compaction provider plugin. Leave unset for default LLM summarization. Setting a `provider` forces `mode: "safeguard"`.
- Providers receive the same compaction instructions and identifier-preservation policy as the built-in path, and the safeguard still preserves recent-turn and split-turn suffix context after provider output.
- Built-in safeguard summarization re-distills prior summaries with new messages instead of preserving the full previous summary verbatim.
- Safeguard mode enables built-in summary quality audits by default. After final budgeting, the retained generated body must contain the required headings, and the exact artifact to be persisted must retain pending asks and exact identifiers. Corrective attempts stay within `qualityGuard.maxRetries`; exhaustion or a corrective generation failure cancels before append and leaves the original transcript authoritative. Set `qualityGuard.enabled: false` to skip this behavior. Configured compaction-provider output remains outside the built-in audit loop.
- If the provider fails or returns an empty result, OpenClaw falls back to built-in LLM summarization automatically. Provider-local failures, including timeouts, stay in that guarded fallback and use the built-in quality audit when enabled. Abort/timeout signals the caller explicitly triggered are re-thrown, not swallowed, so cancellation is always respected.

Source: `src/plugins/compaction-provider.ts`, `src/agents/agent-hooks/compaction-safeguard.ts`.

## User-visible surfaces

- `/status` in any chat session
- `openclaw status` (CLI)
- `openclaw sessions` / `openclaw sessions --json`
- Gateway logs (`pnpm gateway:watch` or `openclaw logs --follow`): `embedded run auto-compaction start` + `complete`
- Verbose mode: `🧹 Auto-compaction complete` plus the compaction count
