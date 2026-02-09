---
summary: "Nostr DM channel sa pamamagitan ng NIP-04 na naka-encrypt na mga mensahe"
read_when:
  - Gusto mong tumanggap ang OpenClaw ng mga DM sa pamamagitan ng Nostr
  - Nagsi-setup ka ng desentralisadong pagmemensahe
title: "Nostr"
---

# Nostr

**Status:** Opsyonal na plugin (naka-disable bilang default).

17. Ang Nostr ay isang desentralisadong protocol para sa social networking. 18. Pinapagana ng channel na ito ang OpenClaw na tumanggap at tumugon sa mga naka-encrypt na direct messages (DMs) sa pamamagitan ng NIP-04.

## I-install (on demand)

### Onboarding (inirerekomenda)

- Inililista ng onboarding wizard (`openclaw onboard`) at `openclaw channels add` ang mga opsyonal na channel plugin.
- Kapag pinili ang Nostr, ipo-prompt ka nitong i-install ang plugin on demand.

Mga default sa pag-install:

- **Dev channel + available ang git checkout:** ginagamit ang lokal na path ng plugin.
- **Stable/Beta:** dina-download mula sa npm.

Maaari mong i-override ang pagpili anumang oras sa prompt.

### Manual na pag-install

```bash
openclaw plugins install @openclaw/nostr
```

Gumamit ng lokal na checkout (dev workflows):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

I-restart ang Gateway pagkatapos mag-install o mag-enable ng mga plugin.

## Mabilis na setup

1. Bumuo ng Nostr keypair (kung kinakailangan):

```bash
# Using nak
nak key generate
```

2. Idagdag sa config:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. I-export ang key:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. I-restart ang Gateway.

## Sanggunian sa konpigurasyon

| Key          | Type                                                         | Default                                     | Paglalarawan                                    |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------- |
| `privateKey` | string                                                       | required                                    | Private key sa `nsec` o hex format              |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Mga URL ng relay (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | Patakaran sa access ng DM                       |
| `allowFrom`  | string[] | `[]`                                        | Mga pinapayagang pubkey ng sender               |
| `enabled`    | boolean                                                      | `true`                                      | I-enable/i-disable ang channel                  |
| `name`       | string                                                       | -                                           | Display name                                    |
| `profile`    | object                                                       | -                                           | Metadata ng profile (NIP-01) |

## Metadata ng profile

19. Ang profile data ay inilalathala bilang isang NIP-01 `kind:0` event. 20. Maaari mo itong pamahalaan mula sa Control UI (Channels -> Nostr -> Profile) o direktang itakda sa config.

Halimbawa:

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

Mga tala:

- Dapat gumamit ang mga URL ng profile ng `https://`.
- Ang pag-import mula sa mga relay ay pinagsasama ang mga field at pinananatili ang mga lokal na override.

## Kontrol sa access

### Mga patakaran sa DM

- **pairing** (default): ang mga hindi kilalang sender ay makakatanggap ng pairing code.
- **allowlist**: tanging ang mga pubkey sa `allowFrom` ang maaaring mag-DM.
- **open**: pampublikong inbound DM (nangangailangan ng `allowFrom: ["*"]`).
- **disabled**: balewalain ang mga inbound DM.

### Halimbawa ng allowlist

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

## Mga format ng key

Mga tinatanggap na format:

- **Private key:** `nsec...` o 64-char hex
- **Mga Pubkey (`allowFrom`):** `npub...` o hex

## Mga relay

Mga default: `relay.damus.io` at `nos.lol`.

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

Mga tip:

- Gumamit ng 2–3 relay para sa redundancy.
- Iwasan ang sobrang daming relay (latency, duplication).
- Makakatulong ang mga bayad na relay para sa reliability.
- Ayos lang ang mga lokal na relay para sa testing (`ws://localhost:7777`).

## Suporta sa protocol

| NIP    | Status    | Paglalarawan                                      |
| ------ | --------- | ------------------------------------------------- |
| NIP-01 | Supported | Pangunahing format ng event + metadata ng profile |
| NIP-04 | Supported | Naka-encrypt na DM (`kind:4`)  |
| NIP-17 | Planned   | Gift-wrapped na DM                                |
| NIP-44 | Planned   | Versioned encryption                              |

## Pagsusuri

### Lokal na relay

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

### Manu-manong test

1. Tandaan ang bot pubkey (npub) mula sa logs.
2. Magbukas ng Nostr client (Damus, Amethyst, atbp.).
3. Mag-DM sa bot pubkey.
4. I-verify ang tugon.

## Pag-troubleshoot

### Hindi nakakatanggap ng mga mensahe

- I-verify na valid ang private key.
- Tiyaking naaabot ang mga URL ng relay at gumagamit ng `wss://` (o `ws://` para sa lokal).
- Kumpirmahing ang `enabled` ay hindi `false`.
- Suriin ang Gateway logs para sa mga error sa koneksyon ng relay.

### Hindi nagpapadala ng mga tugon

- Suriin kung tumatanggap ng writes ang relay.
- I-verify ang outbound connectivity.
- Bantayan ang mga rate limit ng relay.

### Dobleng mga tugon

- Inaasahan kapag gumagamit ng maraming relay.
- Ang mga mensahe ay dini-deduplicate ayon sa event ID; ang unang delivery lamang ang nagti-trigger ng tugon.

## Seguridad

- Huwag kailanman i-commit ang mga private key.
- Gumamit ng mga environment variable para sa mga key.
- Isaalang-alang ang `allowlist` para sa mga production bot.

## Mga limitasyon (MVP)

- Direct message lang (walang group chat).
- Walang media attachment.
- NIP-04 lamang (naka-planong NIP-17 gift-wrap).
