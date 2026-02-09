---
summary: "Supportstatus, Fähigkeiten und Konfiguration für Nextcloud Talk"
read_when:
  - Arbeiten an Funktionen des Nextcloud-Talk-Kanals
title: "Nextcloud Talk"
---

# Nextcloud Talk (Plugin)

Status: Unterstützt über Plugin (Webhook-Bot). Direktnachrichten, Räume, Reaktionen und Markdown-Nachrichten werden unterstützt.

## Plugin erforderlich

Nextcloud Talk wird als Plugin ausgeliefert und ist nicht im Core-Installationsumfang enthalten.

Installation über CLI (npm-Registry):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Lokaler Checkout (bei Ausführung aus einem Git-Repo):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Wenn Sie Nextcloud Talk während der Konfiguration/des Onboardings auswählen und ein Git-Checkout erkannt wird,
bietet OpenClaw den lokalen Installationspfad automatisch an.

Details: [Plugins](/tools/plugin)

## Schnellstart (Einsteiger)

1. Installieren Sie das Nextcloud-Talk-Plugin.

2. Erstellen Sie auf Ihrem Nextcloud-Server einen Bot:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Aktivieren Sie den Bot in den Einstellungen des Zielraums.

4. Konfigurieren Sie OpenClaw:
   - Konfiguration: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Oder env: `NEXTCLOUD_TALK_BOT_SECRET` (nur Standardkonto)

5. Starten Sie das Gateway neu (oder schließen Sie das Onboarding ab).

Minimale Konfiguration:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Hinweise

- Bots können keine Direktnachrichten initiieren. Der Benutzer muss den Bot zuerst anschreiben.
- Die Webhook-URL muss vom Gateway erreichbar sein; setzen Sie `webhookPublicUrl`, wenn Sie sich hinter einem Proxy befinden.
- Medien-Uploads werden von der Bot-API nicht unterstützt; Medien werden als URLs gesendet.
- Die Webhook-Nutzlast unterscheidet nicht zwischen Direktnachrichten und Räumen; setzen Sie `apiUser` + `apiPassword`, um Raumtyp-Abfragen zu aktivieren (andernfalls werden Direktnachrichten als Räume behandelt).

## Zugriffskontrolle (Direktnachrichten)

- Standard: `channels.nextcloud-talk.dmPolicy = "pairing"`. Unbekannte Absender erhalten einen Kopplungscode.
- Freigabe über:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Öffentliche Direktnachrichten: `channels.nextcloud-talk.dmPolicy="open"` plus `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` entspricht ausschließlich Nextcloud-Benutzer-IDs; Anzeigenamen werden ignoriert.

## Räume (Gruppen)

- Standard: `channels.nextcloud-talk.groupPolicy = "allowlist"` (erwähnungsbasiert).
- Räume über Allowlist zulassen mit `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Um keine Räume zuzulassen, lassen Sie die Allowlist leer oder setzen Sie `channels.nextcloud-talk.groupPolicy="disabled"`.

## Fähigkeiten

| Funktion          | Status            |
| ----------------- | ----------------- |
| Direktnachrichten | Unterstützt       |
| Räume             | Unterstützt       |
| Threads           | Nicht unterstützt |
| Medien            | Nur URL           |
| Reaktionen        | Unterstützt       |
| Native Befehle    | Nicht unterstützt |

## Konfigurationsreferenz (Nextcloud Talk)

Vollständige Konfiguration: [Konfiguration](/gateway/configuration)

Anbieteroptionen:

- `channels.nextcloud-talk.enabled`: Kanalstart aktivieren/deaktivieren.
- `channels.nextcloud-talk.baseUrl`: URL der Nextcloud-Instanz.
- `channels.nextcloud-talk.botSecret`: Gemeinsames Geheimnis des Bots.
- `channels.nextcloud-talk.botSecretFile`: Pfad zur Geheimnisdatei.
- `channels.nextcloud-talk.apiUser`: API-Benutzer für Raumabfragen (DM-Erkennung).
- `channels.nextcloud-talk.apiPassword`: API-/App-Passwort für Raumabfragen.
- `channels.nextcloud-talk.apiPasswordFile`: Pfad zur API-Passwortdatei.
- `channels.nextcloud-talk.webhookPort`: Webhook-Listener-Port (Standard: 8788).
- `channels.nextcloud-talk.webhookHost`: Webhook-Host (Standard: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: Webhook-Pfad (Standard: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: Extern erreichbare Webhook-URL.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM-Allowlist (Benutzer-IDs). `open` erfordert `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: Gruppen-Allowlist (Benutzer-IDs).
- `channels.nextcloud-talk.rooms`: Raumbezogene Einstellungen und Allowlist.
- `channels.nextcloud-talk.historyLimit`: Gruppen-Verlaufslimit (0 deaktiviert).
- `channels.nextcloud-talk.dmHistoryLimit`: DM-Verlaufslimit (0 deaktiviert).
- `channels.nextcloud-talk.dms`: Pro-DM-Überschreibungen (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: Größe der ausgehenden Text-Chunks (Zeichen).
- `channels.nextcloud-talk.chunkMode`: `length` (Standard) oder `newline`, um vor dem Längen-Chunking an Leerzeilen (Absatzgrenzen) zu trennen.
- `channels.nextcloud-talk.blockStreaming`: Block-Streaming für diesen Kanal deaktivieren.
- `channels.nextcloud-talk.blockStreamingCoalesce`: Tuning für das Zusammenführen von Block-Streaming.
- `channels.nextcloud-talk.mediaMaxMb`: Limit für eingehende Medien (MB).
