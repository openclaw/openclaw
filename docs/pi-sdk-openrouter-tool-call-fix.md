# Pi SDK Fix: OpenRouter Tool Call Parsing (#2963)

## Problem

OpenRouter (and some other providers) don't stream `tool_calls` as proper deltas. Instead, they:
1. Stream text content normally via `choice.delta.content`
2. Return `finish_reason: "tool_calls"` in the final chunk
3. **Do NOT include `choice.delta.tool_calls`** in any streaming chunk

The Pi SDK's `openai-completions.js` provider only parses tool calls from `choice.delta.tool_calls` (lines 194-229). When OpenRouter doesn't stream these deltas, no `toolcall_start`/`toolcall_end` events are emitted, and tool execution is skipped.

## Current Behavior

```
Provider streams: text_delta chunks, then finish_reason="tool_calls" (but no tool_calls in deltas)
SDK receives: text content only, stopReason="toolUse"
Result: No tool execution, agent stops with toolUse reason but empty tool call list
```

## Fix Location

`@mariozechner/pi-ai` package:
- File: `src/providers/openai-completions.ts`
- Function: `streamOpenAICompletions`

## Actual Event Types (Pi SDK)

The SDK uses these event types (not OpenAI's):
- `toolcall_start` - emitted when tool call begins
- `toolcall_delta` - emitted for argument streaming
- `toolcall_end` - emitted when tool call completes
- `done` - final event with `reason` and complete `message`

## Root Cause Analysis

Looking at `openai-completions.js`:

```javascript
// Line 194-229: Tool calls only parsed from streaming deltas
if (choice?.delta?.tool_calls) {
  for (const toolCall of choice.delta.tool_calls) {
    // ... emit toolcall_start, toolcall_delta, toolcall_end
  }
}
```

OpenRouter doesn't populate `choice.delta.tool_calls`. The tool calls may be:
1. In a final non-streaming chunk (not available in current stream flow)
2. Only available via non-streaming API call
3. Embedded in the final `chunk.choices[0].message` (if OpenRouter includes it)

## Proposed Fix Options

### Option A: Non-Streaming Fallback (Recommended)

When `finish_reason === "tool_calls"` but no tool calls were parsed, re-issue the request with `stream: false` to retrieve complete tool calls. Use the **same prepared params** (messages, tools, headers) to avoid schema drift between streaming and fallback requests.

**Key requirement:** Use the same prepared `params` object (messages, tools, headers, model settings) with only `stream: false` changed. Do not re-serialize differently, as this ensures the returned tool_calls match the original request context.

```typescript
// After streaming loop ends (line 242-243)
finishCurrentBlock(currentBlock);

// NEW: Fallback for providers that don't stream tool_calls
// Guard: only if stopReason is toolUse AND no toolCall blocks were ever emitted
const parsedToolCalls = output.content.filter(b => b.type === "toolCall");
if (output.stopReason === "toolUse" && parsedToolCalls.length === 0) {
  // Re-issue non-streaming request using same params to get tool_calls
  // IMPORTANT: params must remain in scope from buildParams() call above
  try {
    const nonStreamParams = { ...params, stream: false };
    delete nonStreamParams.stream_options; // Not needed for non-streaming
    const completion = await client.chat.completions.create(nonStreamParams, { signal: options?.signal });
    const choice = completion.choices[0];

    if (choice?.message?.tool_calls?.length) {
      for (const tc of choice.message.tool_calls) {
        // Safe parse: some proxies return arguments as object, others as string
        const args = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments || "{}")
          : tc.function.arguments ?? {};

        const block: ToolCallBlock = {
          type: "toolCall",
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        };
        output.content.push(block);

        // Emit synthetic events for the tool execution pipeline
        stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
        stream.push({ type: "toolcall_end", contentIndex: output.content.length - 1, toolCall: block, partial: output });
      }
    }
  } catch (fallbackError) {
    // Log but don't fail - the agent can still process the text response
    console.warn("Failed to retrieve tool_calls via non-streaming fallback:", fallbackError);
  }
}
```

**Pros:**
- Works regardless of what OpenRouter includes in streaming chunks
- Uses documented OpenAI API behavior
- Single retry, predictable cost
- Safe argument parsing handles both string and object formats

**Cons:**
- Extra API call when tool_calls aren't streamed
- Slight latency increase for affected requests
- Doubles token cost for affected requests (though this is rare)

### Option B: Parse Final Chunk Message (If Available)

Check if OpenRouter includes complete tool_calls in the final streaming chunk's message field.

```typescript
// After the streaming loop, check if final chunk has complete tool_calls
// This requires capturing the last chunk and checking for chunk.choices[0].message?.tool_calls
```

**Requires verification:** We need a real OpenRouter payload to confirm whether `chunk.choices[0].message.tool_calls` is populated in the final streaming chunk. If not, this approach won't work.

### Option C: Provider-Specific Detection

Add OpenRouter-specific handling that detects the condition and applies the fallback.

```typescript
const isOpenRouter = model.baseUrl.includes("openrouter.ai");

// In the fallback logic:
if (output.stopReason === "toolUse" && parsedToolCalls.length === 0 && isOpenRouter) {
  // Apply non-streaming fallback
}
```

## Testing

```typescript
describe("OpenRouter tool call recovery", () => {
  it("falls back to non-streaming when tool_calls not in deltas", async () => {
    const events: StreamEvent[] = [];

    // Mock: streaming returns text + finish_reason but no tool_calls in deltas
    // Mock: non-streaming returns complete tool_calls

    const output = await streamOpenAICompletions(model, context, options);

    // Verify toolcall_start/toolcall_end events were emitted
    const toolCallEvents = events.filter(e => e.type === "toolcall_start" || e.type === "toolcall_end");
    expect(toolCallEvents.length).toBeGreaterThan(0);

    // Verify tool call is in output
    const toolCalls = output.content.filter(b => b.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("read");
  });

  it("does not fallback when tool_calls are properly streamed", async () => {
    // Mock: streaming includes tool_calls in deltas
    // Verify non-streaming fallback is NOT called
  });
});
```

## Migration

This is a non-breaking change:
- Providers that stream tool_calls correctly will never trigger the fallback
- Only affects requests where `stopReason === "toolUse"` but no tool calls were parsed

## Diagnostic Guard (Current OpenClaw Workaround)

Until this fix lands in Pi SDK, OpenClaw has a diagnostic guard that logs when tool call intent is detected but no tool execution occurred:

```typescript
// src/agents/pi-embedded-subscribe.handlers.messages.ts
function detectUnparsedToolCallIntent(text: string): string | undefined {
  // Detects JSON tool call structures, XML tags, or "I'll use X tool" patterns
  // Logs warning but cannot recover tool execution
}
```

This provides visibility but doesn't fix the issue.

## Implementation Notes

### Scope Considerations

The `params` object is created via `buildParams()` at line 68 and used for the streaming call at line 70. For the fallback to work:
- `params` must remain in scope after the streaming loop
- Alternatively, store `params` in a variable accessible in the fallback block

### Compat Flag Option

Consider adding a compat flag to explicitly enable the fallback for known problematic providers:

```typescript
interface OpenAICompletionsCompat {
  // ... existing fields ...
  requiresNonStreamingToolCallFallback?: boolean;
}
```

This would allow:
- Opt-in behavior for OpenRouter
- Avoidance of unnecessary fallback attempts for providers that stream correctly
- Fine-grained control per model/provider

## Action Items

1. **Verify OpenRouter behavior:** Capture actual streaming payloads to confirm tool_calls are NOT in deltas
2. **Check final chunk:** Verify if `chunk.choices[0].message.tool_calls` is populated
3. **Implement Option A** if verification confirms tool_calls aren't available in streaming
4. **Add compat flag:** Add `requiresNonStreamingToolCallFallback` to model compat for explicit opt-in
5. **Test with multiple OpenRouter models:** Different underlying models may behave differently

## References

- GitHub Issue: #2963
- Pi SDK: `@mariozechner/pi-ai@0.51.1`
- File: `node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js`
- Lines: 194-229 (tool call parsing), 242-250 (stream completion)
