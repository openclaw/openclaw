# Fix #18480: Reasoning Array Error

## Problem
Error: `400 Item '[]' of type 'reasoning' was provided without its required following item`

This occurs after 2-3 interactions with OpenAI models (gpt-5.2-pro) when reasoning items are present in the conversation array.

## Root Cause Analysis

OpenAI's API requires that each `reasoning` item in the message array must be followed by a content item. When:
1. A reasoning item is the last item in the array, OR
2. Two reasoning items appear consecutively without content between them

The API returns this validation error.

## Proposed Fix Location

The fix should be applied in the message construction layer, likely in:
- `@mariozechner/pi-ai` library (if controllable)
- Or in OpenClaw's message preparation before sending to the API

## Suggested Implementation

```typescript
// In message construction/payload building
function sanitizeMessagesForOpenAI(messages: Message[]): Message[] {
  return messages.filter((msg, index, arr) => {
    // Remove empty reasoning items
    if (msg.type === 'reasoning' && (!msg.content || msg.content.length === 0)) {
      return false;
    }
    
    // Ensure reasoning items are followed by content
    if (msg.type === 'reasoning') {
      const nextMsg = arr[index + 1];
      if (!nextMsg || nextMsg.type === 'reasoning') {
        // Either add a content placeholder or remove this reasoning item
        return false;
      }
    }
    
    return true;
  });
}
```

## Alternative Fix

If the issue is in how reasoning items are replayed from history:
- Ensure tool-call-only turns properly replay reasoning before the tool call
- Add validation before sending to OpenAI API

## Files to Investigate
- `src/agents/pi-embedded-runner/run.ts` - Main run logic
- `src/agents/pi-embedded-subscribe.ts` - Message subscription
- `@mariozechner/pi-ai` library internals (if accessible)

## Status
⚠️ This fix requires deeper investigation into the pi-ai library internals
and how OpenAI responses API handles reasoning items in conversation history.

Recommended: Test with actual OpenAI API calls to reproduce and verify fix.
