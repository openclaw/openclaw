# Task: Fix Leading Newline Bug

## Problem
iMessage responses have 1-2 blank lines prepended. Root cause: Anthropic models in thinking mode emit a `\n\n` text block before the thinking block, and the streaming/flush path doesn't trim leading whitespace.

## Fixes Required (apply ALL THREE for defense in depth)

### Fix 1: `emitBlockChunk` in `src/agents/pi-embedded-subscribe.ts`
Find the line that does `.trimEnd()` on the chunk text and change it to `.trim()`:
```
// Find something like:
const chunk = stripBlockTags(text, state.blockState).trimEnd();
// Change to:
const chunk = stripBlockTags(text, state.blockState).trim();
```

### Fix 2: `collapseConsecutiveDuplicateBlocks` in `src/agents/pi-embedded-helpers/errors.ts`
Fix the early return to use trimmed text instead of original:
```
// Find:
if (blocks.length < 2) return text;
// Change to:
if (blocks.length < 2) return trimmed;
```

### Fix 3: Safety net in `sanitizeUserFacingText` in same file (`errors.ts`)
Make sure the final return trims:
```
// Find the final return of collapseConsecutiveDuplicateBlocks(stripped)
// Change to:
return collapseConsecutiveDuplicateBlocks(stripped).trim();
```

## Rules
- Edit the TypeScript SOURCE files in `src/`, NOT the compiled `dist/` files
- Build after changes: `npm run build` or `npx tsc`
- Commit with message: `fix: trim leading newlines from streaming/block-flush text output`
- Co-author: `Co-authored-by: Zach Canepa <zcanepa19@gmail.com>`
- Push to branch: `fix/leading-newline-trim`
- Do NOT create a PR, just push

## Verification
After building, check that the compiled JS in `dist/` reflects your changes:
- `dist/agents/pi-embedded-subscribe.js` should have `.trim()` not `.trimEnd()`
- `dist/agents/pi-embedded-helpers/errors.js` should return `trimmed` not `text` in early return
