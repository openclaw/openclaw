# Gateway Startup Notification

OpenClaw can send a notification message when the gateway starts up. This is useful to confirm that the system is online and ready to receive messages.

## Configuration

Add the following to your `~/.openclaw/openclaw.json`:

```json
{
  "gateway": {
    "startupNotification": {
      "enabled": true,
      "message": "OpenClaw gateway is now online and ready.",
      "targets": [
        {
          "channel": "telegram",
          "to": "YOUR_CHAT_ID"
        }
      ]
    }
  }
}
```

## Options

| Option    | Type    | Default                                       | Description                  |
| --------- | ------- | --------------------------------------------- | ---------------------------- |
| `enabled` | boolean | `false`                                       | Enable startup notifications |
| `message` | string  | `"OpenClaw gateway is now online and ready."` | Custom message to send       |
| `targets` | array   | `[]`                                          | List of targets to notify    |

### Target Configuration

Each target in the `targets` array supports:

| Option      | Required | Description                                                                      |
| ----------- | -------- | -------------------------------------------------------------------------------- |
| `channel`   | Yes      | Target channel: `telegram`, `discord`, `slack`, `signal`, `imessage`, `whatsapp` |
| `to`        | Yes      | Target identifier (chat ID, phone number, user ID, etc.)                         |
| `accountId` | No       | Account ID for multi-account setups                                              |

## Examples

### Notify via Telegram

```json
{
  "gateway": {
    "startupNotification": {
      "enabled": true,
      "message": "OpenClaw is ready!",
      "targets": [
        {
          "channel": "telegram",
          "to": "123456789",
          "accountId": "default"
        }
      ]
    }
  }
}
```

### Notify Multiple Targets

```json
{
  "gateway": {
    "startupNotification": {
      "enabled": true,
      "targets": [
        {
          "channel": "telegram",
          "to": "123456789"
        },
        {
          "channel": "discord",
          "to": "987654321"
        }
      ]
    }
  }
}
```

## Notes

- Notifications are sent after channels are initialized
- If a target fails to send, the error is logged but other targets will still be attempted
- Requires the corresponding channel to be properly configured (e.g., Telegram bot token)
