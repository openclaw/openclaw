# @openclaw/nostr

Nostr AI messaging channel plugin for OpenClaw using NIP-63 prompts and NIP-44 encryption.

## Overview

This extension adds an AI messaging channel to OpenClaw on Nostr. It enables your bot to:

- Receive encrypted NIP-63 prompts from Nostr users
- Send encrypted NIP-63 responses back
- Work with any NIP-44 compatible Nostr client (Damus, Amethyst, etc.)

## Installation

```bash
openclaw plugins install @openclaw/nostr
```

## Quick Setup

1. Generate a Nostr keypair (if you don't have one):

   ```bash
   # Using nak CLI
   nak key generate

   # Or use any Nostr key generator
   ```

2. Add to your config:

   ```json
   {
     "channels": {
       "nostr": {
         "privateKey": "${NOSTR_PRIVATE_KEY}",
         "relays": ["wss://relay.damus.io", "wss://nos.lol"]
       }
     }
   }
   ```

3. Set the environment variable:

   ```bash
   export NOSTR_PRIVATE_KEY="nsec1..."  # or hex format
   ```

4. Restart the gateway

## Configuration

| Key          | Type     | Default                                     | Description                                                |
| ------------ | -------- | ------------------------------------------- | ---------------------------------------------------------- |
| `privateKey` | string   | required                                    | Bot's private key (nsec or hex format)                     |
| `relays`     | string[] | `["wss://relay.damus.io", "wss://nos.lol"]` | WebSocket relay URLs                                       |
| `dmPolicy`   | string   | `"pairing"`                                 | Access control: `pairing`, `allowlist`, `open`, `disabled` |
| `allowFrom`  | string[] | `[]`                                        | Allowed sender pubkeys (npub or hex)                       |
| `enabled`    | boolean  | `true`                                      | Enable/disable the channel                                 |
| `name`       | string   | -                                           | Display name for the account                               |

## Session behavior

Nostr prompts are routed through OpenClaw sessions using these rules:

- If a prompt includes an `s` tag, that value is used as the session identifier.
- If no `s` tag is present, the session defaults to `sender:<sender_hex_pubkey>`.

You can use explicit sessions to keep multiple conversations with the same sender isolated:

```json
{ "channels": { "nostr": { ... } } }
```

Example prompt tags:

- `["s", "project-alpha"]` for per-topic context.
- no `s` tag for sender-default implicit session.

## Access Control

### Inbound Message Policies

- **pairing** (default): Unknown senders receive a pairing code to request access
- **allowlist**: Only pubkeys in `allowFrom` can message the bot
- **open**: Anyone can message the bot (use with caution)
- **disabled**: Inbound messages are disabled

### Example: Allowlist Mode

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "0123456789abcdef..."]
    }
  }
}
```

## Testing

### Local Relay (Recommended)

```bash
# Using strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry

# Configure openclaw to use local relay
"relays": ["ws://localhost:7777"]
```

### Automated Protocol Debug Loop (nak)

Use `nak` to run a repeatable NIP-63 smoke loop against your bot:

```bash
NOSTR_BOT_SECRET=<bot_hex_or_nsec> \
  NOSTR_SENDER_SECRET=<sender_hex_or_nsec> \
  bash extensions/nostr/scripts/nip63-debug-loop.sh \
    --iterations 5 \
    --relay ws://localhost:7777 \
    --message "Loop {{i}} with stable context" \
    --timeout 30
```

To export raw request/response traces for replay/debugging, use `--jsonl`:

```bash
NOSTR_BOT_SECRET=<bot_hex_or_nsec> \
  NOSTR_SENDER_SECRET=<sender_hex_or_nsec> \
  bash extensions/nostr/scripts/nip63-debug-loop.sh \
    --iterations 5 \
    --relay ws://localhost:7777 \
    --message "Loop {{i}} with stable context" \
    --timeout 30 \
    --jsonl /tmp/nip63-debug-loop.jsonl
```

To include AI telemetry/tool-call events (kind `25804`) in the same trace:

```bash
NOSTR_BOT_SECRET=<bot_hex_or_nsec> \
  NOSTR_SENDER_SECRET=<sender_hex_or_nsec> \
  bash extensions/nostr/scripts/nip63-debug-loop.sh \
    --iterations 5 \
    --relay ws://localhost:7777 \
    --message "Loop {{i}} with stable context" \
    --timeout 30 \
    --capture-tool-events \
    --jsonl /tmp/nip63-debug-loop.jsonl
```

Behavior checked by the script on every loop:

- Prompt publish is `kind:25802` with `encryption=nip44`
- Response is `kind:25803` and encrypted with `nip44`
- Response decrypts to JSON `{"ver":1,"text":"..."}` with non-empty `text`
- `s` tag matches the session sent in the request
- `e` thread tag points back to the request event id (can be disabled with `--no-require-thread`)
- `--jsonl` captures all loop messages as JSONL for replay/debugging
- `--capture-tool-events` records `25800/25801/25804/25805/25806` for telemetry/tool call traces

If pairing is enabled, configure sender allowlisting before running the loop:

```json
{
  "channels": {
    "nostr": {
      "dmPolicy": "allowlist",
      "allowFrom": ["<sender npub or hex>"]
    }
  }
}
```

### Manual Test

1. Start the gateway with Nostr configured
2. Open Damus, Amethyst, or another Nostr client
3. Send a NIP-63 agent prompt to your bot's npub
4. Verify the bot responds

## Protocol Support

| NIP    | Status      | Notes                                          |
| ------ | ----------- | ---------------------------------------------- |
| NIP-01 | Supported   | Basic event structure                          |
| NIP-04 | Unsupported | Replaced by NIP-44 + NIP-63 in this release    |
| NIP-63 | Supported   | AI agent prompts/responses (kinds 25802/25803) |
| NIP-44 | Supported   | Encrypted event payloads                       |
| NIP-17 | Planned     | Gift-wrapped DMs (v2)                          |

This plugin is NIP-63-only for agent messaging.

## Security Notes

- Private keys are never logged
- Event signatures are verified before processing
- Use environment variables for keys, never commit to config files
- Consider using `allowlist` mode in production

## Troubleshooting

### Bot not receiving messages

1. Verify private key is correctly configured
2. Check relay connectivity
3. Ensure `enabled` is not set to `false`
4. Check the bot's public key matches what you're sending to

### Messages not being delivered

1. Check relay URLs are correct (must use `wss://`)
2. Verify relays are online and accepting connections
3. Check for rate limiting (reduce message frequency)

## License

MIT
