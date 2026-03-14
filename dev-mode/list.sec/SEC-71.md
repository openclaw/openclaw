# SEC-71: Web Fetch Response Body Size Cap (2MB)

## Current Behavior

`web_fetch` tool caps response body at 2MB. Larger responses are truncated.

- `src/gateway/chat-attachments.ts` lines 76-90: `validateAttachmentBase64OrThrow` with size validation
- The 2MB cap may also appear in the web fetch tool implementation itself

## Dev-Mode Behavior

When `--dev-mode`, remove the 2MB body cap (or increase to a much larger value like 50MB).

## Implementation Plan

### File: `src/agents/tools/web-fetch.ts`

The 2MB cap is at line 36:

```typescript
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 2_000_000;
```

Used by `resolveFetchMaxResponseBytes()` at lines 115-125 (runtime, not module-load).

Note: `src/gateway/chat-attachments.ts` has a **separate** 5MB cap for image attachments — that is NOT the web fetch cap.

### Implementation

```typescript
import { isDevMode } from "../globals.js";

// Line 36:
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = isDevMode()
  ? 50_000_000 // 50MB in dev mode
  : 2_000_000; // 2MB default
```

This is safe because the constant is only accessed inside `resolveFetchMaxResponseBytes()` at runtime, after `setDevMode()` has been called.

## Files to modify

| File                            | Change                                                               |
| ------------------------------- | -------------------------------------------------------------------- |
| `src/agents/tools/web-fetch.ts` | Increase `DEFAULT_FETCH_MAX_RESPONSE_BYTES` when dev-mode (~line 36) |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Low-medium. Removing the cap means the AI could download large files into memory. On a VPS with adequate RAM this is fine. Consider using a higher cap (50MB) instead of unlimited.
