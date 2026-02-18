# WhatsApp Message Actions

WhatsApp supports additional message actions beyond basic sending:

## Available Actions

### `read` - Read Message History

Retrieve recent messages from a WhatsApp chat or group.

**Parameters:**

- `action`: `"read"`
- `channel`: `"whatsapp"`
- `target`: Chat JID (e.g., `"1234567890@s.whatsapp.net"` for DM, `"1234567890-1234567890@g.us"` for group)
- `limit`: (optional) Number of messages to retrieve (default: 20)
- `accountId`: (optional) WhatsApp account ID for multi-account setups

**Example:**

```typescript
{
  action: "read",
  channel: "whatsapp",
  target: "1234567890@s.whatsapp.net",
  limit: 50
}
```

**Returns:**

```typescript
{
  ok: true,
  messages: [
    {
      id: "message_id",
      from: "sender_jid",
      to: "chat_jid",
      body: "message text",
      timestamp: 1234567890000,
      hasMedia: false,
      mediaType: undefined,
      fileName: undefined
    },
    // ...
  ],
  count: 50
}
```

**Configuration:**

```yaml
channels:
  whatsapp:
    actions:
      messages: true # Enable read action (default: true)
    # Sync full message history on connection (recommended for read action)
    syncFullHistory: true # Default: false
    # Optional: Restrict bot to specific chats/groups
    allowChats:
      - "120363425273773444@g.us" # Group JID
      - "1234567890@s.whatsapp.net" # DM JID
```

**Access Control:**

The `read` action respects WhatsApp access control settings:

- `allowChats`: If set, only chats in this list can be read
- `dmPolicy`: Controls direct message access
- `groupPolicy`: Controls group message access

Attempting to read from a chat not in `allowChats` will result in an access denied error.

### `readFile` - Download Media from Messages

Download media (images, videos, documents, audio) from a WhatsApp message.

**Parameters:**

- `action`: `"readFile"`
- `channel`: `"whatsapp"`
- `chatJid`: Chat JID where the message was sent
- `messageId`: Message ID containing the media
- `accountId`: (optional) WhatsApp account ID

**Example:**

```typescript
{
  action: "readFile",
  channel: "whatsapp",
  chatJid: "1234567890@s.whatsapp.net",
  messageId: "3EB0ABCDEF1234567890"
}
```

**Returns:**

```typescript
{
  ok: true,
  path: "/path/to/downloaded/file.jpg",
  mimetype: "image/jpeg",
  fileName: "photo.jpg",
  size: 123456
}
```

**Configuration:**

```yaml
channels:
  whatsapp:
    actions:
      readFile: true # Enable readFile action (default: true)
```

## How Actions Are Exposed to Agents

### 1. Action Registration (Build Time)

Actions are registered in the master list:

- **File**: `src/channels/plugins/message-action-names.ts`
- **List**: `CHANNEL_MESSAGE_ACTION_NAMES` array includes `"read"` and `"readFile"`

### 2. Channel Plugin Declaration (Runtime)

The WhatsApp plugin declares which actions it supports:

- **File**: `extensions/whatsapp/src/channel.ts`
- **Method**: `actions.listActions({ cfg })`
- **Logic**: Checks config gates and returns enabled actions

```typescript
actions: {
  listActions: ({ cfg }) => {
    const gate = createActionGate(cfg.channels?.whatsapp?.actions);
    const actions = new Set<ChannelMessageActionName>();
    if (gate("reactions")) actions.add("react");
    if (gate("polls")) actions.add("poll");
    if (gate("readFile")) actions.add("readFile");
    if (gate("messages")) actions.add("read");
    return Array.from(actions);
  };
}
```

### 3. Tool Schema Generation (Agent Session Start)

When an agent session starts, the `message` tool schema is built:

- **File**: `src/agents/tools/message-tool.ts`
- **Function**: `buildMessageToolSchema(cfg)`
- **Process**:
  1. Calls `listChannelMessageActions(cfg)` to aggregate all actions from all channels
  2. Builds TypeScript schema with action enum
  3. Includes parameter descriptions for each action

### 4. Tool Description (Agent Prompt)

The tool description is included in the agent's system prompt:

- **Function**: `buildMessageToolDescription(options)`
- **Content**: Lists all available actions with descriptions
- **Example**: `"Supports actions: send (send messages), read (read message history), readFile (download media from messages), ..."`

### 5. Channel-Specific Hints (Agent Prompt)

Additional usage hints are injected into the system prompt:

- **File**: `extensions/whatsapp/src/channel.ts`
- **Section**: `agentPrompt.messageToolHints`
- **Content**:
  ```
  - WhatsApp message history: use `action=read` with `channel=whatsapp`,
    `target=<chat_jid>`, and optional `limit=<number>` to retrieve recent
    messages from a chat or group.
  - WhatsApp media download: use `action=readFile` with `channel=whatsapp`,
    `chatJid=<chat_jid>`, and `messageId=<message_id>` to download media
    from a message.
  ```

### 6. Action Execution (Tool Call)

When the agent calls the message tool:

1. **Message Tool** (`src/agents/tools/message-tool.ts`) receives the call
2. **Action Runner** (`src/infra/outbound/message-action-runner.ts`) routes to channel
3. **Channel Dispatcher** (`src/channels/plugins/message-actions.ts`) finds WhatsApp plugin
4. **WhatsApp Handler** (`extensions/whatsapp/src/channel.ts`) executes action
5. **Action Implementation** (`src/agents/tools/whatsapp-actions.ts`) performs the operation

## Message Store

The `read` action relies on an in-memory message store that retains messages as they arrive.

**Characteristics:**

- Stores last 1000 messages across all chats
- 24-hour retention window
- Messages stored as they arrive
- Cleared on gateway restart
- Per-account storage

**Full History Sync:**

Enable `syncFullHistory: true` in config to populate the message store with full history when the gateway connects:

```yaml
channels:
  whatsapp:
    syncFullHistory: true
```

This syncs all message history once at connection time, making it available to the `read` action. Without this, only messages received after the gateway starts will be available.

**Location**: `src/web/inbound/message-store.ts`

**Storage Trigger**: Messages are stored in `src/web/inbound/monitor.ts` when received:

```typescript
messageStore.store(remoteJid, id, msg as proto.IWebMessageInfo);
```

## Debugging

Enable verbose logging to see action flow:

```bash
OPENCLAW_VERBOSE=1 openclaw gateway run
```

**Log Output:**

```
[message-tool] Building schema with actions: send, broadcast, react, poll, read, readFile
[message-tool] Channel-specific description: ... supports: read (read message history), readFile (download media from messages)
[message-action-runner] Running action: read
[message-actions] Dispatching action: read for channel: whatsapp
[gateway/channels/whatsapp/actions] WhatsApp action invoked: read
[gateway/channels/whatsapp/actions] Reading messages from WhatsApp: chatJid=..., limit=20
[gateway/channels/whatsapp/actions] Retrieved 15 messages from WhatsApp
```

## Limitations

1. **History Sync Limitations**: The `read` action only returns messages in the store. `syncFullHistory: true` syncs recently active chats at startup, but may not include all historical messages from all chats. New messages are always stored as they arrive.
2. **Memory-Only Storage**: Message store is cleared on restart
3. **Limited Capacity**: Maximum 1000 messages across all chats
4. **24-Hour Retention**: Older messages are automatically purged
5. **No Persistence**: Messages are not saved to disk
6. **Sync Timing**: `syncFullHistory` only syncs once at connection time, not on-demand

**Workaround for Historical Messages**: If a chat has no messages in the store, send a new message to that chat to make it "active", which may trigger Baileys to sync recent history for that chat.

## Future Enhancements

Potential improvements:

- Persistent message storage (database)
- Historical message backfill on startup
- Configurable retention limits
- Per-chat message limits
- Message search/filtering capabilities
