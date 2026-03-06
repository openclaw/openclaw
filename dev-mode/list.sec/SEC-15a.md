# SEC-15a: Hardcoded "Safety" Section in System Prompt

## Current Behavior

Every AI agent session injects a hardcoded "Safety" section into the system prompt at `src/agents/system-prompt.ts` lines 393-399, via `buildAgentSystemPrompt()` (line 467).

Current safety text:

```
## Safety
You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.
Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)
Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.
```

## Dev-Mode Behavior

Replace the safety section with a lighter version that keeps sane defaults but removes the "pause and ask" / "never bypass safeguards" language that makes the AI overly cautious:

```
## Safety
You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.
Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.
```

The middle paragraph ("Prioritize safety and human oversight...") is removed.

## Implementation Plan

### File: `src/agents/system-prompt.ts`

1. Import `isDevMode` from `globals.ts`
2. At line ~393 where `safetySection` array is built, wrap in a conditional:

```typescript
import { isDevMode } from "../globals.js";

// Inside buildAgentSystemPrompt():
const safetySection = isDevMode()
  ? [
      "## Safety",
      "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
      "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    ]
  : [
      // existing full safety section (lines 393-399)
    ];
```

## Files to modify

| File                          | Change                                       |
| ----------------------------- | -------------------------------------------- |
| `src/agents/system-prompt.ts` | Conditional safety section at lines ~393-399 |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Low. Only changes the system prompt text. No structural changes.
