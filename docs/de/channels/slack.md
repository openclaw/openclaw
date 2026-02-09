---
summary: "„Slack-Einrichtung für Socket- oder HTTP-Webhook-Modus“"
read_when: "„Einrichtung von Slack oder Debugging des Slack-Socket-/HTTP-Modus“"
title: "Slack"
---

# Slack

## Socket-Modus (Standard)

### Schnellstart (Einsteiger)

1. Erstellen Sie eine Slack-App und aktivieren Sie den **Socket-Modus**.
2. Erstellen Sie ein **App-Token** (`xapp-...`) und ein **Bot-Token** (`xoxb-...`).
3. Setzen Sie die Tokens für OpenClaw und starten Sie das Gateway.

Minimale Konfiguration:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Einrichtung

1. Erstellen Sie eine Slack-App („From scratch“) unter [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Socket Mode** → aktivieren. Gehen Sie dann zu **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** mit dem Scope `connections:write`. Kopieren Sie das **App-Token** (`xapp-...`).
3. **OAuth & Permissions** → fügen Sie Bot-Token-Scopes hinzu (verwenden Sie das Manifest unten). Klicken Sie auf **Install to Workspace**. Kopieren Sie das **Bot User OAuth Token** (`xoxb-...`).
4. Optional: **OAuth & Permissions** → fügen Sie **User Token Scopes** hinzu (siehe die schreibgeschützte Liste unten). Installieren Sie die App erneut und kopieren Sie das **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → aktivieren Sie Events und abonnieren Sie:
   - `message.*` (enthält Bearbeitungen/Löschungen/Thread-Broadcasts)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Laden Sie den Bot in die Kanäle ein, die er lesen soll.
7. Slash Commands → erstellen Sie `/openclaw`, wenn Sie `channels.slack.slashCommand` verwenden. Wenn Sie native Commands aktivieren, fügen Sie pro integrierter Funktion einen Slash Command hinzu (gleiche Namen wie `/help`). Nativ ist für Slack standardmäßig deaktiviert, es sei denn, Sie setzen `channels.slack.commands.native: true` (globales `commands.native` ist `"auto"`, wodurch Slack deaktiviert bleibt).
8. App Home → aktivieren Sie den **Messages Tab**, damit Benutzer dem Bot Direktnachrichten senden können.

Verwenden Sie das Manifest unten, damit Scopes und Events synchron bleiben.

Multi-Account-Unterstützung: Verwenden Sie `channels.slack.accounts` mit Tokens pro Account und optional `name`. Siehe [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) für das gemeinsame Muster.

### OpenClaw-Konfiguration (Socket-Modus)

Setzen Sie Tokens über Umgebungsvariablen (empfohlen):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Oder über die Konfiguration:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### User-Token (optional)

OpenClaw kann ein Slack-User-Token (`xoxp-...`) für Leseoperationen verwenden (Verlauf,
Pins, Reaktionen, Emoji, Mitgliederinformationen). Standardmäßig bleibt dies schreibgeschützt: Lesezugriffe
bevorzugen bei Vorhandensein das User-Token, Schreibzugriffe verwenden weiterhin das Bot-Token, sofern Sie
nicht ausdrücklich optieren. Selbst mit `userTokenReadOnly: false` bleibt das Bot-Token
für Schreibzugriffe bevorzugt, wenn es verfügbar ist.

User-Tokens werden in der Konfigurationsdatei eingerichtet (keine Unterstützung über Umgebungsvariablen). Für
Multi-Account setzen Sie `channels.slack.accounts.<id>.userToken`.

Beispiel mit Bot- + App- + User-Token:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

Beispiel mit explizit gesetztem userTokenReadOnly (User-Token-Schreibzugriffe erlauben):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Token-Nutzung

- Leseoperationen (Verlauf, Reaktionsliste, Pin-Liste, Emoji-Liste, Mitgliederinformationen,
  Suche) bevorzugen das User-Token, falls konfiguriert, andernfalls das Bot-Token.
- Schreiboperationen (Nachrichten senden/bearbeiten/löschen, Reaktionen hinzufügen/entfernen, pinnen/entpinnen,
  Datei-Uploads) verwenden standardmäßig das Bot-Token. Wenn `userTokenReadOnly: false` gesetzt ist und
  kein Bot-Token verfügbar ist, greift OpenClaw auf das User-Token zurück.

### Verlaufskontext

- `channels.slack.historyLimit` (oder `channels.slack.accounts.*.historyLimit`) steuert, wie viele aktuelle Kanal-/Gruppennachrichten in den Prompt eingebettet werden.
- Fällt zurück auf `messages.groupChat.historyLimit`. Setzen Sie `0`, um dies zu deaktivieren (Standard: 50).

## HTTP-Modus (Events API)

Verwenden Sie den HTTP-Webhook-Modus, wenn Ihr Gateway für Slack über HTTPS erreichbar ist (typisch für Server-Deployments).
Der HTTP-Modus verwendet die Events API + Interactivity + Slash Commands mit einer gemeinsamen Request-URL.

### Einrichtung (HTTP-Modus)

1. Erstellen Sie eine Slack-App und **deaktivieren Sie den Socket-Modus** (optional, wenn Sie nur HTTP verwenden).
2. **Basic Information** → kopieren Sie das **Signing Secret**.
3. **OAuth & Permissions** → installieren Sie die App und kopieren Sie das **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → aktivieren Sie Events und setzen Sie die **Request URL** auf den Webhook-Pfad Ihres Gateways (Standard: `/slack/events`).
5. **Interactivity & Shortcuts** → aktivieren und dieselbe **Request URL** setzen.
6. **Slash Commands** → setzen Sie dieselbe **Request URL** für Ihre Commands.

Beispiel-Request-URL:
`https://gateway-host/slack/events`

### OpenClaw-Konfiguration (minimal)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

Multi-Account-HTTP-Modus: Setzen Sie `channels.slack.accounts.<id>.mode = "http"` und stellen Sie pro Account eine eindeutige
`webhookPath` bereit, damit jede Slack-App auf ihre eigene URL zeigen kann.

### Manifest (optional)

Verwenden Sie dieses Slack-App-Manifest, um die App schnell zu erstellen (passen Sie Name/Befehl nach Bedarf an). Fügen Sie die
User-Scopes hinzu, wenn Sie ein User-Token konfigurieren möchten.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

Wenn Sie native Commands aktivieren, fügen Sie einen `slash_commands`-Eintrag pro Command hinzu, den Sie bereitstellen möchten (entsprechend der `/help`-Liste). Überschreiben Sie dies mit `channels.slack.commands.native`.

## Scopes (aktuell vs. optional)

Die Conversations API von Slack ist typ-spezifisch: Sie benötigen nur die Scopes für die
Conversation-Typen, die Sie tatsächlich verwenden (channels, groups, im, mpim). Siehe
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) für den Überblick.

### Bot-Token-Scopes (erforderlich)

- `chat:write` (Nachrichten senden/aktualisieren/löschen über `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (DMs öffnen über `conversations.open` für Benutzer-DMs)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (Benutzerabfrage)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (Uploads über `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### User-Token-Scopes (optional, standardmäßig schreibgeschützt)

Fügen Sie diese unter **User Token Scopes** hinzu, wenn Sie `channels.slack.userToken` konfigurieren.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Derzeit nicht benötigt (aber wahrscheinlich zukünftig)

- `mpim:write` (nur wenn wir Gruppen-DM-Öffnen/DM-Start über `conversations.open` hinzufügen)
- `groups:write` (nur wenn wir Private-Channel-Management hinzufügen: erstellen/umbenennen/einladen/archivieren)
- `chat:write.public` (nur wenn wir in Kanäle posten möchten, in denen der Bot nicht ist)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (nur wenn wir E-Mail-Felder aus `users.info` benötigen)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (nur wenn wir beginnen, Dateimetadaten aufzulisten/zu lesen)

## Konfiguration

Slack verwendet ausschließlich den Socket-Modus (kein HTTP-Webhook-Server). Stellen Sie beide Tokens bereit:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Tokens können auch über Umgebungsvariablen bereitgestellt werden:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack-Reaktionen werden global über `messages.ackReaction` +
`messages.ackReactionScope` gesteuert. Verwenden Sie `messages.removeAckAfterReply`, um die
Ack-Reaktion zu entfernen, nachdem der Bot geantwortet hat.

## Limits

- Ausgehender Text wird in Blöcke von `channels.slack.textChunkLimit` aufgeteilt (Standard: 4000).
- Optionale Zeilenumbruch-Chunking: Setzen Sie `channels.slack.chunkMode="newline"`, um vor der Längenaufteilung an Leerzeilen (Absatzgrenzen) zu trennen.
- Medien-Uploads sind durch `channels.slack.mediaMaxMb` begrenzt (Standard: 20).

## Antwort-Threading

Standardmäßig antwortet OpenClaw im Hauptkanal. Verwenden Sie `channels.slack.replyToMode`, um automatisches Threading zu steuern:

| Modus   | Verhalten                                                                                                                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **Standard.** Antwort im Hauptkanal. Thread nur, wenn die auslösende Nachricht bereits in einem Thread war.                                                                                     |
| `first` | Erste Antwort geht in den Thread (unter der auslösenden Nachricht), nachfolgende Antworten gehen in den Hauptkanal. Nützlich, um Kontext sichtbar zu halten und Thread-Clutter zu vermeiden. |
| `all`   | Alle Antworten gehen in den Thread. Hält Unterhaltungen zusammen, kann aber die Sichtbarkeit reduzieren.                                                                                                        |

Der Modus gilt sowohl für Auto-Antworten als auch für Agenten-Werkzeugaufrufe (`slack sendMessage`).

### Threading pro Chat-Typ

Sie können unterschiedliches Threading-Verhalten pro Chat-Typ konfigurieren, indem Sie `channels.slack.replyToModeByChatType` setzen:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

Unterstützte Chat-Typen:

- `direct`: 1:1-DMs (Slack `im`)
- `group`: Gruppen-DMs / MPIMs (Slack `mpim`)
- `channel`: Standardkanäle (öffentlich/privat)

Priorität:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Anbieter-Standard (`off`)

Legacy `channels.slack.dm.replyToMode` wird weiterhin als Fallback für `direct` akzeptiert, wenn kein Chat-Typ-Override gesetzt ist.

Beispiele:

Nur DMs threaden:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

Gruppen-DMs threaden, Kanäle im Root belassen:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Kanäle threaden, DMs im Root belassen:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Manuelle Threading-Tags

Für eine feingranulare Steuerung verwenden Sie diese Tags in Agenten-Antworten:

- `[[reply_to_current]]` — Antwort auf die auslösende Nachricht (Thread starten/fortsetzen).
- `[[reply_to:<id>]]` — Antwort auf eine bestimmte Nachrichten-ID.

## Sitzungen + Routing

- DMs teilen sich die `main`-Sitzung (wie WhatsApp/Telegram).
- Kanäle werden auf `agent:<agentId>:slack:channel:<channelId>`-Sitzungen abgebildet.
- Slash Commands verwenden `agent:<agentId>:slack:slash:<userId>`-Sitzungen (Präfix konfigurierbar über `channels.slack.slashCommand.sessionPrefix`).
- Wenn Slack kein `channel_type` bereitstellt, leitet OpenClaw es aus dem Kanal-ID-Präfix ab (`D`, `C`, `G`) und verwendet standardmäßig `channel`, um Sitzungsschlüssel stabil zu halten.
- Die Registrierung nativer Commands verwendet `commands.native` (globaler Standard `"auto"` → Slack aus) und kann pro Workspace mit `channels.slack.commands.native` überschrieben werden. Text-Commands erfordern eigenständige `/...`-Nachrichten und können mit `commands.text: false` deaktiviert werden. Slack-Slash-Commands werden in der Slack-App verwaltet und nicht automatisch entfernt. Verwenden Sie `commands.useAccessGroups: false`, um Zugriffsguppenprüfungen für Commands zu umgehen.
- Vollständige Command-Liste + Konfiguration: [Slash commands](/tools/slash-commands)

## DM-Sicherheit (Pairing)

- Standard: `channels.slack.dm.policy="pairing"` — unbekannte DM-Absender erhalten einen Pairing-Code (läuft nach 1 Stunde ab).
- Freigabe über: `openclaw pairing approve slack <code>`.
- Um alle zuzulassen: Setzen Sie `channels.slack.dm.policy="open"` und `channels.slack.dm.allowFrom=["*"]`.
- `channels.slack.dm.allowFrom` akzeptiert Benutzer-IDs, @Handles oder E-Mails (werden beim Start aufgelöst, wenn Tokens dies erlauben). Der Assistent akzeptiert Benutzernamen und löst sie während der Einrichtung in IDs auf, wenn Tokens dies erlauben.

## Gruppenrichtlinie

- `channels.slack.groupPolicy` steuert die Kanalbehandlung (`open|disabled|allowlist`).
- `allowlist` erfordert, dass Kanäle in `channels.slack.channels` aufgeführt sind.
- Wenn Sie nur `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` setzen und niemals einen `channels.slack`-Abschnitt erstellen,
  setzt die Laufzeit `groupPolicy` standardmäßig auf `open`. Fügen Sie `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy` oder eine Kanal-Allowlist hinzu, um es einzuschränken.
- Der Konfigurationsassistent akzeptiert `#channel`-Namen und löst sie nach Möglichkeit in IDs auf
  (öffentlich + privat); bei mehreren Treffern wird der aktive Kanal bevorzugt.
- Beim Start löst OpenClaw Kanal-/Benutzernamen in Allowlists zu IDs auf (wenn Tokens dies erlauben)
  und protokolliert die Zuordnung; nicht aufgelöste Einträge bleiben unverändert.
- Um **keine Kanäle** zuzulassen, setzen Sie `channels.slack.groupPolicy: "disabled"` (oder behalten Sie eine leere Allowlist).

Kanaloptionen (`channels.slack.channels.<id>` oder `channels.slack.channels.<name>`):

- `allow`: Kanal erlauben/verbieten, wenn `groupPolicy="allowlist"`.
- `requireMention`: Erwähnungs-Gating für den Kanal.
- `tools`: optionale kanalweise Tool-Policy-Overrides (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: optionale absenderbezogene Tool-Policy-Overrides innerhalb des Kanals (Schlüssel sind Absender-IDs/@Handles/E-Mails; Platzhalter `"*"` unterstützt).
- `allowBots`: vom Bot verfasste Nachrichten in diesem Kanal zulassen (Standard: false).
- `users`: optionale kanalweise Benutzer-Allowlist.
- `skills`: Skill-Filter (weglassen = alle Skills, leer = keine).
- `systemPrompt`: zusätzlicher System-Prompt für den Kanal (kombiniert mit Thema/Zweck).
- `enabled`: setzen Sie `false`, um den Kanal zu deaktivieren.

## Lieferziele

Verwenden Sie diese für Cron-/CLI-Sendungen:

- `user:<id>` für DMs
- `channel:<id>` für Kanäle

## Tool-Aktionen

Slack-Tool-Aktionen können mit `channels.slack.actions.*` eingeschränkt werden:

| Aktionsgruppe | Standard  | Hinweise                         |
| ------------- | --------- | -------------------------------- |
| reactions     | aktiviert | Reagieren + Reaktionen auflisten |
| messages      | aktiviert | Lesen/Senden/Bearbeiten/Löschen  |
| pins          | aktiviert | Anpinnen/Entpinnen/Auflisten     |
| memberInfo    | aktiviert | Mitgliederinformationen          |
| emojiList     | aktiviert | Benutzerdefinierte Emoji-Liste   |

## Sicherheitshinweise

- Schreibzugriffe verwenden standardmäßig das Bot-Token, damit zustandsändernde Aktionen auf die
  Bot-Berechtigungen und -Identität der App beschränkt bleiben.
- Das Setzen von `userTokenReadOnly: false` erlaubt die Verwendung des User-Tokens für Schreibzugriffe,
  wenn kein Bot-Token verfügbar ist; Aktionen laufen dann mit den Rechten des installierenden
  Benutzers. Behandeln Sie das User-Token als hochprivilegiert und halten Sie Aktions-Gates und Allowlists eng.
- Wenn Sie User-Token-Schreibzugriffe aktivieren, stellen Sie sicher, dass das User-Token die erwarteten
  Schreib-Scopes enthält (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`), andernfalls schlagen diese Operationen fehl.

## Fehlerbehebung

Führen Sie zuerst diese Abfolge aus:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Bestätigen Sie anschließend bei Bedarf den DM-Pairing-Status:

```bash
openclaw pairing list slack
```

Häufige Fehler:

- Verbunden, aber keine Kanalantworten: Kanal durch `groupPolicy` blockiert oder nicht in der `channels.slack.channels`-Allowlist.
- DMs werden ignoriert: Absender nicht freigegeben bei `channels.slack.dm.policy="pairing"`.
- API-Fehler (`missing_scope`, `not_in_channel`, Auth-Fehler): Bot-/App-Tokens oder Slack-Scopes sind unvollständig.

Für den Triage-Ablauf: [/channels/troubleshooting](/channels/troubleshooting).

## Hinweise

- Erwähnungs-Gating wird über `channels.slack.channels` gesteuert (setzen Sie `requireMention` auf `true`); `agents.list[].groupChat.mentionPatterns` (oder `messages.groupChat.mentionPatterns`) zählen ebenfalls als Erwähnungen.
- Multi-Agent-Override: Setzen Sie agentenspezifische Muster unter `agents.list[].groupChat.mentionPatterns`.
- Reaktionsbenachrichtigungen folgen `channels.slack.reactionNotifications` (verwenden Sie `reactionAllowlist` mit Modus `allowlist`).
- Vom Bot verfasste Nachrichten werden standardmäßig ignoriert; aktivieren Sie dies über `channels.slack.allowBots` oder `channels.slack.channels.<id>.allowBots`.
- Warnung: Wenn Sie Antworten an andere Bots zulassen (`channels.slack.allowBots=true` oder `channels.slack.channels.<id>.allowBots=true`), verhindern Sie Bot-zu-Bot-Antwortschleifen mit `requireMention`, `channels.slack.channels.<id>.users`-Allowlists und/oder klaren Guardrails in `AGENTS.md` und `SOUL.md`.
- Für das Slack-Werkzeug sind die Semantiken zum Entfernen von Reaktionen unter [/tools/reactions](/tools/reactions) beschrieben.
- Anhänge werden bei Erlaubnis und unterhalb des Größenlimits in den Medienspeicher heruntergeladen.
