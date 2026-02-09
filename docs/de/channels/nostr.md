---
summary: "Nostr-DM-Kanal über NIP-04-verschlüsselte Nachrichten"
read_when:
  - Sie möchten, dass OpenClaw DMs über Nostr empfängt
  - Sie richten dezentrale Nachrichtenübermittlung ein
title: "Nostr"
---

# Nostr

**Status:** Optionales Plugin (standardmäßig deaktiviert).

Nostr ist ein dezentrales Protokoll für soziale Netzwerke. Dieser Kanal ermöglicht es OpenClaw, verschlüsselte Direktnachrichten (DMs) über NIP-04 zu empfangen und zu beantworten.

## Installation (bei Bedarf)

### Onboarding (empfohlen)

- Der Onboarding-Assistent (`openclaw onboard`) und `openclaw channels add` listen optionale Kanal-Plugins auf.
- Wenn Sie Nostr auswählen, werden Sie aufgefordert, das Plugin bei Bedarf zu installieren.

Installationsstandards:

- **Dev-Kanal + git checkout verfügbar:** verwendet den lokalen Plugin-Pfad.
- **Stable/Beta:** lädt von npm herunter.

Sie können die Auswahl jederzeit in der Abfrage überschreiben.

### Manuelle Installation

```bash
openclaw plugins install @openclaw/nostr
```

Lokalen Checkout verwenden (Dev-Workflows):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Starten Sie das Gateway nach dem Installieren oder Aktivieren von Plugins neu.

## Schnellstart

1. Nostr-Schlüsselpaar erzeugen (falls erforderlich):

```bash
# Using nak
nak key generate
```

2. Zur Konfiguration hinzufügen:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Schlüssel exportieren:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Gateway neu starten.

## Konfigurationsreferenz

| Key          | Type                                                         | Default                                     | Description                                   |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------- |
| `privateKey` | string                                                       | required                                    | Privater Schlüssel im `nsec`- oder Hex-Format |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay-URLs (WebSocket)     |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM-Zugriffsrichtlinie                         |
| `allowFrom`  | string[] | `[]`                                        | Erlaubte Absender-Pubkeys                     |
| `enabled`    | boolean                                                      | `true`                                      | Kanal aktivieren/deaktivieren                 |
| `name`       | string                                                       | -                                           | Anzeigename                                   |
| `profile`    | object                                                       | -                                           | NIP-01-Profilmetadaten                        |

## Profilmetadaten

Profildaten werden als NIP-01-`kind:0`-Event veröffentlicht. Sie können diese über die Control UI (Kanäle -> Nostr -> Profil) verwalten oder direkt in der Konfiguration setzen.

Beispiel:

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

Hinweise:

- Profil-URLs müssen `https://` verwenden.
- Das Importieren von Relays führt Felder zusammen und erhält lokale Überschreibungen.

## Zugriffskontrolle

### DM-Richtlinien

- **pairing** (Standard): Unbekannte Absender erhalten einen Pairing-Code.
- **allowlist**: Nur Pubkeys in `allowFrom` dürfen DMs senden.
- **open**: Öffentliche eingehende DMs (erfordert `allowFrom: ["*"]`).
- **disabled**: Eingehende DMs ignorieren.

### Allowlist-Beispiel

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

## Schlüsselformate

Akzeptierte Formate:

- **Privater Schlüssel:** `nsec...` oder 64-stelliges Hex
- **Pubkeys (`allowFrom`):** `npub...` oder Hex

## Relays

Standards: `relay.damus.io` und `nos.lol`.

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

Tipps:

- Verwenden Sie 2–3 Relays für Redundanz.
- Vermeiden Sie zu viele Relays (Latenz, Duplikate).
- Bezahlte Relays können die Zuverlässigkeit verbessern.
- Lokale Relays sind für Tests geeignet (`ws://localhost:7777`).

## Protokollunterstützung

| NIP    | Status      | Description                                      |
| ------ | ----------- | ------------------------------------------------ |
| NIP-01 | Unterstützt | Basis-Eventformat + Profilmetadaten              |
| NIP-04 | Unterstützt | Verschlüsselte DMs (`kind:4`) |
| NIP-17 | Geplant     | Gift-wrapped DMs                                 |
| NIP-44 | Geplant     | Versionierte Verschlüsselung                     |

## Tests

### Lokales Relay

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

### Manueller Test

1. Notieren Sie den Bot-Pubkey (npub) aus den Logs.
2. Öffnen Sie einen Nostr-Client (Damus, Amethyst usw.).
3. Senden Sie eine DM an den Bot-Pubkey.
4. Überprüfen Sie die Antwort.

## Fehlerbehebung

### Nachrichten werden nicht empfangen

- Überprüfen Sie, ob der private Schlüssel gültig ist.
- Stellen Sie sicher, dass die Relay-URLs erreichbar sind und `wss://` verwenden (oder `ws://` für lokal).
- Bestätigen Sie, dass `enabled` nicht `false` ist.
- Prüfen Sie die Gateway-Logs auf Relay-Verbindungsfehler.

### Antworten werden nicht gesendet

- Prüfen Sie, ob das Relay Schreibzugriffe akzeptiert.
- Überprüfen Sie die ausgehende Konnektivität.
- Achten Sie auf Relay-Ratenbegrenzungen.

### Doppelte Antworten

- Erwartet bei Verwendung mehrerer Relays.
- Nachrichten werden anhand der Event-ID dedupliziert; nur die erste Zustellung löst eine Antwort aus.

## Sicherheit

- Committen Sie niemals private Schlüssel.
- Verwenden Sie Umgebungsvariablen für Schlüssel.
- Erwägen Sie `allowlist` für Produktions-Bots.

## Einschränkungen (MVP)

- Nur Direktnachrichten (keine Gruppenchats).
- Keine Medienanhänge.
- Nur NIP-04 (NIP-17 Gift-Wrap geplant).
