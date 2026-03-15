# Cross-Channel Memory

## Overview

Cross-channel memory sharing allows users to share the same agent's memory and context across different channels (e.g., DingTalk, WeChat, Webchat, etc.).

## Problem Statement

In the default architecture, sessions are isolated per channel:

- Information shared with the agent in Webchat is not accessible in DingTalk
- Context is fragmented when switching between channels
- Users feel like they're talking to "different agents"

## Solution

By enabling the `crossChannelMemory` option, **direct chats** with the same agent across different channels will share:

- MEMORY.md (long-term memory)
- Session history
- Configuration files (e.g., stock lists, reminders, etc.)

**Note**: Group/Channel type chats remain isolated, as group chat contexts are inherently independent.

## Usage

### Method 1: Using `--share-memory` Flag (Recommended)

```bash
# Bind multiple channels and enable cross-channel memory sharing
openclaw agents bind \
  --agent main \
  --bind webchat \
  --bind dingtalk \
  --bind wechat \
  --share-memory
```

### Method 2: Manual Configuration

Add `crossChannelMemory: true` to the agent in the configuration file:

```yaml
agents:
  list:
    - id: main
      crossChannelMemory: true
```

Then bind channels:

```bash
openclaw agents bind --agent main --bind webchat --bind dingtalk
```

## How It Works

### SessionKey Generation

- **Default mode**: `agent:main:webchat:direct:user123`
- **Cross-channel mode**: `agent:main:shared:direct:user123`

By uniformly using `shared` as the channel identifier, direct chats from different channels map to the same sessionKey, enabling memory sharing.

### Routing Logic

```typescript
if (crossChannelMemory && isDirectChat) {
  // Use unified channel identifier
  channel = "shared";
}
```

## Use Cases

### ✅ Suitable for Cross-Channel Memory

- Personal assistant scenarios (users interact with the same agent across multiple channels)
- Conversations requiring continuous context
- Configurations/preferences that need synchronization across channels

### ❌ Not Suitable for Cross-Channel Memory

- Each channel requires independent context (e.g., customer support scenarios)
- Completely different user groups across channels
- Channel-specific behaviors/configurations are needed

## Configuration Examples

### Example 1: Personal Assistant (Cross-Channel Sharing Enabled)

```yaml
agents:
  list:
    - id: main
      name: Personal Assistant
      crossChannelMemory: true
      bindings:
        - type: route
          agentId: main
          match:
            channel: webchat
        - type: route
          agentId: main
          match:
            channel: dingtalk
        - type: route
          agentId: main
          match:
            channel: wechat
```

### Example 2: Multi-Channel Support System (Channel Isolation)

```yaml
agents:
  list:
    - id: webchat-support
      name: Webchat Support
      crossChannelMemory: false

    - id: dingtalk-support
      name: DingTalk Support
      crossChannelMemory: false
```

## Considerations

1. **Privacy**: When cross-channel memory is enabled, all channels share the same memory. Ensure this aligns with your privacy requirements.

2. **Concurrent Writes**: When multiple channels write to MEMORY.md simultaneously, file locking mechanisms prevent conflicts.

3. **Performance Impact**: Cross-channel memory sharing has minimal performance impact, as it only changes the sessionKey generation logic.

4. **Backward Compatibility**: This feature is disabled by default and does not affect existing deployments.

## Technical Implementation

### Modified Files

1. `src/config/types.agents.ts` - Add `crossChannelMemory` configuration option
2. `src/routing/resolve-route.ts` - Modify sessionKey generation logic
3. `src/commands/agents.commands.bind.ts` - Add `--share-memory` flag
4. `src/cli/program/register.agent.ts` - Register CLI option

### Key Code

```typescript
// resolve-route.ts
export function buildAgentSessionKey(params: {
  // ...
  crossChannelMemory?: boolean;
}): string {
  if (params.crossChannelMemory && isDirectChat) {
    return buildAgentPeerSessionKey({
      // ...
      channel: "shared", // Unified identifier
    });
  }
  // Default behavior
}
```

## Testing

```bash
# 1. Bind channels and enable cross-channel memory
openclaw agents bind --agent main --bind webchat --bind dingtalk --share-memory

# 2. Verify configuration
openclaw agents list --json | jq '.[] | select(.id == "main") | .crossChannelMemory'
# Output: true

# 3. Verify routing
openclaw agents bindings --agent main
# Should display all bound channels
```

## Related Links

- [Channel Routing](../channels/channel-routing.md)
- [Sessions CLI](../cli/sessions.md)
- [Session Concept](../concepts/session.md)
