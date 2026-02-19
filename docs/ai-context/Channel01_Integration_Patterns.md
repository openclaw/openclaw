# Channel Integration Patterns

## Overview

MAIBOT supports multiple messaging channels through a plugin architecture.

## Supported Channels

**Core Channels** (src/channels/):
- WhatsApp (Baileys web gateway)
- Telegram (grammy SDK)
- Discord (discord-api-types)
- Slack (@slack/bolt)
- Signal
- iMessage

**Extension Channels** (extensions/):
- BlueBubbles (extensions/bluebubbles-channel/)
- Google Chat (extensions/google-chat-channel/)
- Microsoft Teams (extensions/msteams-channel/)
- Matrix (extensions/matrix-channel/)
- Zalo (extensions/zalo-channel/)

## Adding New Channel

1. Create extension in `extensions/[channel-name]-channel/`
2. Implement ChannelProvider interface
3. Add routing logic in gateway
4. Configure allowlist/blocklist
5. Add to .github/labeler.yml for PR labeling
6. Document in docs/channels/

## Message Routing

Gateway routes messages based on:
- Channel type
- User allowlist/blocklist
- Command gating (some commands restricted by channel)
- Pairing state (for device pairing flows)

---

**References**:
- Channel Plugin SDK: src/plugins/
- Gateway Routing: src/gateway/
- Channel Docs: docs/channels/

*Last updated: 2026-01-30*

