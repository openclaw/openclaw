# Thinking Blocks Corruption Fix

## Issue

Issue #20039: When extended thinking is enabled and context compaction triggers, thinking/redacted_thinking blocks in assistant messages were being corrupted, causing API errors:

```
messages.N.content.N: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.
```

## Root Cause

Per Anthropic's API requirements, thinking and redacted_thinking blocks must remain byte-for-byte identical to how they were originally returned by the API. Any modification causes API rejection.

The issue occurred when:

1. Messages went through compaction (safeguard mode)
2. Message transformation functions inadvertently modified or removed thinking blocks
3. Modified messages were sent back to the API, causing rejection

## Fix Components

### 1. New Guard Module: `thinking-block-guard.ts`

Created comprehensive utilities to safely handle thinking blocks:

- `isThinkingBlock()` - Identifies thinking/redacted_thinking blocks
- `hasThinkingBlocks()` - Checks if a message contains thinking blocks
- `containsThinkingBlocks()` - Checks multiple messages
- `safeFilterAssistantContent()` - Safely filters content while preserving thinking blocks
- `validateThinkingBlocks()` - Validates thinking block structure

### 2. Preserved Existing `dropThinkingBlocks()` Behavior

**File**: `src/agents/pi-embedded-runner/thinking.ts`

**No changes needed**: The `dropThinkingBlocks()` function is correctly used only for GitHub Copilot models (per transcript policy). For Anthropic models, this function is NOT called, so thinking blocks are naturally preserved.

**Key insight**: The transcript policy controls when `dropThinkingBlocks()` is used:

- `dropThinkingBlocks = true` for GitHub Copilot (drops thinking blocks as required)
- `dropThinkingBlocks = false` for Anthropic (function not called, blocks preserved)

### 3. Added Compaction Warnings

**File**: `src/agents/pi-extensions/compaction-safeguard.ts`

Added warning when messages with thinking blocks are being summarized, so operators can track when thinking content is being replaced (which is acceptable, as summaries replace entire messages).

### 4. Documentation Improvements

**File**: `src/agents/session-transcript-repair.ts`

Added critical comments to `repairToolUseResultPairing()` and `repairToolCallInputs()` documenting that thinking blocks must never be modified.

### 5. Comprehensive Tests

**File**: `src/agents/thinking-block-guard.test.ts`

Created test suite to verify:

- Thinking block detection works correctly
- Content filtering preserves thinking blocks
- Messages with only thinking blocks are handled properly
- Validation catches malformed thinking blocks

## Behavior After Fix

### Messages to be Summarized

When messages containing thinking blocks are summarized during compaction:

- ✅ Acceptable: The thinking content is incorporated into the summary
- ✅ Original thinking blocks are replaced with summary text
- ✅ No API error because old messages are completely replaced

### Messages to be Kept

When messages containing thinking blocks are kept (not summarized):

- ✅ Thinking blocks are preserved byte-for-byte
- ✅ No modifications to thinking block structure
- ✅ No API errors on subsequent requests

### Edge Cases

- If filtering removes all non-thinking content from a message, the entire message is dropped
- Invalid thinking blocks (missing required fields) are preserved rather than stripped
- Multiple thinking blocks in a single message are all preserved

## Testing the Fix

To verify the fix works:

1. **Enable extended thinking**: Set `thinking: low` (or higher) in agent config
2. **Enable safeguard compaction**: Set `compaction.mode: safeguard` in config
3. **Create a long conversation**: Send enough messages to trigger context compaction
4. **Continue conversation**: After compaction, send more messages
5. **Verify no errors**: Should not see "thinking blocks cannot be modified" errors

## Prevention

Going forward, when modifying message transformation code:

1. Always check if thinking blocks are present using `containsThinkingBlocks()`
2. Use `safeFilterAssistantContent()` for any content filtering
3. Never remove or modify thinking/redacted_thinking blocks
4. If unsure, drop the entire message rather than partially modify it
5. Add tests that verify thinking blocks are preserved

## Related Files

- `src/agents/thinking-block-guard.ts` - New guard utilities
- `src/agents/thinking-block-guard.test.ts` - Test suite
- `src/agents/pi-extensions/compaction-safeguard.ts` - Added compaction warnings
- `src/agents/session-transcript-repair.ts` - Added critical documentation

## References

- Issue #20039: https://github.com/openclaw/openclaw/issues/20039
- Anthropic API docs: Thinking blocks must not be modified in multi-turn conversations
