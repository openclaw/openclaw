---
summary: "Opt-in runtime training data export that produces episode-level JSONL from compaction, session reset, and trajectory export triggers"
read_when:
  - Enabling or configuring the training export feature
  - Understanding the trigger architecture and episode format
  - Debugging training export output or missing episodes
  - Reviewing the privacy and retention implications of unredacted training data
title: "Training Export"
---

# Training Export

## Overview

The training export system produces episode-level JSONL training data from the OpenClaw runtime trajectory. Each line in the output file is a self-contained training sample — either a **task episode** capturing an agent turn, or a **compact-summary episode** capturing how the agent compresses conversation context.

**Output:** `~/.openclaw/training-export/episodes.jsonl`

### Design Principles

- **Trajectory-first.** All training-required fields (system prompt, messages, tools, model metadata) are sourced from runtime trajectory events, not reconstructed offline.
- **Trigger-driven.** Export is invoked at well-defined trigger points (compaction hooks, session reset, manual export command). No separate offline pipeline.
- **Provider-owned conversion.** Message and tool conversion delegates to the Pi SDK / provider layer wherever possible, minimizing duplicated conversion logic.
- **Unified compaction hook.** Training export for all compaction modes streams through a single pair of Pi SDK hooks (`session_before_compact` + `session_compact`), rather than being called from individual compaction paths.
- **Pair-export guarantee.** For compaction-triggered exports, a task episode and a compact-summary episode must appear as a complete pair. If either is filtered by quality checks, the entire batch is discarded.
- **Config-gated at call sites.** Callers check `trainingExport.enabled` before invoking export, so the intent is visible at every entry point without digging into implementation details.

---

## Trigger Architecture

### Compaction Hooks (Primary Trigger)

The training export extension registers two Pi SDK hooks that fire for **all** compaction modes:

| Hook                     | When                       | Action                                                          | Coverage                                      |
| ------------------------ | -------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| `session_before_compact` | Before compaction executes | Stash pre-compaction snapshot + Pi SDK `preparation` (no write) | default, safeguard, manual                    |
| `session_compact`        | After compaction completes | Validate summary, build task + summary pair, write              | default, safeguard, manual, overflow, timeout |

**Pair-export flow:**

1. `session_before_compact` — stash the current runtime snapshot and Pi SDK's `preparation` object (which provides `messagesToSummarize`, `previousSummary`, and `customInstructions`)
2. `session_compact`:
   - If the compaction summary is empty (boundary-only compaction where `keepRecentTokens` covers all messages) → discard stash, no export
   - If the summary is valid → build both episodes; if **either** is filtered by quality checks, discard the entire batch
   - On success → atomically write both episodes

### Non-Compaction Triggers

| Trigger             | Call Site                                            | Exports      |
| ------------------- | ---------------------------------------------------- | ------------ |
| `before_reset`      | `src/gateway/session-reset-service.ts`               | task episode |
| `trajectory_export` | `src/auto-reply/reply/commands-export-trajectory.ts` | task episode |

Both call sites guard on `getTrainingExportConfig(cfg)?.enabled === true` before calling `runTrainingExport`.

### Extension Registration

The extension is registered in `src/agents/pi-embedded-runner/extensions.ts`, gated on `trainingExport.enabled`:

```typescript
if (getTrainingExportConfig(params.cfg)?.enabled === true) {
  setCompactionTrainingExportRuntime(params.sessionManager, params.cfg ?? null);
  factories.push(compactionTrainingExportExtension);
}
```

---

## Episode Types

### Task Episode

Triggered by `on_compaction` (without `compactionEntry`), `before_reset`, or `trajectory_export`.

Built from the runtime snapshot collected from the latest `context.compiled` trajectory event:

- System prompt
- Runtime messages (with trailing non-assistant messages trimmed for `on_compaction` — see below)
- Runtime tools
- Model metadata and trace info

**Trailing trim.** For all trigger types, if the snapshot ends mid-turn at a non-`assistant` message (e.g. `toolResult`), trailing non-`assistant` messages are removed. The `trainExampleMessagesAreUsable` check requires ≥1 user + ≥1 assistant; if trimming leaves the episode unusable, it is discarded. This is a training-data quality requirement, not a trigger-specific behavior.

### Compact-Summary Episode

Triggered by `on_compaction` (with `compactionEntry`).

Payload is built from the Pi SDK `preparation` object stashed during `session_before_compact`:

| Field          | Source                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------- |
| `systemPrompt` | `COMPACT_SUMMARIZATION_SYSTEM_PROMPT` (local constant)                                    |
| `promptText`   | `buildCompactSummaryPrompt({ messagesToSummarize, previousSummary, customInstructions })` |
| `responseText` | `compactionEntry.summary`                                                                 |
| `compaction`   | `tokensBefore`, `firstKeptEntryId`, `fromExtension`                                       |

**Empty-summary guard.** When `messagesToSummarize` is empty (short conversations where `keepRecentTokens` covers all messages), `serializeCompactSummaryConversation` returns an empty string, producing `<conversation>\n\n</conversation>`. The `compactConversationTextIsNonEmpty` regex (`/<conversation>\s*[\s\S]*\S[\s\S]*<\/conversation>/`) requires at least one non-whitespace character between the tags, so the summary episode fails validation and is filtered. Combined with pair-export, both task and summary episodes are correctly discarded for this boundary case.

---

## Message Conversion Pipeline

Messages are converted via the `chat_completions` format pipeline:

```
runtime messages (Pi SDK format)
  ↓
1. Pre-process (single map over messages)
   a. Strip thinking blocks from assistant messages
   b. Convert compactionSummary → user message
  ↓
2. Upstream convertMessages() from @mariozechner/pi-ai/openai-completions
  ↓
3. adaptChatCompletionsMessagesToExportMessages()
  ↓
4. Append reasoning_content (scanned from original runtimeMessages)
  ↓
5. developer role → system role (training format compatibility)
```

### Why CompactionSummary Conversion is Needed

Pi SDK's `convertToLlm` (`@mariozechner/pi-coding-agent/dist/core/messages.js:103-108`) converts `compactionSummary` messages to user messages with wrapper text. However, the upstream `convertMessages` from `@mariozechner/pi-ai/openai-completions` does **not** handle the `compactionSummary` role. Without pre-processing, compaction summary messages are silently dropped from task episodes, losing critical context.

The pre-processing step mirrors Pi SDK's conversion format:

```
The conversation history before this point was compacted into the following summary:

<summary>
{summary text}
</summary>
```

---

## Configuration

```typescript
interface TrainingExportConfig {
  enabled?: boolean; // default: false (opt-in)
  compat?: ModelCompatConfig; // model compatibility overrides for export
}
```

The `enabled` check is applied at every entry point (call sites + extension registration).

---

## Trigger Types

| Kind                | Scenario              | Distinction                                                       |
| ------------------- | --------------------- | ----------------------------------------------------------------- |
| `on_compaction`     | Compaction event      | Has `compactionEntry` → summary episode; otherwise → task episode |
| `before_reset`      | Session reset         | task episode                                                      |
| `trajectory_export` | Manual export command | task episode                                                      |

---

## Key Files

| File                                                 | Responsibility                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/training-export.ts`                             | Core: snapshot collection, episode construction, JSONL I/O, prompt constants, compaction extension (merged from `compaction-summary-prompt.ts` and `compaction-training-export.ts`) |
| `src/agents/pi-embedded-runner/extensions.ts`        | Extension registration (config-gated)                                                                                                                                               |
| `src/agents/pi-hooks/compaction-safeguard.ts`        | Safeguard compaction logic (no longer contains training export calls)                                                                                                               |
| `src/agents/pi-embedded-runner/compact.ts`           | Manual compaction (no longer contains training export calls)                                                                                                                        |
| `src/gateway/session-reset-service.ts`               | `before_reset` trigger → `runTrainingExport`                                                                                                                                        |
| `src/auto-reply/reply/commands-export-trajectory.ts` | `trajectory_export` trigger → `runTrainingExport`                                                                                                                                   |

---
