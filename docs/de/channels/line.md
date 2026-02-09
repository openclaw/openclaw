---
summary: "„Einrichtung, Konfiguration und Nutzung des LINE Messaging API Plugins“"
read_when:
  - Sie möchten OpenClaw mit LINE verbinden
  - Sie benötigen die Einrichtung von LINE-Webhooks und Zugangsdaten
  - Sie möchten LINE-spezifische Nachrichtenoptionen nutzen
title: LINE
---

# LINE (Plugin)

LINE verbindet sich über die LINE Messaging API mit OpenClaw. Das Plugin läuft als
Webhook-Empfänger auf dem Gateway und verwendet Ihr Channel Access Token und das
Channel Secret zur Authentifizierung.

Status: Über Plugin unterstützt. Direktnachrichten, Gruppenchats, Medien, Standorte,
Flex-Nachrichten, Vorlagen-Nachrichten und Schnellantworten werden unterstützt. Reaktionen und Threads werden nicht unterstützt.

## Erforderliches Plugin

Installieren Sie das LINE-Plugin:

```bash
openclaw plugins install @openclaw/line
```

Lokaler Checkout (bei Ausführung aus einem Git-Repository):

```bash
openclaw plugins install ./extensions/line
```

## Einrichtung

1. Erstellen Sie ein LINE Developers-Konto und öffnen Sie die Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Erstellen Sie einen Provider (oder wählen Sie einen bestehenden aus) und fügen Sie
   einen **Messaging API**-Kanal hinzu.
3. Kopieren Sie das **Channel access token** und das **Channel secret** aus den
   Kanaleinstellungen.
4. Aktivieren Sie **Use webhook** in den Messaging API-Einstellungen.
5. Setzen Sie die Webhook-URL auf den Gateway-Endpunkt (HTTPS erforderlich):

```
https://gateway-host/line/webhook
```

Das Gateway antwortet auf die Webhook-Verifizierung von LINE (GET) und eingehende
Ereignisse (POST).
Wenn Sie einen benutzerdefinierten Pfad benötigen, setzen Sie
`channels.line.webhookPath` oder `channels.line.accounts.<id>.webhookPath` und passen Sie die URL entsprechend an.

## Konfiguration

Minimale Konfiguration:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Env-vars (nur Standardkonto):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Token-/Secret-Dateien:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Mehrere Konten:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Zugriffskontrolle

Direktnachrichten verwenden standardmäßig Pairing. Unbekannte Absender erhalten
einen Pairing-Code, und ihre Nachrichten werden ignoriert, bis sie genehmigt sind.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Allowlists und Richtlinien:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: allowlistete LINE-Benutzer-IDs für Direktnachrichten
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: allowlistete LINE-Benutzer-IDs für Gruppen
- Pro-Gruppen-Overrides: `channels.line.groups.<groupId>.allowFrom`

LINE-IDs sind case-sensitiv. Gültige IDs sehen wie folgt aus:

- Benutzer: `U` + 32 Hex-Zeichen
- Gruppe: `C` + 32 Hex-Zeichen
- Raum: `R` + 32 Hex-Zeichen

## Nachrichtenverhalten

- Text wird bei 5000 Zeichen aufgeteilt.
- Markdown-Formatierung wird entfernt; Codeblöcke und Tabellen werden, wenn möglich,
  in Flex-Karten umgewandelt.
- Streaming-Antworten werden gepuffert; LINE erhält vollständige Chunks mit einer
  Ladeanimation, während der Agent arbeitet.
- Medien-Downloads werden durch `channels.line.mediaMaxMb` begrenzt (Standard: 10).

## Kanaldaten (Rich Messages)

Verwenden Sie `channelData.line`, um Schnellantworten, Standorte, Flex-Karten oder
Vorlagen-Nachrichten zu senden.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

Das LINE-Plugin enthält außerdem einen `/card`-Befehl für Flex-Nachrichten-
Presets:

```
/card info "Welcome" "Thanks for joining!"
```

## Fehlerbehebung

- **Webhook-Verifizierung schlägt fehl:** Stellen Sie sicher, dass die Webhook-URL
  HTTPS verwendet und dass `channelSecret` mit der LINE-Console übereinstimmt.
- **Keine eingehenden Ereignisse:** Prüfen Sie, ob der Webhook-Pfad mit
  `channels.line.webhookPath` übereinstimmt und dass das Gateway von LINE erreichbar ist.
- **Fehler beim Medien-Download:** Erhöhen Sie `channels.line.mediaMaxMb`, wenn Medien die
  Standardbegrenzung überschreiten.
