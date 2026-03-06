# RFC: Self-Escalation Tool

**Author:** Anton Eicher
**Status:** Implemented
**Date:** 2026-03-06

## Problem

Lighter models (Haiku, Sonnet) handle most messages well, but occasionally encounter tasks that need deeper reasoning. A naive approach would be to classify each message before the model runs and route it to the right tier, but that adds latency to every request and an external classifier can't judge task complexity as well as the model doing the work.

## Solution

Replace the pre-turn classifier with a **self-escalation tool**. When an escalation model is configured, lighter models receive an `escalate` tool they can invoke as their first action. The tool sets a pending-escalation flag; after the run completes normally, the agent loop detects the flag and re-runs the same prompt on the escalation model.

This is simpler and more accurate: the model doing the work is the best judge of whether it can handle the task.

## Config

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "bedrock/eu.anthropic.claude-haiku-4-5-20251001-v1:0",
        escalation: "bedrock/eu.anthropic.claude-opus-4-6",
      },
    },
  },
}
```

When `escalation` is set and the current model is not the escalation target, the `escalate` tool is registered. When `escalation` is absent, no tool is registered and the feature is invisible.

## How it works

```
Incoming message
  -> agent loop starts with primary model (e.g. Haiku)
  -> model assesses task complexity
  -> IF simple: model responds normally
  -> IF complex: model calls escalate(reason: "...")
      -> tool sets pendingEscalations[sessionKey]
      -> model finishes its turn (typically a brief acknowledgement)
      -> agent loop detects pending escalation flag
      -> loop switches provider/model to escalation target
      -> loop re-runs the same prompt on escalation model
      -> escalation model responds normally
```

Escalation is one-shot per turn (`didEscalate` flag) to prevent loops.

## Key files

| File                                             | Role                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `src/agents/tools/escalate-tool.ts`              | Tool definition, `pendingEscalations` map, `resolveEscalationModel()` config parser                           |
| `src/agents/tools/escalate-tool.test.ts`         | Unit tests for tool and resolver                                                                              |
| `src/agents/pi-embedded-runner/run/attempt.ts`   | Registers the tool when escalation is configured and current model is not the target                          |
| `src/auto-reply/reply/agent-runner-execution.ts` | `tryHandleEscalation()` detects pending escalation in success and error paths, switches model, continues loop |
| `src/config/types.agents-shared.ts`              | `AgentModelConfig.escalation` field                                                                           |
| `src/config/types.agent-defaults.ts`             | `AgentModelListConfig` derived from `AgentModelConfig` (picks up escalation field)                            |
| `src/config/zod-schema.agent-model.ts`           | Zod validation for escalation field                                                                           |
| `src/auto-reply/reply/get-reply-directives.ts`   | Threads `sessionKey` through to agent runner for escalation tracking                                          |
| `src/auto-reply/reply/get-reply.ts`              | Passes `agentId` and `sessionKey` to execution layer                                                          |

## Trade-offs

**Pros:**

- Zero added latency for messages that don't escalate
- The model itself decides -- more accurate than an external classifier
- Simple implementation (~200 lines of new code)
- No new config concepts -- just one `escalation` field

**Cons:**

- Escalated turns consume some tokens on the initial model call (which completes before handoff)
- Only supports one escalation target (no tiered routing)
- Model must be well-prompted to escalate early (before generating text)
