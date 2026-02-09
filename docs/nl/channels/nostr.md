---
summary: "Nostr-DM-kanaal via NIP-04-versleutelde berichten"
read_when:
  - Je wilt dat OpenClaw DM's ontvangt via Nostr
  - Je bent bezig met het opzetten van gedecentraliseerde berichtgeving
title: "Nostr"
---

# Nostr

**Status:** Optionele plugin (standaard uitgeschakeld).

Nostr is een gedecentraliseerd protocol voor sociale netwerken. Dit kanaal stelt OpenClaw in staat om versleutelde directe berichten (DM's) te ontvangen en erop te reageren via NIP-04.

## Installeren (op aanvraag)

### Onboarding (aanbevolen)

- De onboarding-wizard (`openclaw onboard`) en `openclaw channels add` tonen optionele kanaal-plugins.
- Door Nostr te selecteren, wordt je gevraagd de plugin op aanvraag te installeren.

Installatiestandaarden:

- **Dev-kanaal + git-checkout beschikbaar:** gebruikt het lokale pluginpad.
- **Stable/Beta:** downloadt vanaf npm.

Je kunt de keuze altijd overschrijven in de prompt.

### Handmatige installatie

```bash
openclaw plugins install @openclaw/nostr
```

Gebruik een lokale checkout (dev-workflows):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Herstart de Gateway na het installeren of inschakelen van plugins.

## Snelle start

1. Genereer een Nostr-sleutelpaar (indien nodig):

```bash
# Using nak
nak key generate
```

2. Voeg toe aan de config:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Exporteer de sleutel:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Herstart de Gateway.

## Configuratie referentie

| Sleutel      | Type                                                         | Standaard                                   | Beschrijving                               |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------ |
| `privateKey` | string                                                       | vereist                                     | Privésleutel in `nsec`- of hex-indeling    |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay-URL's (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM-toegangsbeleid                          |
| `allowFrom`  | string[] | `[]`                                        | Toegestane afzender-pubkeys                |
| `enabled`    | boolean                                                      | `true`                                      | Kanaal in-/uitschakelen                    |
| `name`       | string                                                       | -                                           | Weergavenaam                               |
| `profile`    | object                                                       | -                                           | NIP-01-profielmetadata                     |

## Profielmetadata

Profielgegevens worden gepubliceerd als een NIP-01-`kind:0`-event. Je kunt dit beheren via de Control UI (Channels -> Nostr -> Profile) of het direct in de config instellen.

Voorbeeld:

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

Notities:

- Profiel-URL's moeten `https://` gebruiken.
- Importeren vanaf relays voegt velden samen en behoudt lokale overschrijvingen.

## Toegangs beheer

### DM-beleid

- **pairing** (standaard): onbekende afzenders krijgen een koppelcode.
- **allowlist**: alleen pubkeys in `allowFrom` kunnen DM'en.
- **open**: openbare inkomende DM's (vereist `allowFrom: ["*"]`).
- **disabled**: inkomende DM's negeren.

### Voorbeeld toegestane lijst

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

## Sleutel formaten

Geaccepteerde indelingen:

- **Privésleutel:** `nsec...` of 64-tekens hex
- **Pubkeys (`allowFrom`):** `npub...` of hex

## Relays

Standaarden: `relay.damus.io` en `nos.lol`.

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

- Gebruik 2-3 relays voor redundantie.
- Vermijd te veel relays (latentie, duplicatie).
- Betaalde relays kunnen de betrouwbaarheid verbeteren.
- Lokale relays zijn prima voor testen (`ws://localhost:7777`).

## Protocolondersteuning

| NIP    | Status      | Beschrijving                                    |
| ------ | ----------- | ----------------------------------------------- |
| NIP-01 | Ondersteund | Basis event-indeling + profielmetadata          |
| NIP-04 | Ondersteund | Versleutelde DM's (`kind:4`) |
| NIP-17 | Gepland     | Gift-wrapped DM's                               |
| NIP-44 | Gepland     | Versiegebonden encryptie                        |

## Testen

### Lokale relay

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

### Handmatige test

1. Noteer de bot-pubkey (npub) uit de logs.
2. Open een Nostr-client (Damus, Amethyst, enz.).
3. Stuur een DM naar de bot-pubkey.
4. Verifieer de reactie.

## Problemen oplossen

### Geen berichten ontvangen

- Controleer of de privésleutel geldig is.
- Zorg dat relay-URL's bereikbaar zijn en `wss://` gebruiken (of `ws://` voor lokaal).
- Bevestig dat `enabled` niet `false` is.
- Controleer Gateway-logs op relay-verbindingsfouten.

### Geen reacties verzenden

- Controleer of de relay schrijfbewerkingen accepteert.
- Verifieer uitgaande connectiviteit.
- Let op relay-rate limits.

### Dubbele reacties

- Verwacht bij gebruik van meerdere relays.
- Berichten worden gededupliceerd op event-ID; alleen de eerste levering triggert een reactie.

## Beveiliging

- Commit nooit privésleutels.
- Gebruik omgevingsvariabelen voor sleutels.
- Overweeg `allowlist` voor productie-bots.

## Beperkingen (MVP)

- Alleen directe berichten (geen groepschats).
- Geen media-bijlagen.
- Alleen NIP-04 (NIP-17 gift-wrap gepland).
