---
summary: "Nostr DM-kanal via NIP-04-krypterede beskeder"
read_when:
  - Du vil have OpenClaw til at modtage DM'er via Nostr
  - Du er ved at opsætte decentraliseret messaging
title: "Nostr"
---

# Nostr

**Status:** Valgfrit plugin (deaktiveret som standard).

Nostr er en decentraliseret protokol til socialt netværk. Denne kanal gør det muligt for OpenClaw at modtage og reagere på krypterede direkte beskeder (DM'er) via NIP-04.

## Installér (efter behov)

### Introduktion (anbefalet)

- Introduktionsguiden (`openclaw onboard`) og `openclaw channels add` viser valgfrie kanal-plugins.
- Når du vælger Nostr, bliver du bedt om at installere plugin’et efter behov.

Standardinstallation:

- **Dev-kanal + git checkout tilgængelig:** bruger den lokale plugin-sti.
- **Stable/Beta:** downloader fra npm.

Du kan altid tilsidesætte valget i prompten.

### Manuel installation

```bash
openclaw plugins install @openclaw/nostr
```

Brug et lokalt checkout (dev-workflows):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Genstart Gateway efter installation eller aktivering af plugins.

## Hurtig opsætning

1. Generér et Nostr-nøglepar (hvis nødvendigt):

```bash
# Using nak
nak key generate
```

2. Tilføj til konfigurationen:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Eksportér nøglen:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Genstart Gateway.

## Konfigurationsreference

| Nøgle        | Type                                                         | Standard                                    | Beskrivelse                                 |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------- |
| `privateKey` | string                                                       | krævet                                      | Privat nøgle i `nsec`- eller hex-format     |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay-URL'er (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM-adgangspolitik                           |
| `allowFrom`  | string[] | `[]`                                        | Tilladte afsenderes pubkeys                 |
| `enabled`    | boolean                                                      | `true`                                      | Aktivér/deaktivér kanal                     |
| `name`       | string                                                       | -                                           | Vist navn                                   |
| `profile`    | object                                                       | -                                           | NIP-01 profilmetadata                       |

## Profilmetadata

Profildata offentliggøres som en NIP-01 `kind:0` begivenhed. Du kan håndtere det fra Control UI (Kanaler - > Nostr - > Profil) eller indstille det direkte i konfiguration.

Eksempel:

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

Noter:

- Profil-URL'er skal bruge `https://`.
- Import fra relays fletter felter og bevarer lokale tilsidesættelser.

## Adgangskontrol

### DM-politikker

- **pairing** (standard): ukendte afsendere får en parringskode.
- **allowlist**: kun pubkeys i `allowFrom` kan sende DM'er.
- **open**: offentlige indgående DM'er (kræver `allowFrom: ["*"]`).
- **disabled**: ignorér indgående DM'er.

### Eksempel på tilladelsesliste

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

## Nøgleformater

Accepterede formater:

- **Privat nøgle:** `nsec...` eller 64-tegns hex
- **Pubkeys (`allowFrom`):** `npub...` eller hex

## Relays

Standarder: `relay.damus.io` og `nos.lol`.

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

- Brug 2–3 relays for redundans.
- Undgå for mange relays (latenstid, duplikering).
- Betalte relays kan forbedre pålideligheden.
- Lokale relays er fine til test (`ws://localhost:7777`).

## Protokolunderstøttelse

| NIP    | Status       | Beskrivelse                                    |
| ------ | ------------ | ---------------------------------------------- |
| NIP-01 | Understøttet | Grundlæggende event-format + profilmetadata    |
| NIP-04 | Understøttet | Krypterede DM'er (`kind:4`) |
| NIP-17 | Planlagt     | Gaveindpakkede DM'er                           |
| NIP-44 | Planlagt     | Versioneret kryptering                         |

## Test

### Lokal relay

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

### Manuel test

1. Notér bot-pubkey (npub) fra logs.
2. Åbn en Nostr-klient (Damus, Amethyst osv.).
3. Send en DM til bot-pubkey.
4. Verificér svaret.

## Fejlfinding

### Modtager ikke beskeder

- Kontrollér, at den private nøgle er gyldig.
- Sørg for, at relay-URL'er er tilgængelige og bruger `wss://` (eller `ws://` for lokal).
- Bekræft, at `enabled` ikke er `false`.
- Tjek Gateway-logs for fejl ved relay-forbindelser.

### Sender ikke svar

- Tjek, at relay accepterer skrivninger.
- Bekræft udgående forbindelse.
- Hold øje med relay rate limits.

### Dobbelt svar

- Forventet ved brug af flere relays.
- Beskeder deduplikeres efter event-ID; kun den første levering udløser et svar.

## Sikkerhed

- Commit aldrig private nøgler.
- Brug miljøvariabler til nøgler.
- Overvej `allowlist` til produktionsbots.

## Begrænsninger (MVP)

- Kun direkte beskeder (ingen gruppechats).
- Ingen medievedhæftninger.
- Kun NIP-04 (NIP-17 gift-wrap planlagt).
