---
summary: „Überblick, Funktionen und Konfiguration des Feishu-Bots“
read_when:
  - Sie möchten einen Feishu-/Lark-Bot verbinden
  - Sie konfigurieren den Feishu-Kanal
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:26Z
---

# Feishu-Bot

Feishu (Lark) ist eine Team-Chat-Plattform, die von Unternehmen für Messaging und Zusammenarbeit genutzt wird. Dieses Plugin verbindet OpenClaw mit einem Feishu-/Lark-Bot über das WebSocket-Ereignisabonnement der Plattform, sodass Nachrichten empfangen werden können, ohne eine öffentliche Webhook-URL bereitzustellen.

---

## Erforderliches Plugin

Installieren Sie das Feishu-Plugin:

```bash
openclaw plugins install @openclaw/feishu
```

Lokaler Checkout (bei Ausführung aus einem Git-Repository):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Schnellstart

Es gibt zwei Möglichkeiten, den Feishu-Kanal hinzuzufügen:

### Methode 1: Onboarding-Assistent (empfohlen)

Wenn Sie OpenClaw gerade installiert haben, starten Sie den Assistenten:

```bash
openclaw onboard
```

Der Assistent führt Sie durch:

1. Erstellen einer Feishu-App und Sammeln der Zugangsdaten
2. Konfigurieren der App-Zugangsdaten in OpenClaw
3. Starten des Gateways

✅ **Nach der Konfiguration** überprüfen Sie den Gateway-Status:

- `openclaw gateway status`
- `openclaw logs --follow`

### Methode 2: CLI-Einrichtung

Wenn Sie die Erstinstallation bereits abgeschlossen haben, fügen Sie den Kanal über die CLI hinzu:

```bash
openclaw channels add
```

Wählen Sie **Feishu** und geben Sie anschließend App ID und App Secret ein.

✅ **Nach der Konfiguration** verwalten Sie das Gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Schritt 1: Feishu-App erstellen

### 1. Feishu Open Platform öffnen

Besuchen Sie die [Feishu Open Platform](https://open.feishu.cn/app) und melden Sie sich an.

Lark-(global)-Tenants sollten [https://open.larksuite.com/app](https://open.larksuite.com/app) verwenden und `domain: "lark"` in der Feishu-Konfiguration setzen.

### 2. App erstellen

1. Klicken Sie auf **Create enterprise app**
2. Geben Sie App-Namen und Beschreibung ein
3. Wählen Sie ein App-Symbol

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Zugangsdaten kopieren

Kopieren Sie unter **Credentials & Basic Info**:

- **App ID** (Format: `cli_xxx`)
- **App Secret**

❗ **Wichtig:** Bewahren Sie das App Secret vertraulich auf.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Berechtigungen konfigurieren

Klicken Sie unter **Permissions** auf **Batch import** und fügen Sie Folgendes ein:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Bot-Funktion aktivieren

Unter **App Capability** > **Bot**:

1. Aktivieren Sie die Bot-Funktion
2. Legen Sie den Bot-Namen fest

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Ereignisabonnement konfigurieren

⚠️ **Wichtig:** Bevor Sie das Ereignisabonnement konfigurieren, stellen Sie sicher:

1. Sie haben `openclaw channels add` für Feishu bereits ausgeführt
2. Das Gateway läuft (`openclaw gateway status`)

Unter **Event Subscription**:

1. Wählen Sie **Use long connection to receive events** (WebSocket)
2. Fügen Sie das Ereignis hinzu: `im.message.receive_v1`

⚠️ Wenn das Gateway nicht läuft, kann das Speichern der Long-Connection-Einstellung fehlschlagen.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. App veröffentlichen

1. Erstellen Sie eine Version unter **Version Management & Release**
2. Reichen Sie sie zur Prüfung ein und veröffentlichen Sie sie
3. Warten Sie auf die Admin-Genehmigung (Enterprise-Apps werden meist automatisch genehmigt)

---

## Schritt 2: OpenClaw konfigurieren

### Konfiguration mit dem Assistenten (empfohlen)

```bash
openclaw channels add
```

Wählen Sie **Feishu** und fügen Sie Ihre App ID und Ihr App Secret ein.

### Konfiguration über Konfigurationsdatei

Bearbeiten Sie `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Konfiguration über Umgebungsvariablen

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark-(global)-Domain

Wenn Ihr Tenant Lark (international) verwendet, setzen Sie die Domain auf `lark` (oder eine vollständige Domain-Zeichenfolge). Sie können dies unter `channels.feishu.domain` oder pro Konto (`channels.feishu.accounts.<id>.domain`) festlegen.

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Schritt 3: Starten + testen

### 1. Gateway starten

```bash
openclaw gateway
```

### 2. Testnachricht senden

Suchen Sie in Feishu Ihren Bot und senden Sie eine Nachricht.

### 3. Kopplung genehmigen

Standardmäßig antwortet der Bot mit einem Kopplungscode. Genehmigen Sie ihn:

```bash
openclaw pairing approve feishu <CODE>
```

Nach der Genehmigung können Sie normal chatten.

---

## Überblick

- **Feishu-Bot-Kanal**: Vom Gateway verwalteter Feishu-Bot
- **Deterministisches Routing**: Antworten kehren immer zu Feishu zurück
- **Sitzungsisolation**: Direktnachrichten teilen sich eine Hauptsitzung; Gruppen sind isoliert
- **WebSocket-Verbindung**: Long-Connection über das Feishu-SDK, keine öffentliche URL erforderlich

---

## Zugriffskontrolle

### Direktnachrichten

- **Standard**: `dmPolicy: "pairing"` (unbekannte Benutzer erhalten einen Kopplungscode)
- **Kopplung genehmigen**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Allowlist-Modus**: Setzen Sie `channels.feishu.allowFrom` mit erlaubten Open IDs

### Gruppenchats

**1. Gruppenrichtlinie** (`channels.feishu.groupPolicy`):

- `"open"` = alle in Gruppen zulassen (Standard)
- `"allowlist"` = nur `groupAllowFrom` zulassen
- `"disabled"` = Gruppennachrichten deaktivieren

**2. Erwähnungspflicht** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = @Erwähnung erforderlich (Standard)
- `false` = ohne Erwähnungen antworten

---

## Beispiele für Gruppenkonfiguration

### Alle Gruppen zulassen, @Erwähnung erforderlich (Standard)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Alle Gruppen zulassen, keine @Erwähnung erforderlich

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Nur bestimmte Benutzer in Gruppen zulassen

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Gruppen-/Benutzer-IDs abrufen

### Gruppen-IDs (chat_id)

Gruppen-IDs sehen aus wie `oc_xxx`.

**Methode 1 (empfohlen)**

1. Starten Sie das Gateway und @erwähnen Sie den Bot in der Gruppe
2. Führen Sie `openclaw logs --follow` aus und suchen Sie nach `chat_id`

**Methode 2**

Verwenden Sie den Feishu-API-Debugger, um Gruppenchats aufzulisten.

### Benutzer-IDs (open_id)

Benutzer-IDs sehen aus wie `ou_xxx`.

**Methode 1 (empfohlen)**

1. Starten Sie das Gateway und senden Sie dem Bot eine Direktnachricht
2. Führen Sie `openclaw logs --follow` aus und suchen Sie nach `open_id`

**Methode 2**

Prüfen Sie Kopplungsanfragen auf Benutzer-Open-IDs:

```bash
openclaw pairing list feishu
```

---

## Häufige Befehle

| Befehl    | Beschreibung             |
| --------- | ------------------------ |
| `/status` | Bot-Status anzeigen      |
| `/reset`  | Sitzung zurücksetzen     |
| `/model`  | Modell anzeigen/wechseln |

> Hinweis: Feishu unterstützt derzeit keine nativen Befehlsmenüs, daher müssen Befehle als Text gesendet werden.

## Gateway-Verwaltungsbefehle

| Befehl                     | Beschreibung                        |
| -------------------------- | ----------------------------------- |
| `openclaw gateway status`  | Gateway-Status anzeigen             |
| `openclaw gateway install` | Gateway-Dienst installieren/starten |
| `openclaw gateway stop`    | Gateway-Dienst stoppen              |
| `openclaw gateway restart` | Gateway-Dienst neu starten          |
| `openclaw logs --follow`   | Gateway-Logs verfolgen              |

---

## Fehlerbehebung

### Bot antwortet nicht in Gruppenchats

1. Stellen Sie sicher, dass der Bot zur Gruppe hinzugefügt wurde
2. Stellen Sie sicher, dass Sie den Bot @erwähnen (Standardverhalten)
3. Prüfen Sie, dass `groupPolicy` nicht auf `"disabled"` gesetzt ist
4. Prüfen Sie die Logs: `openclaw logs --follow`

### Bot empfängt keine Nachrichten

1. Stellen Sie sicher, dass die App veröffentlicht und genehmigt ist
2. Stellen Sie sicher, dass das Ereignisabonnement `im.message.receive_v1` enthält
3. Stellen Sie sicher, dass **long connection** aktiviert ist
4. Stellen Sie sicher, dass die App-Berechtigungen vollständig sind
5. Stellen Sie sicher, dass das Gateway läuft: `openclaw gateway status`
6. Prüfen Sie die Logs: `openclaw logs --follow`

### App-Secret-Leak

1. Setzen Sie das App Secret in der Feishu Open Platform zurück
2. Aktualisieren Sie das App Secret in Ihrer Konfiguration
3. Starten Sie das Gateway neu

### Fehler beim Senden von Nachrichten

1. Stellen Sie sicher, dass die App über die Berechtigung `im:message:send_as_bot` verfügt
2. Stellen Sie sicher, dass die App veröffentlicht ist
3. Prüfen Sie die Logs auf detaillierte Fehler

---

## Erweiterte Konfiguration

### Mehrere Konten

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Nachrichtenlimits

- `textChunkLimit`: Größe ausgehender Textsegmente (Standard: 2000 Zeichen)
- `mediaMaxMb`: Limit für Medien-Upload/-Download (Standard: 30 MB)

### Streaming

Feishu unterstützt Streaming-Antworten über interaktive Karten. Wenn aktiviert, aktualisiert der Bot eine Karte während der Texterzeugung.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Setzen Sie `streaming: false`, um vor dem Senden auf die vollständige Antwort zu warten.

### Multi-Agent-Routing

Verwenden Sie `bindings`, um Feishu-Direktnachrichten oder -Gruppen an unterschiedliche Agenten weiterzuleiten.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Routing-Felder:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` oder `"group"`
- `match.peer.id`: Benutzer-Open-ID (`ou_xxx`) oder Gruppen-ID (`oc_xxx`)

Siehe [Gruppen-/Benutzer-IDs abrufen](#get-groupuser-ids) für Hinweise zur Ermittlung.

---

## Konfigurationsreferenz

Vollständige Konfiguration: [Gateway-Konfiguration](/gateway/configuration)

Schlüsseloptionen:

| Einstellung                                       | Beschreibung                       | Standard  |
| ------------------------------------------------- | ---------------------------------- | --------- |
| `channels.feishu.enabled`                         | Kanal aktivieren/deaktivieren      | `true`    |
| `channels.feishu.domain`                          | API-Domain (`feishu` oder `lark`)  | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                             | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                         | -         |
| `channels.feishu.accounts.<id>.domain`            | API-Domain-Override pro Konto      | `feishu`  |
| `channels.feishu.dmPolicy`                        | DM-Richtlinie                      | `pairing` |
| `channels.feishu.allowFrom`                       | DM-Allowlist (open_id-Liste)       | -         |
| `channels.feishu.groupPolicy`                     | Gruppenrichtlinie                  | `open`    |
| `channels.feishu.groupAllowFrom`                  | Gruppen-Allowlist                  | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | @Erwähnung erforderlich            | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | Gruppe aktivieren                  | `true`    |
| `channels.feishu.textChunkLimit`                  | Nachrichtensegmentgröße            | `2000`    |
| `channels.feishu.mediaMaxMb`                      | Mediengrößenlimit                  | `30`      |
| `channels.feishu.streaming`                       | Streaming-Kartenausgabe aktivieren | `true`    |
| `channels.feishu.blockStreaming`                  | Block-Streaming aktivieren         | `true`    |

---

## dmPolicy-Referenz

| Wert          | Verhalten                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------ |
| `"pairing"`   | **Standard.** Unbekannte Benutzer erhalten einen Kopplungscode und müssen genehmigt werden |
| `"allowlist"` | Nur Benutzer in `allowFrom` können chatten                                                 |
| `"open"`      | Alle Benutzer zulassen (erfordert `"*"` in allowFrom)                                      |
| `"disabled"`  | Direktnachrichten deaktivieren                                                             |

---

## Unterstützte Nachrichtentypen

### Empfangen

- ✅ Text
- ✅ Rich Text (Post)
- ✅ Bilder
- ✅ Dateien
- ✅ Audio
- ✅ Video
- ✅ Sticker

### Senden

- ✅ Text
- ✅ Bilder
- ✅ Dateien
- ✅ Audio
- ⚠️ Rich Text (teilweise Unterstützung)
