# SEC-27: Untrusted Channel Metadata Blocked from System Prompts

## Current Behavior

Channel metadata (Slack/Discord channel names, topics, descriptions) is excluded from the system prompt. In `src/agents/system-prompt.ts`:

- Line 371: `runtimeChannel` extracted from `runtimeInfo?.channel?.trim().toLowerCase()`
- Line 716 (in `buildRuntimeLine()`): only the channel name string is included: `channel=${runtimeChannel}`
- The `runtimeInfo` type (lines 214-226) only has `channel?: string` and `capabilities?: string[]` — no topic/description fields exist

The channel adapters (Slack/Discord) originally passed topic and description but SEC-27 stripped them before they reach the system prompt. The metadata fields were removed from the `runtimeInfo` type entirely.

## Dev-Mode Behavior

When `--dev-mode`, restore channel metadata (topic, description) in the system prompt so the AI knows the full context of the channel it's operating in.

## Implementation Plan

Since the metadata fields were removed from the type, this requires changes at two levels:

### Step 1: Extend `runtimeInfo` type

In `src/agents/system-prompt.ts` (lines 214-226), add optional metadata fields:

```typescript
// In the runtimeInfo type:
channel?: string;
channelTopic?: string;       // NEW
channelDescription?: string; // NEW
capabilities?: string[];
```

### Step 2: Pass metadata from channel adapters

Find where the Slack/Discord adapters build the `runtimeInfo` object and pass `channelTopic` and `channelDescription` through when `isDevMode()`:

```typescript
import { isDevMode } from "../globals.js";

// In the adapter building runtimeInfo:
const runtimeInfo = {
  channel: channelName,
  ...(isDevMode() && channelTopic ? { channelTopic } : {}),
  ...(isDevMode() && channelDescription ? { channelDescription } : {}),
};
```

### Step 3: Include in system prompt

In `buildRuntimeLine()` (~line 716), add metadata when present:

```typescript
// After the existing channel line:
if (runtimeChannel) {
  runtimeLines.push(`channel=${runtimeChannel}`);
}
if (runtimeInfo?.channelTopic) {
  runtimeLines.push(`channel_topic=${runtimeInfo.channelTopic}`);
}
if (runtimeInfo?.channelDescription) {
  runtimeLines.push(`channel_description=${runtimeInfo.channelDescription}`);
}
```

## Files to modify

| File                          | Change                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `src/agents/system-prompt.ts` | Extend runtimeInfo type (~line 214), add metadata to `buildRuntimeLine()` (~line 716) |
| Slack adapter (TBD)           | Pass channelTopic/channelDescription when dev-mode                                    |
| Discord adapter (TBD)         | Pass channelTopic/channelDescription when dev-mode                                    |

## Dependencies

SEC-00 (dev-mode flag infrastructure)

## Risk

Medium. Requires tracing the channel adapter data flow to find where topic/description were originally sourced. The adapters may still have access to the metadata even though they stopped passing it through. If the adapters no longer fetch metadata at all, additional API calls may be needed.
