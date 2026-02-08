# OpenClaw WeCom (Enterprise WeChat) AI Bot Plugin

[English](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README.md) | [简体中文](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README_ZH.md)

`openclaw-plugin-wecom` is an Enterprise WeChat (WeCom) integration plugin developed for the [OpenClaw](https://github.com/openclaw/openclaw) framework. It enables seamless AI capabilities in Enterprise WeChat with advanced features.

## Key Features

- **Streaming Output**: Built on WeCom's latest AI bot streaming mechanism for smooth typewriter-style responses.
- **Dynamic Agent Management**: Automatically creates isolated agents per direct message user or group chat, with independent workspaces and conversation contexts.
- **Deep Group Chat Integration**: Supports group message parsing with @mention triggering.
- **Rich Message Types**: Handles text, image, voice, mixed (text+image), file, location, and link messages.
- **Inbound Image Decryption**: Automatically decrypts WeCom-encrypted images using AES-256-CBC for AI vision processing.
- **Outbound Image Support**: Automatic base64 encoding and sending of local images (screenshots, generated images) via `msg_item` API.
- **Message Debounce**: Rapid consecutive messages from the same user are merged into a single AI request.
- **Admin Users**: Configurable admin list that bypasses command allowlist and dynamic agent routing.
- **Command Allowlist**: Built-in commands (e.g., `/new`, `/status`) with configurable allowlist to restrict sensitive operations.
- **Security & Authentication**: Full support for WeCom message encryption/decryption, URL verification, and sender validation.
- **High-Performance Async Processing**: Asynchronous message architecture ensures responsive gateway even during long AI inference.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed (version 2026.1.30+)
- Enterprise WeChat admin access to create intelligent robot applications
- Server address accessible from Enterprise WeChat (HTTP/HTTPS)

## Installation

```bash
openclaw plugins install @sunnoy/wecom
```

This command will automatically:

- Download the plugin from npm
- Install to `~/.openclaw/extensions/`
- Update your OpenClaw configuration
- Register the plugin

## Configuration

Add to your OpenClaw configuration file (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "wecom": {
        "enabled": true
      }
    }
  },
  "channels": {
    "wecom": {
      "enabled": true,
      "token": "Your Token",
      "encodingAesKey": "Your EncodingAESKey",
      "adminUsers": ["admin-userid"],
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      }
    }
  }
}
```

### Configuration Options

| Option                              | Type    | Required | Description                                                   |
| ----------------------------------- | ------- | -------- | ------------------------------------------------------------- |
| `plugins.entries.wecom.enabled`     | boolean | Yes      | Enable the plugin                                             |
| `channels.wecom.token`              | string  | Yes      | WeCom bot Token                                               |
| `channels.wecom.encodingAesKey`     | string  | Yes      | WeCom message encryption key (43 chars)                       |
| `channels.wecom.adminUsers`         | array   | No       | Admin user IDs (bypass command allowlist and dynamic routing) |
| `channels.wecom.commands.allowlist` | array   | No       | Command allowlist                                             |

## Enterprise WeChat Configuration

1. Log in to [Enterprise WeChat Admin Console](https://work.weixin.qq.com/)
2. Navigate to "Application Management" > "Applications" > "Create Application" > Select "Intelligent Robot"
3. Configure "Receive Messages":
   - **URL**: `https://your-domain.com/webhooks/wecom`
   - **Token**: Match `channels.wecom.token`
   - **EncodingAESKey**: Match `channels.wecom.encodingAesKey`
4. Save and enable message receiving

## Supported Message Types

| Type     | Direction        | Description                                                                   |
| -------- | ---------------- | ----------------------------------------------------------------------------- |
| Text     | Inbound/Outbound | Plain text messages                                                           |
| Image    | Inbound/Outbound | Encrypted images (inbound are auto-decrypted); outbound via `msg_item` base64 |
| Voice    | Inbound          | Auto-transcribed by WeCom, processed as text (DM only)                        |
| Mixed    | Inbound          | Text + image combination messages                                             |
| File     | Inbound          | File attachments (downloaded and passed to AI for analysis)                   |
| Location | Inbound          | Location shares (converted to text description)                               |
| Link     | Inbound          | Shared links (title, description, URL extracted as text)                      |

## Admin Users

Admin users bypass the command allowlist and skip dynamic agent routing (routed to the main agent directly).

```json
{
  "channels": {
    "wecom": {
      "adminUsers": ["user1", "user2"]
    }
  }
}
```

Admin user IDs are case-insensitive and matched against the WeCom `userid` field.

## Dynamic Agent Routing

The plugin implements per-user/per-group agent isolation:

### How It Works

1. When a WeCom message arrives, the plugin generates a deterministic `agentId`:
   - **Direct Messages**: `wecom-dm-<userId>`
   - **Group Chats**: `wecom-group-<chatId>`
2. OpenClaw automatically creates/reuses the corresponding agent workspace
3. Each user/group has independent conversation history and context
4. **Admin users** skip dynamic routing and use the main agent directly

### Advanced Configuration

Configure under `channels.wecom`:

```json
{
  "channels": {
    "wecom": {
      "dynamicAgents": {
        "enabled": true
      },
      "dm": {
        "createAgentOnFirstMessage": true
      },
      "groupChat": {
        "enabled": true,
        "requireMention": true
      }
    }
  }
}
```

| Option                         | Type    | Default | Description                  |
| ------------------------------ | ------- | ------- | ---------------------------- |
| `dynamicAgents.enabled`        | boolean | `true`  | Enable dynamic agents        |
| `dm.createAgentOnFirstMessage` | boolean | `true`  | Use dynamic agents for DMs   |
| `groupChat.enabled`            | boolean | `true`  | Enable group chat processing |
| `groupChat.requireMention`     | boolean | `true`  | Require @mention in groups   |

### Disable Dynamic Agents

To route all messages to the default agent:

```json
{
  "channels": {
    "wecom": {
      "dynamicAgents": { "enabled": false }
    }
  }
}
```

## Command Allowlist

Prevent regular users from executing sensitive Gateway management commands through WeCom messages.

```json
{
  "channels": {
    "wecom": {
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      }
    }
  }
}
```

### Recommended Allowlist Commands

| Command    | Description                           | Safety Level |
| ---------- | ------------------------------------- | ------------ |
| `/new`     | Reset conversation, start new session | User-level   |
| `/compact` | Compress current session context      | User-level   |
| `/help`    | Show help information                 | User-level   |
| `/status`  | Show Agent status                     | User-level   |

> **Security Note**: Do not add `/gateway`, `/plugins`, or other management commands to the allowlist to prevent regular users from gaining Gateway instance admin privileges. Admin users configured in `adminUsers` bypass this restriction.

## Message Debounce

When a user sends multiple messages in rapid succession (within 2 seconds), the plugin automatically merges them into a single AI request. This prevents multiple concurrent LLM calls for the same user and provides a more coherent response.

- The first message's stream receives the AI response
- Subsequent merged messages show a notice that they have been combined
- Commands (messages starting with `/`) bypass debounce and are processed immediately

## FAQ

### Q: How does inbound image handling work?

**A:** WeCom encrypts images sent by users with AES-256-CBC. The plugin automatically:

1. Downloads the encrypted image from WeCom's URL
2. Decrypts it using the configured `encodingAesKey`
3. Saves it locally and passes it to the AI for vision analysis

Mixed messages (text + images) are fully supported — text and images are extracted and sent together.

### Q: How does outbound image sending work?

**A:** The plugin automatically handles images generated by OpenClaw (such as browser screenshots):

- **Local images** (from `~/.openclaw/media/`) are automatically encoded to base64 and sent via WeCom's `msg_item` API
- **Image constraints**: Max 2MB per image, supports JPG and PNG formats, up to 10 images per message
- **No configuration needed**: Works out of the box with tools like browser screenshot
- Images appear when the AI completes its response (streaming doesn't support incremental image sending)

If an image fails to process (size limit, invalid format), the text response will still be delivered and an error will be logged.

### Q: Does the bot support voice messages?

**A:** Yes! Voice messages in direct chats are automatically transcribed by WeCom and processed as text. No additional configuration needed.

### Q: Does the bot support file messages?

**A:** Yes. Files sent by users are downloaded and passed to the AI as attachments. The AI can analyze file contents (e.g., reading a PDF or parsing a code file). MIME types are auto-detected from the file extension.

### Q: How to configure auth token for public-facing OpenClaw with WeCom callbacks?

**A:** WeCom bot **does not need** OpenClaw's Gateway Auth Token.

- **Gateway Auth Token** (`gateway.auth.token`) is used for:
  - WebUI access authentication
  - WebSocket connection authentication
  - CLI remote connection authentication

- **WeCom Webhook** (`/webhooks/wecom`) authentication:
  - Uses WeCom's own signature verification (Token + EncodingAESKey)
  - Does not require Gateway Auth Token
  - OpenClaw plugin system automatically handles webhook routing

**Deployment suggestions:**

1. If using a reverse proxy (e.g., Nginx), configure authentication exemption for `/webhooks/wecom` path
2. Or expose the webhook endpoint on a separate port without Gateway Auth

### Q: How to fix EncodingAESKey length validation failure?

**A:** Common causes and solutions:

1. **Check configuration key name**: Ensure correct key name `encodingAesKey` (case-sensitive)

   ```json
   {
     "channels": {
       "wecom": {
         "encodingAesKey": "..."
       }
     }
   }
   ```

2. **Check key length**: EncodingAESKey must be exactly 43 characters

   ```bash
   # Check length
   echo -n "your-key" | wc -c
   ```

3. **Check for extra spaces/newlines**: Ensure no leading/trailing whitespace in the key string

## Project Structure

```
openclaw-plugin-wecom/
├── index.js              # Plugin entry point
├── webhook.js            # WeCom HTTP communication handler
├── dynamic-agent.js      # Dynamic agent routing logic
├── stream-manager.js     # Streaming response manager
├── image-processor.js    # Image encoding/validation for msg_item
├── crypto.js             # WeCom encryption algorithms (message + media)
├── logger.js             # Logging module
├── utils.js              # Utility functions (TTL cache, deduplication)
├── package.json          # npm package config
└── openclaw.plugin.json  # OpenClaw plugin manifest
```

## Contributing

We welcome contributions! Please submit Issues or Pull Requests for bugs or feature suggestions.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

This project is licensed under the [ISC License](./LICENSE).
