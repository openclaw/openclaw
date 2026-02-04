# PR 4: UI/UX Enhancements

## Description

Updates the frontend to support new tool output formats (`tool_use` vs `toolcall`) and reasoning streams.

## Implementation Details

### 1. `ui/src/ui/chat/tool-cards.ts`

Update `extractToolCards` to handle polymorphic tool types.

**Logic:**

```typescript
export function extractToolCards(message: unknown): ToolCard[] {
  // ...
  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();

    // Support both Legacy Pi ("toolcall") and Claude ("tool_use")
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);

    if (isToolCall) {
       // Extract name/args regardless of format
       cards.push({ kind: "call", ... });
    }
  }
  // ... handle tool results similarly ...
}
```

### 2. Styling

Ensure `ui/src/styles/chat/tool-cards.css` supports any new classes added for distinct tool types (if any).

### 3. Reasoning Display (Optional but Recommended)

If the backend sends `onReasoningStream` events, the UI needs to handle them.

- Update `ui/src/ui/app-chat.ts` to listen for `reasoning` events.
- Render a "Thinking..." collapsible section or similar indicator in the chat view.

## Verification

- **Legacy Test:** Trigger a tool with Pi (e.g., `/help`). Ensure the card renders.
- **New Test:** Trigger a tool with Claude. Ensure the card renders.
- **Result Test:** Ensure tool _outputs_ (results) are displayed correctly for both.
