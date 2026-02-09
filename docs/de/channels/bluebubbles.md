---
summary: "„iMessage über den BlueBubbles‑macOS‑Server (REST Senden/Empfangen, Tippen, Reaktionen, Pairing, erweiterte Aktionen).“"
read_when:
  - Einrichten des BlueBubbles‑Kanals
  - Fehlerbehebung beim Webhook‑Pairing
  - Konfigurieren von iMessage auf macOS
title: "„BlueBubbles“"
---

# BlueBubbles (macOS REST)

Status: Gebündeltes Plugin, das über HTTP mit dem BlueBubbles‑macOS‑Server kommuniziert. **Empfohlen für die iMessage‑Integration** aufgrund der umfangreicheren API und der einfacheren Einrichtung im Vergleich zum Legacy‑imsg‑Kanal.

## Überblick

- Läuft auf macOS über die BlueBubbles‑Helper‑App ([bluebubbles.app](https://bluebubbles.app)).
- Empfohlen/getestet: macOS Sequoia (15). macOS Tahoe (26) funktioniert; Bearbeiten ist derzeit auf Tahoe defekt, und Gruppen‑Icon‑Updates können Erfolg melden, ohne zu synchronisieren.
- OpenClaw kommuniziert über die REST‑API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Eingehende Nachrichten kommen über Webhooks; ausgehende Antworten, Tippanzeigen, Lesebestätigungen und Tapbacks erfolgen per REST‑Aufrufen.
- Anhänge und Sticker werden als eingehende Medien verarbeitet (und nach Möglichkeit dem Agenten bereitgestellt).
- Pairing/Allowlist funktioniert wie bei anderen Kanälen (`/channels/pairing` usw.) mit `channels.bluebubbles.allowFrom` + Pairing‑Codes.
- Reaktionen werden als Systemereignisse angezeigt, genau wie bei Slack/Telegram, sodass Agenten sie vor dem Antworten „erwähnen“ können.
- Erweiterte Funktionen: Bearbeiten, Zurückziehen, Antwort‑Threading, Nachrichteneffekte, Gruppenverwaltung.

## Schnellstart

1. Installieren Sie den BlueBubbles‑Server auf Ihrem Mac (folgen Sie den Anweisungen unter [bluebubbles.app/install](https://bluebubbles.app/install)).

2. Aktivieren Sie in der BlueBubbles‑Konfiguration die Web‑API und setzen Sie ein Passwort.

3. Führen Sie `openclaw onboard` aus und wählen Sie BlueBubbles, oder konfigurieren Sie manuell:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Richten Sie die BlueBubbles‑Webhooks auf Ihr Gateway (Beispiel: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Starten Sie das Gateway; es registriert den Webhook‑Handler und beginnt mit dem Pairing.

## Messages.app aktiv halten (VM‑/Headless‑Setups)

Einige macOS‑VM‑/Always‑On‑Setups können dazu führen, dass Messages.app „idle“ geht (eingehende Ereignisse stoppen, bis die App geöffnet/in den Vordergrund gebracht wird). Ein einfacher Workaround ist, **Messages alle 5 Minuten anzustoßen** – per AppleScript + LaunchAgent.

### 1. AppleScript speichern

Speichern Sie dies als:

- `~/Scripts/poke-messages.scpt`

Beispielskript (nicht interaktiv; stiehlt keinen Fokus):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. LaunchAgent installieren

Speichern Sie dies als:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Hinweise:

- Dies läuft **alle 300 Sekunden** und **bei Anmeldung**.
- Der erste Lauf kann macOS‑**Automation**‑Aufforderungen auslösen (`osascript` → Messages). Genehmigen Sie diese in derselben Benutzersitzung, in der der LaunchAgent läuft.

Laden:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles ist im interaktiven Einrichtungsassistenten verfügbar:

```
openclaw onboard
```

Der Assistent fragt ab:

- **Server‑URL** (erforderlich): Adresse des BlueBubbles‑Servers (z. B. `http://192.168.1.100:1234`)
- **Passwort** (erforderlich): API‑Passwort aus den BlueBubbles‑Servereinstellungen
- **Webhook‑Pfad** (optional): Standard ist `/bluebubbles-webhook`
- **DM‑Richtlinie**: Pairing, Allowlist, offen oder deaktiviert
- **Allowlist**: Telefonnummern, E‑Mails oder Chat‑Ziele

Sie können BlueBubbles auch per CLI hinzufügen:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Zugriffskontrolle (Direktnachrichten + Gruppen)

DMs:

- Standard: `channels.bluebubbles.dmPolicy = "pairing"`.
- Unbekannte Absender erhalten einen Pairing‑Code; Nachrichten werden bis zur Freigabe ignoriert (Codes laufen nach 1 Stunde ab).
- Freigabe über:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Pairing ist der standardmäßige Token‑Austausch. Details: [Pairing](/channels/pairing)

Gruppen:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (Standard: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` steuert, wer in Gruppen auslösen darf, wenn `allowlist` gesetzt ist.

### Erwähnungs‑Gating (Gruppen)

BlueBubbles unterstützt Erwähnungs‑Gating für Gruppenchats und entspricht damit dem Verhalten von iMessage/WhatsApp:

- Verwendet `agents.list[].groupChat.mentionPatterns` (oder `messages.groupChat.mentionPatterns`) zur Erkennung von Erwähnungen.
- Wenn `requireMention` für eine Gruppe aktiviert ist, antwortet der Agent nur bei Erwähnung.
- Steuerbefehle von autorisierten Absendern umgehen das Erwähnungs‑Gating.

Pro‑Gruppen‑Konfiguration:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Befehls‑Gating

- Steuerbefehle (z. B. `/config`, `/model`) erfordern Autorisierung.
- Verwendet `allowFrom` und `groupAllowFrom` zur Bestimmung der Befehlsautorisierung.
- Autorisierte Absender können Steuerbefehle auch ohne Erwähnung in Gruppen ausführen.

## Tippen + Lesebestätigungen

- **Tippanzeigen**: Werden automatisch vor und während der Antwortgenerierung gesendet.
- **Lesebestätigungen**: Gesteuert über `channels.bluebubbles.sendReadReceipts` (Standard: `true`).
- **Tippanzeigen**: OpenClaw sendet Tipp‑Start‑Ereignisse; BlueBubbles beendet das Tippen automatisch beim Senden oder nach Timeout (manuelles Stoppen per DELETE ist unzuverlässig).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Erweiterte Aktionen

BlueBubbles unterstützt erweiterte Nachrichtenaktionen, wenn sie in der Konfiguration aktiviert sind:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Verfügbare Aktionen:

- **react**: Tapback‑Reaktionen hinzufügen/entfernen (`messageId`, `emoji`, `remove`)
- **edit**: Gesendete Nachricht bearbeiten (`messageId`, `text`)
- **unsend**: Nachricht zurückziehen (`messageId`)
- **reply**: Auf eine bestimmte Nachricht antworten (`messageId`, `text`, `to`)
- **sendWithEffect**: Mit iMessage‑Effekt senden (`text`, `to`, `effectId`)
- **renameGroup**: Gruppenchat umbenennen (`chatGuid`, `displayName`)
- **setGroupIcon**: Gruppenchat‑Icon/‑Foto setzen (`chatGuid`, `media`) — instabil auf macOS 26 Tahoe (API kann Erfolg melden, das Icon synchronisiert jedoch nicht).
- **addParticipant**: Jemanden zu einer Gruppe hinzufügen (`chatGuid`, `address`)
- **removeParticipant**: Jemanden aus einer Gruppe entfernen (`chatGuid`, `address`)
- **leaveGroup**: Eine Gruppe verlassen (`chatGuid`)
- **sendAttachment**: Medien/Dateien senden (`to`, `buffer`, `filename`, `asVoice`)
  - Sprachnotizen: Setzen Sie `asVoice: true` mit **MP3**‑ oder **CAF**‑Audio, um als iMessage‑Sprachnachricht zu senden. BlueBubbles konvertiert MP3 → CAF beim Senden von Sprachnotizen.

### Nachrichten‑IDs (kurz vs. vollständig)

OpenClaw kann _kurze_ Nachrichten‑IDs (z. B. `1`, `2`) anzeigen, um Tokens zu sparen.

- `MessageSid` / `ReplyToId` können kurze IDs sein.
- `MessageSidFull` / `ReplyToIdFull` enthalten die vollständigen Anbieter‑IDs.
- Kurze IDs sind im Speicher; sie können bei Neustart oder Cache‑Bereinigung verfallen.
- Aktionen akzeptieren kurze oder vollständige `messageId`, kurze IDs führen jedoch zu Fehlern, wenn sie nicht mehr verfügbar sind.

Verwenden Sie vollständige IDs für dauerhafte Automatisierungen und Speicherung:

- Templates: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Kontext: `MessageSidFull` / `ReplyToIdFull` in eingehenden Payloads

Siehe [Konfiguration](/gateway/configuration) für Template‑Variablen.

## Block‑Streaming

Steuern Sie, ob Antworten als einzelne Nachricht gesendet oder in Blöcken gestreamt werden:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Medien + Limits

- Eingehende Anhänge werden heruntergeladen und im Medien‑Cache gespeichert.
- Medien‑Limit über `channels.bluebubbles.mediaMaxMb` (Standard: 8 MB).
- Ausgehender Text wird auf `channels.bluebubbles.textChunkLimit` aufgeteilt (Standard: 4000 Zeichen).

## Konfigurationsreferenz

Vollständige Konfiguration: [Konfiguration](/gateway/configuration)

Anbieteroptionen:

- `channels.bluebubbles.enabled`: Kanal aktivieren/deaktivieren.
- `channels.bluebubbles.serverUrl`: Basis‑URL der BlueBubbles‑REST‑API.
- `channels.bluebubbles.password`: API‑Passwort.
- `channels.bluebubbles.webhookPath`: Webhook‑Endpunkt‑Pfad (Standard: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (Standard: `pairing`).
- `channels.bluebubbles.allowFrom`: DM‑Allowlist (Handles, E‑Mails, E.164‑Nummern, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (Standard: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: Gruppen‑Absender‑Allowlist.
- `channels.bluebubbles.groups`: Pro‑Gruppen‑Konfiguration (`requireMention` usw.).
- `channels.bluebubbles.sendReadReceipts`: Lesebestätigungen senden (Standard: `true`).
- `channels.bluebubbles.blockStreaming`: Block‑Streaming aktivieren (Standard: `false`; erforderlich für Streaming‑Antworten).
- `channels.bluebubbles.textChunkLimit`: Größe ausgehender Chunks in Zeichen (Standard: 4000).
- `channels.bluebubbles.chunkMode`: `length` (Standard) teilt nur bei Überschreitung von `textChunkLimit`; `newline` teilt an Leerzeilen (Absatzgrenzen) vor der Längen‑Chunking.
- `channels.bluebubbles.mediaMaxMb`: Eingehendes Medien‑Limit in MB (Standard: 8).
- `channels.bluebubbles.historyLimit`: Maximale Anzahl an Gruppen‑Nachrichten für den Kontext (0 deaktiviert).
- `channels.bluebubbles.dmHistoryLimit`: DM‑Historienlimit.
- `channels.bluebubbles.actions`: Bestimmte Aktionen aktivieren/deaktivieren.
- `channels.bluebubbles.accounts`: Multi‑Account‑Konfiguration.

Zugehörige globale Optionen:

- `agents.list[].groupChat.mentionPatterns` (oder `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Adressierung / Zustellziele

Bevorzugen Sie `chat_guid` für stabiles Routing:

- `chat_guid:iMessage;-;+15555550123` (bevorzugt für Gruppen)
- `chat_id:123`
- `chat_identifier:...`
- Direkte Handles: `+15555550123`, `user@example.com`
  - Wenn ein direkter Handle keinen bestehenden DM‑Chat hat, erstellt OpenClaw einen über `POST /api/v1/chat/new`. Dies erfordert die Aktivierung der BlueBubbles‑Private‑API.

## Sicherheit

- Webhook‑Anfragen werden authentifiziert, indem die Query‑Parameter oder Header `guid`/`password` mit `channels.bluebubbles.password` verglichen werden. Anfragen von `localhost` werden ebenfalls akzeptiert.
- Bewahren Sie das API‑Passwort und den Webhook‑Endpunkt geheim auf (wie Zugangsdaten).
- Localhost‑Vertrauen bedeutet, dass ein Reverse‑Proxy auf demselben Host unbeabsichtigt das Passwort umgehen kann. Wenn Sie das Gateway proxien, erzwingen Sie Authentifizierung am Proxy und konfigurieren Sie `gateway.trustedProxies`. Siehe [Gateway‑Sicherheit](/gateway/security#reverse-proxy-configuration).
- Aktivieren Sie HTTPS + Firewall‑Regeln auf dem BlueBubbles‑Server, wenn Sie ihn außerhalb Ihres LANs bereitstellen.

## Fehlerbehebung

- Wenn Tipp‑/Lese‑Ereignisse nicht mehr funktionieren, prüfen Sie die BlueBubbles‑Webhook‑Logs und verifizieren Sie, dass der Gateway‑Pfad mit `channels.bluebubbles.webhookPath` übereinstimmt.
- Pairing‑Codes laufen nach einer Stunde ab; verwenden Sie `openclaw pairing list bluebubbles` und `openclaw pairing approve bluebubbles <code>`.
- Reaktionen erfordern die BlueBubbles‑Private‑API (`POST /api/v1/message/react`); stellen Sie sicher, dass die Serverversion diese bereitstellt.
- Bearbeiten/Zurückziehen erfordern macOS 13+ und eine kompatible BlueBubbles‑Serverversion. Auf macOS 26 (Tahoe) ist Bearbeiten derzeit aufgrund von Änderungen an der Private‑API defekt.
- Gruppen‑Icon‑Updates können auf macOS 26 (Tahoe) instabil sein: Die API kann Erfolg melden, aber das neue Icon synchronisiert nicht.
- OpenClaw blendet bekannte defekte Aktionen basierend auf der macOS‑Version des BlueBubbles‑Servers automatisch aus. Wenn Bearbeiten auf macOS 26 (Tahoe) dennoch angezeigt wird, deaktivieren Sie es manuell mit `channels.bluebubbles.actions.edit=false`.
- Für Status‑/Health‑Informationen: `openclaw status --all` oder `openclaw status --deep`.

Für allgemeine Referenzen zum Kanal‑Workflow siehe [Channels](/channels) und den Leitfaden [Plugins](/tools/plugin).
