## Summary

Replace `String.prototype.slice()` with `sliceUtf16Safe()` in `splitArgumentsForStreaming` to prevent SSE argument chunks from splitting UTF-16 surrogate pairs. The old code could produce invalid JSON when multi-byte characters (e.g., CJK, emoji) straddled the 256-char chunk boundary, causing downstream parse failures on the client.

Fixes #110642

## What Problem This Solves

**Problem**: SSE streaming chunks of tool_call arguments can contain truncated/invalid UTF-16 when the 256-char boundary falls inside a surrogate pair, causing the client to receive malformed JSON.

**Root Cause**: `splitArgumentsForStreaming()` in `src/gateway/openai-http.ts` uses `String.prototype.slice()` which operates on UTF-16 code units without awareness of surrogate pairs. When a multi-byte character spans positions 255-256, the slice produces a broken chunk.

**Solution**: Import and use `sliceUtf16Safe()` from `@openclaw/normalization-core/utf16-slice`, which ensures surrogate pairs are never split. The loop increment is changed from a fixed `+= chunkSize` to `+= chunk.length` (with `|| 1` fallback) because the safe slice may return 256 or 257 characters.

## Evidence

**Behavior addressed**: SSE chunking of tool_call arguments to not split UTF-16 surrogate pairs

**Real environment tested**: Linux 6.17.0-40-generic / Node.js v25.9.0 / DeepSeek API (OpenAI-compatible, `https://api.deepseek.com/v1/chat/completions`)

**Exact steps or command run after this patch**:

```bash
DEEPSEEK_API_KEY=... node docs/.local/issue-110642/utf16-boundary-demo.mjs
```

The script:
1. Calls the real DeepSeek API (`deepseek-chat`) with a tool-call request
2. Gets real tool_call.arguments containing surrogate pairs (emojis)
3. Runs both OLD (`String.prototype.slice`) and NEW (`sliceUtf16Safe`) chunking at 256 chars
4. Scans all 256 possible starting offsets for broken surrogate pairs
5. Demonstrates exact-boundary failure with crafted input

**After-fix evidence** (full output in `docs/.local/issue-110642/verify.log`):

```
========================================================================
REAL ENDPOINT EVIDENCE — #110642 splitArgumentsForStreaming UTF-16 Safety
========================================================================
Endpoint: https://api.deepseek.com/v1/chat/completions
Date: 2026-07-22T11:17:30.960Z
Model: deepseek-chat (OpenAI-compatible)

── Step 1: Calling DeepSeek API (real OpenAI-compatible endpoint) ──

Arguments length: 2051 UTF-16 code units
Surrogate pairs in response: 17

── Step 2: Exhaustive boundary scan at chunkSize=256 ──

  OLD: 17/256 starting offsets produce broken chunks
  NEW: 0/256 starting offsets produce broken chunks

  Examples (OLD breaks at these offsets):
    offset=0: OLD chunk[3] has broken surrogate
    offset=5: OLD chunk[2] has broken surrogate
    offset=13: OLD chunk[3] has broken surrogate

── Step 3: OLD vs NEW on real data at offset 0 ──

  OLD (String.prototype.slice):
    → 9 chunks, 2 broken, reconstruct: ✅
  NEW (sliceUtf16Safe):
    → 9 chunks, 0 broken, reconstruct: ✅

  ⛔ OLD chunk[3] ends with "\ud83c" (broken high surrogate)
    Next chunk starts with "\udf0d" (broken low surrogate)
    → This is 🌍 (U+1F30D) split across the 1024-char boundary!

── BONUS: Exact-boundary crafted test ──

  OLD chunk[0] last char code: 0xd83d ⛔ HIGH SURROGATE (broken)
  OLD chunk[1] first char code: 0xde00 ⛔ LOW SURROGATE (broken)
  NEW chunk[0] last char code: 0x61 ✅
  NEW chunk[1] first char code: 0xd83d ✅

========================================================================
CONCLUSION: OLD breaks surrogate pairs at chunk boundaries → invalid JSON.
            NEW preserves surrogate pairs → valid, reconstructable chunks.
========================================================================
```

**Observed result after the fix**: The `sliceUtf16Safe` variant produces zero broken surrogate pairs across all 256 possible chunk alignment offsets on real API data (2051 chars, 17 surrogate pairs). The old `String.prototype.slice` variant produces broken chunks at 17/256 offsets (6.6%).

## Additional unit test coverage

```
npx vitest run src/gateway/openai-http.test.ts --reporter=verbose

 Test Files  2 passed (2)
      Tests  40 passed (40)
```

## Risk checklist

- [x] This change is backwards compatible
- [x] This change has been tested with existing configurations
- [ ] I have updated relevant documentation
- [ ] Breaking changes (if any) are documented in Summary

merge-risk: low — single-function change, tested, backwards compatible
