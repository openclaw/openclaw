# @openclaw/nostr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nostr DM channel plugin for OpenClaw using NIP-04 encrypted direct messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This extension adds Nostr as a messaging channel to OpenClaw. It enables your bot to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Receive encrypted DMs from Nostr users（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send encrypted responses back（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Work with any NIP-04 compatible Nostr client (Damus, Amethyst, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/nostr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Generate a Nostr keypair (if you don't have one):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Using nak CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   nak key generate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   # Or use any Nostr key generator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Add to your config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       "nostr": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         "privateKey": "${NOSTR_PRIVATE_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         "relays": ["wss://relay.damus.io", "wss://nos.lol"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Set the environment variable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   export NOSTR_PRIVATE_KEY="nsec1..."  # or hex format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Restart the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Key          | Type     | Default                                     | Description                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | -------- | ------------------------------------------- | ---------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `privateKey` | string   | required                                    | Bot's private key (nsec or hex format)                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `relays`     | string[] | `["wss://relay.damus.io", "wss://nos.lol"]` | WebSocket relay URLs                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `dmPolicy`   | string   | `"pairing"`                                 | Access control: `pairing`, `allowlist`, `open`, `disabled` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `allowFrom`  | string[] | `[]`                                        | Allowed sender pubkeys (npub or hex)                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `enabled`    | boolean  | `true`                                      | Enable/disable the channel                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `name`       | string   | -                                           | Display name for the account                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access Control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### DM Policies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **pairing** (default): Unknown senders receive a pairing code to request access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **allowlist**: Only pubkeys in `allowFrom` can message the bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **open**: Anyone can message the bot (use with caution)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **disabled**: DMs are disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example: Allowlist Mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "nostr": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "privateKey": "${NOSTR_PRIVATE_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "dmPolicy": "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "allowFrom": ["npub1abc...", "0123456789abcdef..."]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Local Relay (Recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Using strfry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker run -p 7777:7777 ghcr.io/hoytech/strfry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Configure openclaw to use local relay（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"relays": ["ws://localhost:7777"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manual Test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Start the gateway with Nostr configured（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Open Damus, Amethyst, or another Nostr client（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Send a DM to your bot's npub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Verify the bot responds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Protocol Support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| NIP    | Status    | Notes                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------ | --------- | ---------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| NIP-01 | Supported | Basic event structure  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| NIP-04 | Supported | Encrypted DMs (kind:4) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| NIP-17 | Planned   | Gift-wrapped DMs (v2)  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Private keys are never logged（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Event signatures are verified before processing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use environment variables for keys, never commit to config files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Consider using `allowlist` mode in production（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bot not receiving messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Verify private key is correctly configured（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Check relay connectivity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Ensure `enabled` is not set to `false`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Check the bot's public key matches what you're sending to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Messages not being delivered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Check relay URLs are correct (must use `wss://`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Verify relays are online and accepting connections（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Check for rate limiting (reduce message frequency)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## License（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MIT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
