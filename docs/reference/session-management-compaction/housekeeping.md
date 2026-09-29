---
summary: "The NO_REPLY silent-turn contract and the pre-compaction memory flush configuration"
read_when:
  - "You want to implement memory flushes or silent system turns"
  - "Tuning agents.defaults.compaction.memoryFlush"
title: "Silent turns and the memory flush"
---

## Silent housekeeping (`NO_REPLY`)

OpenClaw supports "silent" turns for background tasks where the user should not see intermediate output.

- The assistant starts its output with the exact silent token `NO_REPLY` / `no_reply` to mean "do not deliver a reply to the user." OpenClaw strips/suppresses this in the delivery layer.
- Exact silent-token suppression is case-insensitive: `NO_REPLY` and `no_reply` both count when the whole payload is just the silent token.
- As of `2026.1.10`, OpenClaw also suppresses draft/typing streaming when a partial chunk begins with `NO_REPLY`, so silent operations do not leak partial output mid-turn.
- This is for true background/no-delivery turns only - it is not a shortcut for ordinary actionable user requests.

## Pre-compaction memory flush

Before auto-compaction happens, OpenClaw can run a silent agentic turn that writes durable state to disk (for example `memory/YYYY-MM-DD.md` in the agent workspace) so compaction cannot erase critical context. It monitors session context usage, and once it crosses a soft threshold below the compaction threshold, it sends a silent "write memory now" directive using the exact silent token `NO_REPLY` / `no_reply` so the user sees nothing.

Memory flushing runs against a private, detached view of the conversation. Its
internal prompts and replies never enter the original transcript, including when
a new user message interrupts it. Memory-file writes remain durable. Required
preflight excludes the already-admitted waiting user; post-reply flushing includes
the completed turn. Any compaction inside the flush affects only its private view;
the original conversation has a separate compaction step.

Config (`agents.defaults.compaction.memoryFlush`), full reference at [/gateway/config-agents](/gateway/config-agents/heartbeat-compaction-and-streaming#agents-defaults-compaction):

| Key                         | Default | Notes                                                                                                                                                  |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                   | `true`  |                                                                                                                                                        |
| `model`                     | unset   | exact provider/model override for the flush turn only, for example `ollama/qwen3:8b`                                                                   |
| `softThresholdTokens`       | `4000`  | gap below the compaction threshold that triggers a flush                                                                                               |
| `forceFlushTranscriptBytes` | `"2mb"` | force a flush once active transcript history reaches this estimated byte size (or string like `"2mb"`), even if token counters are stale; `0` disables |

For a 32,768-token window, the built-in plan uses an 8,192-token reserve and a
4,000-token soft margin. Early flushing starts at 20,576 projected tokens. Blocking
token compaction starts at 24,576, or later if an applicable server threshold is higher. Between those
thresholds, memory flushing can run without requiring compaction.
The selected memory provider owns the reserve and flush margin; without a flush
plan, maintenance still uses the effective compaction reserve. Nonpositive
thresholds suppress token triggers. Transcript byte guards remain independent.

When memory flush refreshes stale usage, it includes projected messages appended
after the latest valid provider usage report before saving the total as fresh.
The following compaction check therefore accounts for that later transcript growth.

Notes:

- The built-in prompt and system prompt include a `NO_REPLY` hint to suppress delivery.
- When `model` is set, the flush turn uses that model without inheriting the active session's fallback chain, so local-only housekeeping does not silently fall back to a paid conversation model on failure.
- The flush runs once per compaction cycle (tracked in the session row).
- The flush runs only for embedded OpenClaw sessions; CLI backends and heartbeat turns skip it.
- The flush is skipped when the session workspace is read-only (`workspaceAccess: "ro"` or `"none"`).
- See [Memory](/concepts/memory) for the workspace file layout and write patterns.

OpenClaw exposes a `session_before_compact` hook in the extension API, but the flush logic above lives on the Gateway side (`src/auto-reply/reply/memory-flush.ts`, `src/auto-reply/reply/agent-runner-memory.ts`), not on that hook.
