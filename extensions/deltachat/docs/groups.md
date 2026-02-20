# DeltaChat Group Configuration

## Overview

DeltaChat extension supports enhanced group chat configuration with fine-grained control over command execution and tool access. This documentation covers the group-specific configuration options available in the DeltaChat extension.

## Group Policies

### requireMention

- **Type**: `boolean`
- **Default**: `false`
- **Description**: When `true`, commands in the group require an explicit @mention of the bot

When `requireMention` is enabled, only messages that contain an explicit mention of the bot (e.g., `@OpenClaw !help`) will trigger command execution. This prevents accidental command execution in busy group chats.

**Example**:

```yaml
channels:
  deltachat:
    groups:
      my-group:
        requireMention: true # Commands require @mention
```

### tools

- **Type**: `"allow" | "deny" | { allow: string[], deny: string[] }`
- **Default**: `"allow"`
- **Description**: Controls which tools/commands are allowed in the group

The `tools` setting provides three levels of control:

1. **`"allow"`** - All tools/commands are allowed
2. **`"deny"`** - All tools/commands are blocked
3. **Object with `allow`/`deny` arrays** - Fine-grained control over specific tools

**Examples**:

```yaml
# Allow all tools
tools: allow

# Deny all tools
tools: deny

# Allow specific tools only
tools:
  allow: [weather, search, help]
  deny: [admin, config]
```

### toolsBySender

- **Type**: `Record<string, "allow" | "deny" | { allow: string[], deny: string[] }>`
- **Description**: Per-sender tool permissions (overrides group-level `tools`)

The `toolsBySender` setting allows you to grant different tool permissions to specific senders, overriding the group-level `tools` setting.

**Example**:

```yaml
groups:
  my-group:
    tools: deny # Default: deny all tools
    toolsBySender:
      admin@example.com:
        allow: [all] # Admin can use all tools
      moderator@example.com:
        allow: [help, search] # Moderator can only use help and search
```

## Wildcard Configuration

You can use `"*"` as a group name to apply default settings to all groups:

```yaml
channels:
  deltachat:
    groups:
      "*": # Applies to all groups
        requireMention: true
        tools: allow
      specific-group:
        users: [user@example.com]
        requireMention: false # Override for this specific group
```

## Example Configurations

### Open Group (No Restrictions)

```yaml
channels:
  deltachat:
    groups:
      my-team:
        users: [alice@example.com, bob@example.com]
        requireMention: false # Allow commands without mention
        tools: allow
```

### Secure Group (Require Mention + Tool Restrictions)

```yaml
channels:
  deltachat:
    groups:
      sensitive-group:
        users: [admin@example.com]
        requireMention: true # Require @mention for commands
        tools:
          allow: [weather, search, help]
          deny: [admin, config, system]
        toolsBySender:
          admin@example.com:
            allow: [all] # Admin can use all tools
```

### Mixed Permissions Group

```yaml
channels:
  deltachat:
    groups:
      mixed-group:
        users: [user1@example.com, user2@example.com, admin@example.com]
        requireMention: true
        tools:
          allow: [weather, search, help, news]
          deny: [admin, config, system]
        toolsBySender:
          admin@example.com:
            allow: [all]
          user1@example.com:
            allow: [weather, search, help]
```

## Mention Detection

DeltaChat uses the bot's identity (name/emoji) to build mention patterns:

- **Bot name**: "OpenClaw" → matches `@?OpenClaw` (case-insensitive)
- **Bot emoji**: "🤖" → matches the emoji

Messages in groups with `requireMention: true` must contain one of these patterns to trigger commands.

**Examples of valid mentions**:

- `@OpenClaw !help`
- `@openclaw !weather`
- `🤖 !search`
- `OpenClaw: !config`

## Key Differences from Telegram (No Threads)

| Feature                  | Telegram                          | DeltaChat                   |
| ------------------------ | --------------------------------- | --------------------------- |
| **Thread Support**       | Yes (forum topics)                | **No** (not supported)      |
| **Session Key**          | `group:{chatId}:topic:{threadId}` | `group:{chatId}`            |
| **Configuration Levels** | Group → Topic → Default           | Group → Default (no topics) |
| **Mention Detection**    | Yes (regex-based)                 | Yes (regex-based)           |
| **Tool Policies**        | Yes (per-group, per-sender)       | Yes (per-group, per-sender) |
| **Group Management**     | Via Telegram API                  | Via Delta.Chat RPC          |

## Configuration Schema

The complete configuration schema is defined in `extensions/deltachat/src/types.ts`:

```typescript
const deltaChatGroupSchema = z
  .object({
    users: z.array(allowFromEntry).optional(),
    requireMention: z.boolean().optional(),
    tools: toolPolicySchema.optional(),
    toolsBySender: z.record(z.string(), toolPolicySchema).optional(),
  })
  .optional();
```

## Implementation Details

### Mention Detection Flow

1. Build mention regexes using `core.channel.mentions.buildMentionRegexes(cfg)`
2. Check if message text matches patterns using `core.channel.mentions.matchesMentionPatterns(text, mentionRegexes)`
3. For group messages with `requireMention: true`, drop messages without explicit mention

### Tool Policy Resolution Flow

1. Check group-level `tools` setting
2. Check sender-specific `toolsBySender` override
3. Apply final policy (sender-specific overrides group-level)
4. Block commands if policy is `deny` or command is in `deny` list

### Session Key Pattern

DeltaChat uses `deltachat:group:{chatId}` pattern (no threads):

```typescript
const deltaChatTo = isGroup ? `deltachat:group:${chatId}` : `deltachat:${senderEmail}`;
```

## Backward Compatibility

All new configuration fields are optional with sensible defaults:

- `requireMention`: defaults to `false` (allow all messages)
- `tools`: defaults to `"allow"` (allow all tools)
- `toolsBySender`: defaults to empty (no per-sender overrides)

Existing configurations will continue to work without modification.

## Related Files

- `extensions/deltachat/src/types.ts` - Type definitions and schema
- `extensions/deltachat/src/monitor.ts` - Mention detection and tool policy logic
- `extensions/deltachat/src/channel.ts` - Channel plugin configuration
- `extensions/deltachat/src/monitor.test.ts` - Test cases for group features
