---
summary: "„Konfiguration und Einrichtung eines Twitch-Chatbots“"
read_when:
  - Einrichten der Twitch-Chat-Integration für OpenClaw
title: "„Twitch“"
---

# Twitch (Plugin)

Twitch-Chat-Unterstützung über eine IRC-Verbindung. OpenClaw verbindet sich als Twitch-Benutzer (Bot-Konto), um Nachrichten in Kanälen zu empfangen und zu senden.

## Erforderliches Plugin

Twitch wird als Plugin ausgeliefert und ist nicht im Core-Installationsumfang enthalten.

Installation per CLI (npm-Registry):

```bash
openclaw plugins install @openclaw/twitch
```

Lokaler Checkout (bei Ausführung aus einem Git-Repository):

```bash
openclaw plugins install ./extensions/twitch
```

Details: [Plugins](/tools/plugin)

## Schnellstart (Anfänger)

1. Erstellen Sie ein dediziertes Twitch-Konto für den Bot (oder verwenden Sie ein bestehendes Konto).
2. Generieren Sie Anmeldedaten: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Wählen Sie **Bot Token**
   - Stellen Sie sicher, dass die Scopes `chat:read` und `chat:write` ausgewählt sind
   - Kopieren Sie die **Client ID** und das **Access Token**
3. Finden Sie Ihre Twitch-Benutzer-ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Konfigurieren Sie das Token:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (nur Standardkonto)
   - Oder Konfiguration: `channels.twitch.accessToken`
   - Wenn beides gesetzt ist, hat die Konfiguration Vorrang (Env-Fallback gilt nur für das Standardkonto).
5. Starten Sie das Gateway.

**⚠️ Wichtig:** Fügen Sie eine Zugriffskontrolle (`allowFrom` oder `allowedRoles`) hinzu, um zu verhindern, dass nicht autorisierte Benutzer den Bot auslösen. `requireMention` ist standardmäßig `true`.

Minimale Konfiguration:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Was es ist

- Ein Twitch-Kanal, der dem Gateway gehört.
- Deterministisches Routing: Antworten gehen immer zurück zu Twitch.
- Jedes Konto wird einer isolierten Sitzungskennung `agent:<agentId>:twitch:<accountName>` zugeordnet.
- `username` ist das Konto des Bots (authentifiziert), `channel` ist der Chatraum, dem beigetreten wird.

## Einrichtung (detailliert)

### Anmeldedaten generieren

Verwenden Sie den [Twitch Token Generator](https://twitchtokengenerator.com/):

- Wählen Sie **Bot Token**
- Stellen Sie sicher, dass die Scopes `chat:read` und `chat:write` ausgewählt sind
- Kopieren Sie die **Client ID** und das **Access Token**

Keine manuelle App-Registrierung erforderlich. Tokens laufen nach mehreren Stunden ab.

### Bot konfigurieren

**Umgebungsvariable (nur Standardkonto):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Oder Konfiguration:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

Wenn sowohl Env als auch Konfiguration gesetzt sind, hat die Konfiguration Vorrang.

### Zugriffskontrolle (empfohlen)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Bevorzugen Sie `allowFrom` für eine harte Allowlist. Verwenden Sie alternativ `allowedRoles`, wenn Sie rollenbasierte Zugriffe wünschen.

**Verfügbare Rollen:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Warum Benutzer-IDs?** Benutzernamen können sich ändern und so Identitätsdiebstahl ermöglichen. Benutzer-IDs sind dauerhaft.

Finden Sie Ihre Twitch-Benutzer-ID: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Konvertieren Sie Ihren Twitch-Benutzernamen in eine ID)

## Token-Aktualisierung (optional)

Tokens aus dem [Twitch Token Generator](https://twitchtokengenerator.com/) können nicht automatisch aktualisiert werden – regenerieren Sie sie nach Ablauf.

Für automatische Token-Aktualisierung erstellen Sie eine eigene Twitch-Anwendung in der [Twitch Developer Console](https://dev.twitch.tv/console) und fügen Sie sie der Konfiguration hinzu:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

Der Bot aktualisiert Tokens automatisch vor Ablauf und protokolliert Aktualisierungsereignisse.

## Multi-Account-Unterstützung

Verwenden Sie `channels.twitch.accounts` mit kontospezifischen Tokens. Siehe [`gateway/configuration`](/gateway/configuration) für das gemeinsame Muster.

Beispiel (ein Bot-Konto in zwei Kanälen):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Hinweis:** Jedes Konto benötigt ein eigenes Token (ein Token pro Kanal).

## Zugriffskontrolle

### Rollenbasierte Einschränkungen

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Allowlist nach Benutzer-ID (am sichersten)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Rollenbasierter Zugriff (Alternative)

`allowFrom` ist eine harte Allowlist. Wenn gesetzt, sind nur diese Benutzer-IDs erlaubt.
Wenn Sie rollenbasierten Zugriff wünschen, lassen Sie `allowFrom` unset und konfigurieren Sie stattdessen `allowedRoles`:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### @mention-Anforderung deaktivieren

Standardmäßig ist `requireMention` auf `true` gesetzt. Um zu deaktivieren und auf alle Nachrichten zu antworten:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Fehlerbehebung

Führen Sie zunächst Diagnosebefehle aus:

```bash
openclaw doctor
openclaw channels status --probe
```

### Bot reagiert nicht auf Nachrichten

**Zugriffskontrolle prüfen:** Stellen Sie sicher, dass Ihre Benutzer-ID in `allowFrom` enthalten ist, oder entfernen Sie vorübergehend
`allowFrom` und setzen Sie `allowedRoles: ["all"]` zum Testen.

**Prüfen, ob der Bot im Kanal ist:** Der Bot muss dem in `channel` angegebenen Kanal beitreten.

### Token-Probleme

**„Failed to connect“ oder Authentifizierungsfehler:**

- Stellen Sie sicher, dass `accessToken` der OAuth-Access-Token-Wert ist (beginnt typischerweise mit dem Präfix `oauth:`)
- Prüfen Sie, dass das Token die Scopes `chat:read` und `chat:write` besitzt
- Wenn Sie Token-Aktualisierung verwenden, stellen Sie sicher, dass `clientSecret` und `refreshToken` gesetzt sind

### Token-Aktualisierung funktioniert nicht

**Protokolle auf Aktualisierungsereignisse prüfen:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Wenn Sie „token refresh disabled (no refresh token)“ sehen:

- Stellen Sie sicher, dass `clientSecret` bereitgestellt ist
- Stellen Sie sicher, dass `refreshToken` bereitgestellt ist

## Konfiguration

**Konto-Konfiguration:**

- `username` – Bot-Benutzername
- `accessToken` – OAuth-Access-Token mit `chat:read` und `chat:write`
- `clientId` – Twitch Client ID (vom Token Generator oder Ihrer App)
- `channel` – Beizutretender Kanal (erforderlich)
- `enabled` – Dieses Konto aktivieren (Standard: `true`)
- `clientSecret` – Optional: Für automatische Token-Aktualisierung
- `refreshToken` – Optional: Für automatische Token-Aktualisierung
- `expiresIn` – Token-Ablauf in Sekunden
- `obtainmentTimestamp` – Zeitstempel des Token-Erhalts
- `allowFrom` – Benutzer-ID-Allowlist
- `allowedRoles` – Rollenbasierte Zugriffskontrolle (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` – @mention erforderlich (Standard: `true`)

**Anbieteroptionen:**

- `channels.twitch.enabled` – Kanalstart aktivieren/deaktivieren
- `channels.twitch.username` – Bot-Benutzername (vereinfachte Single-Account-Konfiguration)
- `channels.twitch.accessToken` – OAuth-Access-Token (vereinfachte Single-Account-Konfiguration)
- `channels.twitch.clientId` – Twitch Client ID (vereinfachte Single-Account-Konfiguration)
- `channels.twitch.channel` – Beizutretender Kanal (vereinfachte Single-Account-Konfiguration)
- `channels.twitch.accounts.<accountName>` – Multi-Account-Konfiguration (alle oben genannten Kontofelder)

Vollständiges Beispiel:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Tool-Aktionen

Der Agent kann `twitch` mit der Aktion aufrufen:

- `send` – Eine Nachricht an einen Kanal senden

Beispiel:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Sicherheit & Betrieb

- **Behandeln Sie Tokens wie Passwörter** – Tokens niemals in Git committen
- **Automatische Token-Aktualisierung verwenden** für langlaufende Bots
- **Allowlists nach Benutzer-ID verwenden** statt Benutzernamen für die Zugriffskontrolle
- **Protokolle überwachen** auf Token-Aktualisierungsereignisse und Verbindungsstatus
- **Scopes minimal halten** – Nur `chat:read` und `chat:write` anfordern
- **Wenn Sie feststecken**: Starten Sie das Gateway neu, nachdem Sie bestätigt haben, dass kein anderer Prozess die Sitzung besitzt

## Limits

- **500 Zeichen** pro Nachricht (automatisch an Wortgrenzen aufgeteilt)
- Markdown wird vor dem Aufteilen entfernt
- Keine eigene Ratenbegrenzung (verwendet die integrierten Twitch-Ratenlimits)
