---
summary: "CLI-Referenz für `openclaw devices` (Geräte-Pairing + Token-Rotation/-Widerruf)"
read_when:
  - Sie genehmigen Geräte-Pairing-Anfragen
  - Sie müssen Geräte-Tokens rotieren oder widerrufen
title: "Geräte"
---

# `openclaw devices`

Verwalten Sie Geräte-Pairing-Anfragen und gerätebezogene Tokens.

## Befehle

### `openclaw devices list`

Listet ausstehende Pairing-Anfragen und gekoppelte Geräte auf.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Genehmigt eine ausstehende Geräte-Pairing-Anfrage.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Lehnt eine ausstehende Geräte-Pairing-Anfrage ab.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotiert ein Geräte-Token für eine bestimmte Rolle (optional mit Aktualisierung der Scopes).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Widerruft ein Geräte-Token für eine bestimmte Rolle.

```
openclaw devices revoke --device <deviceId> --role node
```

## Gemeinsame Optionen

- `--url <url>`: Gateway-WebSocket-URL (standardmäßig `gateway.remote.url`, wenn konfiguriert).
- `--token <token>`: Gateway-Token (falls erforderlich).
- `--password <password>`: Gateway-Passwort (Passwortauthentifizierung).
- `--timeout <ms>`: RPC-Timeout.
- `--json`: JSON-Ausgabe (für Skripting empfohlen).

Hinweis: Wenn Sie `--url` setzen, greift die CLI nicht auf Konfigurations- oder Umgebungsanmeldedaten zurück.
Übergeben Sie `--token` oder `--password` explizit. Fehlende explizite Anmeldedaten sind ein Fehler.

## Hinweise

- Die Token-Rotation gibt ein neues Token zurück (sensibel). Behandeln Sie es wie ein Geheimnis.
- Diese Befehle erfordern den Scope `operator.pairing` (oder `operator.admin`).
