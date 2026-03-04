# @openclaw/feishu

OpenClaw plugin for Feishu/Lark enterprise messaging platform.

## Features

- **WebSocket messaging** - Real-time message delivery without public webhook
- **Rich media support** - Text, images, files, audio
- **Bot commands** - Mention-based triggering and group chat support
- **Enterprise tools**:
  - Document management (feishu_doc)
  - Chat operations (feishu_chat)
  - Knowledge base (feishu_wiki)
  - Cloud drive (feishu_drive)
  - Multidimensional tables (feishu_bitable)
  - Permission management (feishu_perm)
  - Message reactions (feishu_reaction)

## Installation

```bash
openclaw plugins install @openclaw/feishu
```

Or from local checkout:

```bash
openclaw plugins install ./extensions/feishu
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_xxxxx",
      "appSecret": "xxxxx",
      "encryptKey": "xxxxx",
      "verificationToken": "xxxxx",
      "domain": "feishu"
    }
  }
}
```

## Quick Start

1. Create a Feishu enterprise app at [Feishu Open Platform](https://open.feishu.cn/app)
2. Copy App ID and App Secret
3. Configure credentials in OpenClaw
4. Run `openclaw onboard` or `openclaw channels add`

For detailed setup instructions, see [Feishu Channel Documentation](https://docs.openclaw.ai/channels/feishu).

## Available Tools

| Tool | Description |
|------|-------------|
| `feishu_doc` | Read/write Feishu documents |
| `feishu_chat` | Chat operations (info, members) |
| `feishu_wiki` | Knowledge base operations |
| `feishu_drive` | Cloud storage management |
| `feishu_bitable` | Multidimensional table operations |
| `feishu_perm` | Permission management |
| `feishu_reaction` | Add/remove/list emoji reactions |

## Development

```bash
cd extensions/feishu
pnpm install
pnpm build
pnpm test
```

## License

MIT
