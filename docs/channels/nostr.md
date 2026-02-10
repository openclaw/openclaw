---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Nostr DM channel via NIP-04 encrypted messages"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want OpenClaw to receive DMs via Nostr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You're setting up decentralized messaging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Nostr"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Nostr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Status:** Optional plugin (disabled by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nostr is a decentralized protocol for social networking. This channel enables OpenClaw to receive and respond to encrypted direct messages (DMs) via NIP-04.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install (on demand)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Onboarding (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The onboarding wizard (`openclaw onboard`) and `openclaw channels add` list optional channel plugins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Selecting Nostr prompts you to install the plugin on demand.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Dev channel + git checkout available:** uses the local plugin path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Stable/Beta:** downloads from npm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can always override the choice in the prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manual install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/nostr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a local checkout (dev workflows):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install --link <path-to-openclaw>/extensions/nostr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart the Gateway after installing or enabling plugins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Generate a Nostr keypair (if needed):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Using nak（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
nak key generate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Add to config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "nostr": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "privateKey": "${NOSTR_PRIVATE_KEY}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Export the key:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export NOSTR_PRIVATE_KEY="nsec1..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Restart the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Key          | Type     | Default                                     | Description                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | -------- | ------------------------------------------- | ----------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `privateKey` | string   | required                                    | Private key in `nsec` or hex format |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay URLs (WebSocket)              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `dmPolicy`   | string   | `pairing`                                   | DM access policy                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `allowFrom`  | string[] | `[]`                                        | Allowed sender pubkeys              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `enabled`    | boolean  | `true`                                      | Enable/disable channel              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `name`       | string   | -                                           | Display name                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `profile`    | object   | -                                           | NIP-01 profile metadata             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Profile metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profile data is published as a NIP-01 `kind:0` event. You can manage it from the Control UI (Channels -> Nostr -> Profile) or set it directly in config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "nostr": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "privateKey": "${NOSTR_PRIVATE_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "profile": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "name": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "displayName": "OpenClaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "about": "Personal assistant DM bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "picture": "https://example.com/avatar.png",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "banner": "https://example.com/banner.png",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "website": "https://example.com",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "nip05": "openclaw@example.com",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "lud16": "openclaw@example.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Profile URLs must use `https://`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Importing from relays merges fields and preserves local overrides.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### DM policies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **pairing** (default): unknown senders get a pairing code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **allowlist**: only pubkeys in `allowFrom` can DM.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **open**: public inbound DMs (requires `allowFrom: ["*"]`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **disabled**: ignore inbound DMs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Allowlist example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "nostr": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "privateKey": "${NOSTR_PRIVATE_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "dmPolicy": "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "allowFrom": ["npub1abc...", "npub1xyz..."]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Accepted formats:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Private key:** `nsec...` or 64-char hex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Pubkeys (`allowFrom`):** `npub...` or hex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Relays（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults: `relay.damus.io` and `nos.lol`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "nostr": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "privateKey": "${NOSTR_PRIVATE_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tips:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use 2-3 relays for redundancy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid too many relays (latency, duplication).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Paid relays can improve reliability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local relays are fine for testing (`ws://localhost:7777`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Protocol support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| NIP    | Status    | Description                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------ | --------- | ------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| NIP-01 | Supported | Basic event format + profile metadata |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| NIP-04 | Supported | Encrypted DMs (`kind:4`)              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| NIP-17 | Planned   | Gift-wrapped DMs                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| NIP-44 | Planned   | Versioned encryption                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Local relay（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Start strfry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
docker run -p 7777:7777 ghcr.io/hoytech/strfry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "channels": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "nostr": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "privateKey": "${NOSTR_PRIVATE_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "relays": ["ws://localhost:7777"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manual test（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Note the bot pubkey (npub) from logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Open a Nostr client (Damus, Amethyst, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. DM the bot pubkey.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Verify the response.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Not receiving messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify the private key is valid.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure relay URLs are reachable and use `wss://` (or `ws://` for local).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm `enabled` is not `false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check Gateway logs for relay connection errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Not sending responses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check relay accepts writes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify outbound connectivity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Watch for relay rate limits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Duplicate responses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Expected when using multiple relays.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages are deduplicated by event ID; only the first delivery triggers a response.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never commit private keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use environment variables for keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Consider `allowlist` for production bots.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limitations (MVP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct messages only (no group chats).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No media attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- NIP-04 only (NIP-17 gift-wrap planned).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
