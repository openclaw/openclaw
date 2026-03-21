# Tlon (OpenClaw plugin)

Tlon/Urbit channel plugin for OpenClaw. Supports DMs, group mentions, and thread replies via decentralized messaging on Urbit.

## Setup

```bash
openclaw channel add tlon
```

Full setup instructions: https://docs.openclaw.ai/channels/tlon

## Features

- Direct messages and group chats
- Thread replies
- Media support via S3 presigned URLs
- Urbit address resolution

## Dependencies

- `@tloncorp/tlon-skill` - Tlon API client
- `@urbit/aura` - Urbit address parsing
- `@aws-sdk/client-s3` - Media upload support
