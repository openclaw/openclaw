# SEC-79: ACP Prompt Text Payload Size Bound (2 MiB)

## Current Behavior

ACP prompt payloads are capped at 2 MiB. Larger prompts are rejected.

- `src/acp/translator.ts` line 44: `const MAX_PROMPT_BYTES = 2 * 1024 * 1024`
- `src/acp/translator.ts` line 249: `extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES)`
- `src/acp/translator.ts` line 256: Size check before message serialization
- `src/acp/event-mapper.ts` lines 59-88: Additional validation

## Dev-Mode Behavior

When `--dev-mode`, remove or greatly increase the ACP payload size bound to allow large context payloads.

## Implementation Plan

### File: `src/acp/translator.ts`

1. Import `isDevMode` from `globals.ts`
2. Make the constant dynamic:

```typescript
import { isDevMode } from "../globals.js";

const MAX_PROMPT_BYTES = isDevMode()
  ? 50 * 1024 * 1024 // 50MB in dev mode
  : 2 * 1024 * 1024; // 2MB default
```

**Note:** If `MAX_PROMPT_BYTES` is used at module load time (before `setDevMode` runs), use a function instead:

```typescript
function getMaxPromptBytes(): number {
  return isDevMode() ? 50 * 1024 * 1024 : 2 * 1024 * 1024;
}
```

Then replace all references to `MAX_PROMPT_BYTES` with `getMaxPromptBytes()`.

### File: `src/acp/event-mapper.ts`

Check if there's a separate size validation at lines 59-88. If so, apply the same pattern.

## Files to modify

| File                      | Change                                                  |
| ------------------------- | ------------------------------------------------------- |
| `src/acp/translator.ts`   | Dynamic `MAX_PROMPT_BYTES` based on dev-mode (~line 44) |
| `src/acp/event-mapper.ts` | Same pattern if size validation exists (~lines 59-88)   |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Low. In dev mode, the model's own context window is the practical limit. The 50MB cap is a safety net against truly accidental huge payloads.
