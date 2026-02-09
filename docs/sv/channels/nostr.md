---
summary: "Nostr DM-kanal via NIP-04-krypterade meddelanden"
read_when:
  - Du vill att OpenClaw ska ta emot DM via Nostr
  - Du konfigurerar decentraliserad meddelandehantering
title: "Nostr"
---

# Nostr

**Status:** Valfri plugin (inaktiverad som standard).

Nostr är ett decentraliserat protokoll för socialt nätverk. Denna kanal gör det möjligt för OpenClaw att ta emot och svara på krypterade direktmeddelanden (DM) via NIP-04.

## Installera (vid behov)

### Introduktion (rekommenderas)

- Introduktionsguiden (`openclaw onboard`) och `openclaw channels add` listar valfria kanal-plugins.
- När du väljer Nostr uppmanas du att installera pluginen vid behov.

Installationsstandarder:

- **Dev-kanal + git-checkout tillgänglig:** använder den lokala plugin-sökvägen.
- **Stable/Beta:** laddar ner från npm.

Du kan alltid åsidosätta valet i prompten.

### Manuell installation

```bash
openclaw plugins install @openclaw/nostr
```

Använd en lokal checkout (dev-arbetsflöden):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Starta om Gateway efter att ha installerat eller aktiverat plugins.

## Snabbstart

1. Generera ett Nostr-nyckelpar (vid behov):

```bash
# Using nak
nak key generate
```

2. Lägg till i konfig:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Exportera nyckeln:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Starta om Gateway.

## Konfigurationsreferens

| Nyckel       | Typ                                                          | Standard                                    | Beskrivning                                                 |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------- |
| `privateKey` | string                                                       | required                                    | Privat nyckel i `nsec`- eller hex-format                    |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay-URL:er (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM-åtkomstpolicy                                            |
| `allowFrom`  | string[] | `[]`                                        | Tillåtna avsändar-pubkeys                                   |
| `enabled`    | boolean                                                      | `true`                                      | Aktivera/inaktivera kanal                                   |
| `name`       | string                                                       | -                                           | Visningsnamn                                                |
| `profile`    | object                                                       | -                                           | NIP-01-profilmetadata                                       |

## Profilmetadata

Profildata publiceras som en NIP-01 `kind:0` händelse. Du kan hantera det från styrgränssnittet (kanaler -> Nostr -> Profil) eller ställa in det direkt i konfigurationen.

Exempel:

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

Noteringar:

- Profil-URL:er måste använda `https://`.
- Import från relays sammanfogar fält och bevarar lokala åsidosättningar.

## Åtkomstkontroll

### DM-policyer

- **pairing** (standard): okända avsändare får en parkod.
- **allowlist**: endast pubkeys i `allowFrom` kan skicka DM.
- **open**: offentliga inkommande DM (kräver `allowFrom: ["*"]`).
- **disabled**: ignorera inkommande DM.

### Exempel på allowlist

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

## Nyckelformat

Accepterade format:

- **Privat nyckel:** `nsec...` eller 64-teckens hex
- **Pubkeys (`allowFrom`):** `npub...` eller hex

## Relays

Standarder: `relay.damus.io` och `nos.lol`.

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

- Använd 2–3 relays för redundans.
- Undvik för många relays (latens, duplicering).
- Betalda relays kan förbättra tillförlitligheten.
- Lokala relays fungerar bra för testning (`ws://localhost:7777`).

## Protokollstöd

| NIP    | Status   | Beskrivning                                 |
| ------ | -------- | ------------------------------------------- |
| NIP-01 | Stöds    | Grundläggande eventformat + profilmetadata  |
| NIP-04 | Stöds    | Krypterade DM (`kind:4`) |
| NIP-17 | Planerad | Presentinslagna DM                          |
| NIP-44 | Planerad | Versionshanterad kryptering                 |

## Testning

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

### Manuell test

1. Notera botens pubkey (npub) från loggarna.
2. Öppna en Nostr-klient (Damus, Amethyst, etc.).
3. Skicka DM till botens pubkey.
4. Verifiera svaret.

## Felsökning

### Tar inte emot meddelanden

- Verifiera att den privata nyckeln är giltig.
- Säkerställ att relay-URL:er är nåbara och använder `wss://` (eller `ws://` för lokalt).
- Bekräfta att `enabled` inte är `false`.
- Kontrollera Gateway-loggar för fel vid relay-anslutning.

### Skickar inte svar

- Kontrollera att relayn accepterar skrivningar.
- Verifiera utgående uppkoppling.
- Håll utkik efter relay-begränsningar.

### Dubbla svar

- Förväntat vid användning av flera relays.
- Meddelanden avdupliceras via event-ID; endast första leveransen triggar ett svar.

## Säkerhet

- Commita aldrig privata nycklar.
- Använd miljövariabler för nycklar.
- Överväg `allowlist` för produktionsbotar.

## Begränsningar (MVP)

- Endast direktmeddelanden (inga gruppchattar).
- Inga media-bilagor.
- Endast NIP-04 (NIP-17 presentinslagning planeras).
