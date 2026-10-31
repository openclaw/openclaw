---
summary: "The NO_REPLY silent-turn contract and the pre-compaction memory flush configuration"
read_when:
  - "You want to implement memory flushes or silent system turns"
  - "Tuning agents.defaults.compaction.memoryFlush"
title: "Silent turns and the memory flush"
---

## Silent housekeeping (`NO_REPLY`)

OpenClaw supports "silent" turns for background tasks where the user should not see intermediate output.

- The assistant returns an entire final that trims to uppercase `NO_REPLY` to request no user-visible text. Lowercase, punctuation, quotes, JSON, and trailing tokens remain visible.
- The terminal producer records the decision and prepares output once; delivery and clients consume that fact instead of parsing text. One literal leading `NO_REPLY\n` removes only that control line and preserves the remainder as visible text.
- Streaming control buffering belongs to producer preparation, so a possible control line does not leak into drafts or typing activity.
- Use this for intentional silence, not missing output. External turns honor it even when a reply was required; internal result-required turns still need an answer.

## Pre-compaction memory flush

Before auto-compaction happens, OpenClaw can run a silent agentic turn that
persists durable state through the selected memory provider so compaction cannot
erase critical context. Memory Core writes `memory/YYYY-MM-DD.md` in the agent
workspace; other providers can expose their own persistence tools. OpenClaw
monitors session context usage, and once it crosses a soft threshold below the
compaction threshold, it sends a silent "write memory now" directive using the
exact silent token `NO_REPLY` so the user sees nothing.

Memory flushing runs against a private, detached view of the conversation. Its
internal prompts and replies never enter the original transcript, including when
a new user message interrupts it. Memory-file writes remain durable. Required
preflight excludes the already-admitted waiting user; post-reply flushing includes
the completed turn. Any compaction inside the flush affects only its private view;
the original conversation has a separate compaction step.

When a provider rejects an oversized prompt, the reply owner also attempts this
checkpoint before recovery compaction, unless preflight already attempted it in
the same turn. It uses the active session model and the same context budget. This
recovery checkpoint disables automatic SDK, provider-native, and overflow-recovery
compaction: if the conversation does not fit, it fails and recovery continues. Gateway logs record completed,
skipped, and failed checkpoint outcomes before compaction.

Config (`agents.defaults.compaction.memoryFlush`), full reference at [/gateway/config-agents](/gateway/config-agents/heartbeat-compaction-and-streaming#agents-defaults-compaction):

| Key                         | Default | Notes                                                                                                                                                  |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                   | `true`  |                                                                                                                                                        |
| `softThresholdTokens`       | `4000`  | gap below the compaction threshold that triggers a flush                                                                                               |
| `forceFlushTranscriptBytes` | `"2mb"` | force a flush once active transcript history reaches this estimated byte size (or string like `"2mb"`), even if token counters are stale; `0` disables |

The host resolves the reserve, soft margin, and transcript-byte guard
from this config and the active context window before it asks the selected
memory provider for flush content and persistence. Providers inherit those
values unless they deliberately override an optional timing field in their
plan. When `enabled` is `false`, the host skips the provider resolver. Without a
flush plan, maintenance still uses the effective compaction reserve.

The default 20,000-token reserve is capped at one quarter of the context window.
The default 4,000-token soft margin is capped at half the window left after that
reserve. For a 32,768-token window, the host therefore uses an 8,192-token
reserve and a 4,000-token soft margin. Early flushing starts at 20,576 projected
tokens. Blocking token compaction starts at 24,576, or later if an applicable
server threshold is higher. Between those thresholds, memory flushing can run
without requiring compaction. The transcript-byte guard defaults to 2 MiB and
remains independent. Nonpositive thresholds suppress their trigger.

When memory flush refreshes stale usage, it includes projected messages appended
after the latest valid provider usage report before saving the total as fresh.
The following compaction check therefore accounts for that later transcript growth.

Notes:

- The built-in prompt and system prompt include a `NO_REPLY` hint to suppress delivery.
- The flush uses the active session model and its normal fallback chain. Use a local session model and local fallbacks to keep memory extraction local.
- The flush runs once per compaction cycle (tracked in the session row).
- The flush runs only for embedded OpenClaw sessions; CLI backends and heartbeat turns skip it.
- Memory Core's file flush is skipped when the session workspace is read-only (`workspaceAccess: "ro"` or `"none"`). A tools-arm provider does not require writable workspace access.
- See [Memory](/concepts/memory) for the workspace file layout and write patterns.

OpenClaw exposes a `session_before_compact` hook in the extension API, but the
flush logic above lives on the Gateway side
(`src/auto-reply/reply/memory-flush-plan.ts`,
`src/auto-reply/reply/memory-flush.ts`, and
`src/auto-reply/reply/agent-runner-memory.ts`), not on that hook.
