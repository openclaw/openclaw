---
summary: "Nostr AI agent messaging via NIP-63 and NIP-44 encryption"
read_when:
  - You want OpenClaw to receive NIP-63 agent messages via Nostr
  - You're setting up decentralized messaging
title: "Nostr"
---

# Nostr

**Status:** Optional plugin (disabled by default).

Nostr is a decentralized protocol for social networking. This channel enables OpenClaw to receive and respond to encrypted NIP-63 agent messages via NIP-44.

## Install (on demand)

### Onboarding (recommended)

- The onboarding wizard (`openclaw onboard`) and `openclaw channels add` list optional channel plugins.
- Selecting Nostr prompts you to install the plugin on demand.

Install defaults:

- **Dev channel + git checkout available:** uses the local plugin path.
- **Stable/Beta:** downloads from npm.

You can always override the choice in the prompt.

### Manual install

```bash
openclaw plugins install @openclaw/nostr
```

Use a local checkout (dev workflows):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Restart the Gateway after installing or enabling plugins.

## Quick setup

1. Generate a Nostr keypair (if needed):

```bash
# Using nak
nak key generate
```

2. Add to config:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Export the key:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Restart the Gateway.

## Configuration reference

| Key          | Type     | Default                                     | Description                         |
| ------------ | -------- | ------------------------------------------- | ----------------------------------- |
| `privateKey` | string   | required                                    | Private key in `nsec` or hex format |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay URLs (WebSocket)              |
| `dmPolicy`   | string   | `pairing`                                   | Inbound message access policy       |
| `allowFrom`  | string[] | `[]`                                        | Allowed sender pubkeys              |
| `enabled`    | boolean  | `true`                                      | Enable/disable channel              |
| `name`       | string   | -                                           | Display name                        |
| `profile`    | object   | -                                           | NIP-01 profile metadata             |

## Profile metadata

Profile data is published as a NIP-01 `kind:0` event. You can manage it from the Control UI (Channels -> Nostr -> Profile) or set it directly in config.

Example:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

Notes:

- Profile URLs must use `https://`.
- Importing from relays merges fields and preserves local overrides.

## Access control

### Inbound message policies

- **pairing** (default): unknown senders get a pairing code.
- **allowlist**: only pubkeys in `allowFrom` can message.
- **open**: public inbound messages (requires `allowFrom: ["*"]`).
- **disabled**: ignore inbound messages.

### Allowlist example

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Key formats

Accepted formats:

- **Private key:** `nsec...` or 64-char hex
- **Pubkeys (`allowFrom`):** `npub...` or hex

## Relays

Defaults: `relay.damus.io` and `nos.lol`.

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

Tips:

- Use 2-3 relays for redundancy.
- Avoid too many relays (latency, duplication).
- Paid relays can improve reliability.
- Local relays are fine for testing (`ws://localhost:7777`).

## Protocol support

| NIP    | Status      | Description                                         |
| ------ | ----------- | --------------------------------------------------- |
| NIP-01 | Supported   | Basic event format + profile metadata               |
| NIP-04 | Unsupported | Replaced by NIP-44 + NIP-63 in this release         |
| NIP-44 | Supported   | Encrypted content and key exchange                  |
| NIP-63 | Supported   | AI agent prompts and responses (`kind:25802/25803`) |
| NIP-17 | Planned     | Gift-wrapped DMs                                    |

Current behavior is NIP-63-only for agent messaging: NIP-04 encrypted DMs are no longer processed.

## Session behavior

OpenClaw uses these NIP-63 session rules:

- If an incoming `25802` event has an `s` tag, that exact value becomes the conversation session.
- If no `s` tag is present, OpenClaw falls back to `sender:<pubkey>`.
- Replies include the same session via `s` tag when an explicit session is active.

## Testing

### Local relay

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Automated protocol loop with `nak`

Use this loop script for protocol-accurate end-to-end checks:

```bash
NOSTR_BOT_SECRET=<bot_hex_or_nsec> \
  NOSTR_SENDER_SECRET=<sender_hex_or_nsec> \
  bash ./extensions/nostr/scripts/nip63-debug-loop.sh \
    --iterations 5 \
    --relay ws://localhost:7777 \
    --timeout 30 \
    --message "NIP-63 smoke {{i}}"
```

Each cycle validates:

- Outbound prompt is `kind:25802` with `encryption=nip44`.
- Response is `kind:25803` with `encryption=nip44`.
- Response decrypts to JSON `{"ver":1,"text":"..."}` with non-empty `text`.
- `s` and `e` tags match the request session and event id.

### Manual test

1. Note the bot pubkey (npub) from logs.
2. Open a Nostr client (Damus, Amethyst, etc.).
3. Send a NIP-63 prompt to the bot pubkey.
4. Verify the response.

## Troubleshooting

### Not receiving messages

- Verify the private key is valid.
- Ensure relay URLs are reachable and use `wss://` (or `ws://` for local).
- Confirm `enabled` is not `false`.
- Check Gateway logs for relay connection errors.

### Not sending responses

- Check relay accepts writes.
- Verify outbound connectivity.
- Watch for relay rate limits.

### Duplicate responses

- Expected when using multiple relays.
- Messages are deduplicated by event ID; only the first delivery triggers a response.

## Security

- Never commit private keys.
- Use environment variables for keys.
- Consider `allowlist` for production bots.

## Limitations (MVP)

- Direct messages only (no group chats).
- No media attachments.
- NIP-63 only (NIP-17 gift-wrap planned).
