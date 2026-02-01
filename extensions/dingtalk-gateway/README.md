# DingTalk Gateway Channel Plugin

This plugin provides DingTalk integration via Kafka message queues. Messages are consumed from Kafka and replies are sent back to Kafka.

## Configuration

The channel requires:
- `userId`: DingTalk user ID for this gateway instance
- `kafkaBrokers`: Kafka broker addresses (optional, default: "localhost:9092")

The following are automatically generated based on `userId`:
- `kafkaGroupId`: `dingtalk-user-{userId}-consumer`
- `kafkaInboundTopic`: `dingtalk-user-{userId}`
- `kafkaOutboundTopic`: `dingtalk-reply-{userId}`

## Message Format

Messages consumed from Kafka and sent to Kafka follow the same format as `dingtalk-stream`'s `RobotTextMessage`:

```typescript
{
  conversationId: string;
  conversationType: "1" | "2"; // "1" = DM, "2" = group
  senderStaffId?: string;
  senderId?: string;
  senderNick?: string;
  text?: { content: string };
  sessionWebhook?: string;
  createAt: number;
}
```

## Installation

```bash
openclaw plugins install @openclaw/dingtalk-gateway
```

Or for local development:

```bash
openclaw plugins install ./extensions/dingtalk-gateway
```

## Example Configuration

```json5
{
  channels: {
    "dingtalk-gateway": {
      enabled: true,
      userId: "your-dingtalk-user-id",
      kafkaBrokers: "localhost:9092", // or ["broker1:9092", "broker2:9092"]
      // kafkaGroupId, kafkaInboundTopic, kafkaOutboundTopic are auto-generated
      // ... other DingTalk config options (groupPolicy, allowFrom, etc.)
    }
  }
}
```

## How It Works

1. **Inbound Messages**: The plugin consumes messages from the Kafka inbound topic `dingtalk-user-{userId}`
2. **Message Processing**: Messages are processed using the same logic as the `dingtalk` channel (access control, mention checking, routing, etc.)
3. **Agent Execution**: Messages are forwarded to the configured agent for processing
4. **Outbound Replies**: Agent replies are sent to the Kafka outbound topic `dingtalk-reply-{userId}` in the same `RobotTextMessage` format

## Differences from `dingtalk` Channel

- Uses Kafka for message transport instead of WebSocket
- No direct DingTalk API integration (relies on external gateway service)
- Requires Kafka infrastructure
- Messages must be published to Kafka by an external service (e.g., `openclaw-dingtalk-gateway`)
