---
summary: "Heartbeat migration, system agent, compaction, context pruning, block streaming, and typing indicators"
read_when:
  - Migrating heartbeat settings or configuring the system agent
  - Tuning auto-compaction or context pruning
  - Changing how partial replies and typing indicators are sent
title: "Configuration — agent heartbeat, compaction, and streaming"
---

`agents.defaults.*` keys that govern when an agent runs on its own, how its transcript is compacted and pruned, and how partial output reaches a chat.

## `agents.defaults.heartbeat`

Heartbeat configuration has moved to ordinary automation jobs. Run
`openclaw doctor --fix` to migrate supported `agents.defaults.heartbeat` and
`agents.entries.<id>.heartbeat` settings before starting the upgraded Gateway.
Doctor preserves the job's schedule, scratch, model policy, and delivery settings;
edit or disable the resulting job in Automations instead of restoring this key.

Use each job's `activeHours`, `idleOnly`, `payload.skipIfScratchEmpty`, and
delivery policies for monitoring. New setup provisions one ordinary proactive
check for the ambient owner; reloads and restarts do not recreate deleted jobs.
See [Heartbeat migration](/gateway/heartbeat) and
[Monitoring policies](/automation/cron-jobs/schedules#monitoring-policies).

## `agents.defaults.systemAgent`

Selects the agent whose model and credentials own ambient OpenClaw system work: system-agent and Custodian consults, and the fallback owner whenever an ambient path omits `agentId`. That includes `models.list`, `models.authStatus`, `skills.status`, and `doctor.memory.status`, the default agent directory and workspace behind auth, model-catalog, and doctor resolution, outbound channel bootstrap and queued-delivery recovery, unscoped main-session routing, Talk relay ownership, and first-run onboarding:

```json5
{
  agents: {
    defaults: {
      systemAgent: { agentId: "ops" },
    },
  },
}
```

An explicit request `agentId` always wins, followed by `systemAgent.agentId`, a legacy default owner when ownership is not explicit, and finally the sole configured agent. Retained migration provenance alone never designates an explicit fleet's runtime default. Delegated consults with a requesting agent keep that requester as their owner.

With `agents.ownership: "explicit"`, this setting also supplies the recorded default
for operations that support default-agent selection, including the agent-list
badge, unbound channel routing, unscoped Gateway reads, `openclaw sessions`,
`openclaw hooks` status, and TUI startup. Doctor records the migrated default here
so these operations keep the same owner after restart. Explicit bindings, requests,
and session-store owners take precedence. Use `--agent <id>` to select a different
agent or `openclaw sessions --all-agents` to inspect the whole fleet. Operations
that require explicit selection, such as `openclaw models`, keep that requirement.

An ownerless multi-agent fleet has no default badge. Set a configured id with
`openclaw config set agents.defaults.systemAgent.agentId <id>`. A sole configured
agent can still own unqualified Gateway session requests without a saved default
designation. Ambient work
without an owner fails with an actionable error, except queued-delivery recovery,
which records the failing delivery and keeps draining the rest of the queue.
Changing the runtime default does not relocate existing workspaces or legacy data.
Upgrade-only ownership lives at `agents.defaults.authInheritance.agentId` for
inherited credentials and `agents.defaults.sessionStore.agentId` for retired
`main` session rows or unscoped rows in a fixed `session.store`.

## `agents.defaults.compaction`

```json5
{
  agents: {
    defaults: {
      compaction: {
        enabled: false, // disable embedded proactive auto-compaction (default: true)
        mode: "safeguard", // default | safeguard
        provider: "my-provider", // id of a registered compaction provider plugin (optional)
        thinkingLevel: "low", // optional override; omit for the provider default
        timeoutSeconds: 180,
        keepRecentTokens: 50000,
        recentTurnsPreserve: 3,
        identifierPolicy: "strict", // strict | off
        qualityGuard: { enabled: true, maxRetries: 1 },
        midTurnPrecheck: { enabled: false }, // optional tool-loop pressure check
        postIndexSync: "async", // off | async | await
        postCompactionSections: ["Session Startup", "Red Lines"],
        model: "openrouter/anthropic/claude-sonnet-4-6", // optional compaction-only model override
        maxActiveTranscriptBytes: "20mb", // built-in preflight / Codex fresh-seed limit
        notifyUser: true, // notices when compaction starts/completes and on memory-flush degradation (default: false)
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
          forceFlushTranscriptBytes: "2mb",
        },
      },
    },
  },
}
```

- `enabled`: when `false`, disables threshold-driven auto-compaction inside the embedded agent runtime. OpenClaw's preflight and overflow-recovery compaction paths and manual `/compact` remain available. Default: `true`.
- `mode`: `default` or `safeguard` (summary quality audits and recent-turn preservation). See [Compaction](/concepts/compaction).
- `provider`: id of a registered compaction provider plugin. When set, the provider's `summarize()` is called instead of built-in LLM summarization. Falls back to built-in on failure. Setting a provider forces `mode: "safeguard"`. See [Compaction](/concepts/compaction).
- `thinkingLevel`: thinking level used only for embedded OpenClaw compaction summaries (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`, `ultra`, or `inherit`). When omitted, the provider can supply a compaction preference; otherwise it defaults to `low`. Native local Ollama prefers `off` so summarization does not spend its request budget on thinking. Set `inherit` to reuse the session's current thinking level, or choose an explicit level to override the provider default. The selected level is clamped to the compaction model/runtime. Native Codex app-server compaction ignores this setting because the native compact request has no per-operation thinking override; OpenClaw logs a warning when configured.
- `timeoutSeconds`: how long a built-in compaction model request may go without progress. Each request start and each streamed output token (text, reasoning or tool-call deltas; not keepalives) refreshes the window, so a slow request that keeps streaming finishes while a silent one is aborted after one window. The complete compaction stops after 10 windows (30 minutes by default) even if it keeps streaming. This also applies when a plugin context engine calls `delegateCompactionToRuntime`. Plugin-owned compaction keeps one window unless the engine explicitly declares `"onProgress"` in `info.acceptedHostParams` and reports progress through the supplied callback; that opt-in uses the same 10-window ceiling. Default: `180`.
- `keepRecentTokens`: agent cut-point budget for keeping the most recent transcript tail verbatim. Default: `20000`.
- `recentTurnsPreserve`: number of most recent user/assistant turns kept verbatim outside safeguard summarization. Default: `3`.
- `identifierPolicy`: `strict` (default) or `off`. `strict` prepends built-in opaque identifier retention guidance during compaction summarization.
- `qualityGuard`: bounded validation for built-in safeguard summaries. Enabled by default in safeguard mode. Checks the finalized summary's structure, pending asks, and exact identifiers, with at most `maxRetries` corrective attempts. If audits are exhausted or required facts cannot fit, OpenClaw stores the best available summary marked `details.qualityDegraded` so the session can continue. A failed corrective generation can reuse an earlier summary. Retention is best-effort on this path; `/status` shows degradation and the user receives a warning even when `notifyUser` is `false`. See [Compaction](/concepts/compaction#how-it-works) for losses and the separate automatic timeout fallback. Set `enabled: false` to skip the audit. Configured compaction-provider output keeps its provider-owned validation behavior.
- `midTurnPrecheck`: optional estimated-pressure threshold between tool rounds, disabled by default. Enabling it reserves configured compaction headroom against the prepared request estimate. Independently, provider-measured usage triggers client maintenance at the smaller of 75% of the window and the reserve-based threshold, and every embedded request is checked against the full window. Matching prior provider usage accounts for the covered prefix; only pending items are estimated. Text uses CJK-aware sizing, and dense encoded data receives separate density accounting. Over-window requests stop before submission and reuse safe truncation or compaction recovery. Works with `default` and `safeguard` modes; unsettled tools and unsafe replay still prevent forced compaction.
- `postIndexSync`: post-compaction session-memory reindex mode. Default: `"async"`. Use `"await"` for strongest freshness, `"async"` for lower compaction latency, or `"off"` only when session-memory sync is handled elsewhere. Async mode starts indexing before compaction returns but does not wait for it to finish; cold memory initialization can still add latency.
- `postCompactionSections`: optional AGENTS.md H2/H3 section names to re-inject after compaction. Safeguard summaries read these sections from the effective agent workspace and log a warning if the file cannot be read or configured sections are missing. Leave unset or use `[]` to disable.
- `model`: optional `provider/model-id` or bare alias from `agents.defaults.models` for compaction summarization only. Bare aliases resolve before dispatch; configured literal model IDs retain precedence on collisions. Use this when the main session should keep one model but compaction summaries should run on another; when unset, compaction uses the session's primary model.
- `maxActiveTranscriptBytes`: optional positive bytes or a size string such as `"20mb"`. For the built-in runtime, triggers preflight compaction when the active transcript window (since the last compaction/reset, including its kept tail) reaches the limit. Direct Anthropic API-key routes discount cleared temporary runtime-context contents; raw storage and history hydration limits remain unchanged. For [Codex app-server](/plugins/codex-harness-runtime/compaction), bounds fresh-thread seeds instead of triggering ordinary-turn host compaction. Unset or `0` disables the guard. Owning engines can return a compacted successor identity; the built-in SQLite compactor keeps the current identity.
- `notifyUser`: when `true`, sends brief context-maintenance notices to the user: when compaction starts and completes (for example, "Compacting context..." and "Compaction complete"), and when a pre-compaction memory flush is exhausted so the reply continues in a degraded state (for example, "Memory maintenance temporarily failed; continuing your reply."). Disabled by default. A degraded-summary warning is always shown, regardless of this setting.
- `memoryFlush`: silent agentic turn before auto-compaction to store durable memories. The host resolves these settings with the active context window and fills timing fields that the selected memory provider omits from its plan. The flush uses the active session model and its normal fallback chain. `forceFlushTranscriptBytes` forces the flush when the model-visible transcript window reaches the threshold even if token counters are stale; after compaction, that window includes the retained tail and subsequent turns rather than discarded history. File-arm providers require writable workspace access; tools-arm providers do not.

Custom compaction instructions are code-owned. Implement a compaction provider
plugin with `summarize()` for custom summary construction, and use
`before_prompt_build` when post-compaction context must be injected into later
model prompts. Doctor strips the retired instruction fields and points to these
hooks.

## `agents.defaults.contextPruning`

Prunes **old tool results** from in-memory context before sending to the LLM. Does **not** modify session history on disk. Disabled by default; set `mode: "cache-ttl"` to enable.

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl", // off (default) | cache-ttl
        ttl: "1h", // duration string; bare numbers are minutes (default 5m)
        tools: { allow: [], deny: [] }, // tool names eligible for / excluded from pruning
        hardClear: {
          enabled: true, // false skips the hard-clear step
          placeholder: "[Old tool result content cleared]",
        },
      },
    },
  },
}
```

<Accordion title="cache-ttl mode behavior">

- `mode: "cache-ttl"` enables pruning passes.
- `ttl` sets how long a cache entry is considered fresh before a new pruning round can start. It is a duration string whose bare numbers are minutes; the built-in default is 5 minutes, and the bundled Anthropic plugin seeds `1h`.
- `tools.allow` and `tools.deny` scope which tool names are prunable.
- `hardClear.enabled: false` skips the hard-clear step, and `hardClear.placeholder` replaces the default `[Old tool result content cleared]` text.
- Pruning soft-trims oversized tool results first, then hard-clears older tool results if needed.

**Soft-trim** keeps beginning + end and inserts `...` in the middle.

**Hard-clear** replaces the entire tool result with the placeholder.

Notes:

- Image blocks are never trimmed/cleared.
- Ratios are character-based (approximate), not exact token counts.
- The most recent assistant messages are preserved.

</Accordion>

See [Session Pruning](/concepts/session-pruning) for behavior details.

## Block streaming

```json5
{
  agents: {
    defaults: {
      blockStreamingDefault: "off", // on | off
      blockStreamingBreak: "text_end", // text_end | message_end
      blockStreamingChunk: { minChars: 800, maxChars: 1200, breakPreference: "paragraph" },
      blockStreamingCoalesce: { idleMs: 1000 },
      humanDelay: { mode: "natural" }, // off (default) | natural | custom (use minMs/maxMs)
    },
  },
}
```

- Non-Telegram channels require explicit `*.streaming.block.enabled: true` to enable block replies. QQ Bot is the exception: it has no `streaming.block` keys and streams block replies unless `channels.qqbot.streaming.mode` is `"off"`.
- Channel overrides: `channels.<channel>.streaming.block.coalesce` (and per-account variants). Discord, Google Chat, Mattermost, MS Teams, Signal, and Slack default `minChars: 1500` / `idleMs: 1000`.
- `blockStreamingChunk.breakPreference`: preferred chunk boundary (`"paragraph" | "newline" | "sentence"`).
- `humanDelay`: randomized pause between block replies. Default: `off`. `natural` = 800-2500ms. `custom` uses `minMs`/`maxMs` (falls back to the natural range for any unset bound). Per-agent override: `agents.entries.*.humanDelay`.

See [Streaming](/concepts/streaming) for behavior + chunking details.

## Typing indicators

```json5
{
  agents: {
    defaults: {
      typingMode: "instant", // never | instant | thinking | message
      typingIntervalSeconds: 6,
    },
  },
}
```

- Defaults: `instant` for direct chats/mentions, `message` for unmentioned group chats.
- `typingIntervalSeconds` default: `6`.
- Per-agent override: `agents.entries.*.typingMode`.

See [Typing Indicators](/concepts/typing-indicators).
