# Bug Report: Bailian Context Overflow Error Not Detected

## Summary

Alibaba DashScope/Bailian API's context overflow error format is not recognized by OpenClaw's error detection logic, causing overflow recovery to not trigger and sessions to enter a failure loop.

## Affected Versions

- OpenClaw 2026.4.2 - 2026.4.5
- Provider: `bailian` (Alibaba DashScope)
- Models: GLM-5, Qwen, and other models via Bailian

## Error Format

```
HTTP 400: <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]
```

## Root Cause

The function `isContextOverflowError()` in `src/agents/pi-embedded-helpers/errors.ts` does not recognize this error format.

The existing detection patterns look for:
- "context length exceeded"
- "prompt is too long"
- "input length" + "exceed" + "context"

But Bailian uses:
- "Range of input length should be [1, N]"
- No "exceed" keyword
- No "context" keyword

## Impact

1. **Overflow recovery not triggered**: OpenClaw's automatic context compaction does not activate
2. **Session failure loop**: Every request fails with the same error
3. **User cannot continue**: The session becomes unusable

## Fix

### Files Modified

- `src/agents/pi-embedded-helpers/errors.ts`

### Changes

```typescript
// Added to isContextOverflowError() function:
// Alibaba DashScope/Bailian API: "Range of input length should be [1, 202745]"
lower.includes("range of input length") ||
(lower.includes("input length") && lower.includes("should be")) ||
```

Also updated `CONTEXT_OVERFLOW_HINT_RE` regex to include:
```typescript
|range of input length|input length.*(should|must)\s
```

## Verification

```javascript
const testCases = [
  "Range of input length should be [1, 202745]",
  "HTTP 400: <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]",
  "input length should be [1, 128000]",
];

// All test cases now correctly identified as context overflow errors
```

## Credit

Reported by: OpenClaw Operations Team
Date: 2026-04-08

## Related

- Similar error patterns from other providers may need similar treatment
- Consider adding provider-specific error detection module for maintainability