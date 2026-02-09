---
summary: "„Status der Discord-Bot-Unterstützung, Funktionen und Konfiguration“"
read_when:
  - Arbeit an Discord-Kanal-Funktionen
title: "Discord"
---

# Discord (Bot API)

Status: bereit für Direktnachrichten und Guild-Textkanäle über das offizielle Discord-Bot-Gateway.

## Schnellstart (Einsteiger)

1. Erstellen Sie einen Discord-Bot und kopieren Sie das Bot-Token.
2. Aktivieren Sie in den Discord-App-Einstellungen **Message Content Intent** (und **Server Members Intent**, wenn Sie Allowlists oder Namensauflösungen verwenden möchten).
3. Setzen Sie das Token für OpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - Oder Konfiguration: `channels.discord.token: "..."`.
   - Wenn beide gesetzt sind, hat die Konfiguration Vorrang (Env-Fallback gilt nur für das Standardkonto).
4. Laden Sie den Bot mit Nachrichtenberechtigungen auf Ihren Server ein (erstellen Sie einen privaten Server, wenn Sie nur Direktnachrichten möchten).
5. Starten Sie das Gateway.
6. DM-Zugriff ist standardmäßig gekoppelt; genehmigen Sie den Pairing-Code beim ersten Kontakt.

Minimale Konfiguration:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Ziele

- Mit OpenClaw über Discord-DMs oder Guild-Kanäle kommunizieren.
- Direktchats werden in der Hauptsitzung des Agenten zusammengeführt (Standard: `agent:main:main`); Guild-Kanäle bleiben als `agent:<agentId>:discord:channel:<channelId>` isoliert (Anzeigenamen verwenden `discord:<guildSlug>#<channelSlug>`).
- Gruppen-DMs werden standardmäßig ignoriert; aktivieren Sie sie über `channels.discord.dm.groupEnabled` und beschränken Sie sie optional über `channels.discord.dm.groupChannels`.
- Deterministisches Routing beibehalten: Antworten gehen immer an den Kanal zurück, auf dem sie eingegangen sind.

## Wie es funktioniert

1. Erstellen Sie eine Discord-Anwendung → Bot, aktivieren Sie die benötigten Intents (DMs + Guild-Nachrichten + Nachrichteninhalt) und kopieren Sie das Bot-Token.
2. Laden Sie den Bot mit den erforderlichen Berechtigungen auf Ihren Server ein, um Nachrichten dort zu lesen/senden, wo Sie ihn verwenden möchten.
3. Konfigurieren Sie OpenClaw mit `channels.discord.token` (oder `DISCORD_BOT_TOKEN` als Fallback).
4. Starten Sie das Gateway; es startet den Discord-Kanal automatisch, wenn ein Token verfügbar ist (Konfiguration zuerst, Env-Fallback) und `channels.discord.enabled` nicht `false` ist.
   - Wenn Sie Env-Variablen bevorzugen, setzen Sie `DISCORD_BOT_TOKEN` (ein Konfigurationsblock ist optional).
5. Direktchats: Verwenden Sie bei der Zustellung `user:<id>` (oder eine `<@id>`-Erwähnung); alle Züge landen in der gemeinsamen Sitzung `main`. Reine numerische IDs sind mehrdeutig und werden abgelehnt.
6. Guild-Kanäle: Verwenden Sie `channel:<channelId>` für die Zustellung. Erwähnungen sind standardmäßig erforderlich und können pro Guild oder pro Kanal festgelegt werden.
7. Direktchats: Standardmäßig sicher über `channels.discord.dm.policy` (Standard: `"pairing"`). Unbekannte Absender erhalten einen Pairing-Code (läuft nach 1 Stunde ab); genehmigen Sie ihn über `openclaw pairing approve discord <code>`.
   - Um das frühere „für alle offen“-Verhalten beizubehalten: setzen Sie `channels.discord.dm.policy="open"` und `channels.discord.dm.allowFrom=["*"]`.
   - Für eine harte Allowlist: setzen Sie `channels.discord.dm.policy="allowlist"` und listen Sie Absender in `channels.discord.dm.allowFrom` auf.
   - Um alle DMs zu ignorieren: setzen Sie `channels.discord.dm.enabled=false` oder `channels.discord.dm.policy="disabled"`.
8. Gruppen-DMs werden standardmäßig ignoriert; aktivieren Sie sie über `channels.discord.dm.groupEnabled` und beschränken Sie sie optional über `channels.discord.dm.groupChannels`.
9. Optionale Guild-Regeln: setzen Sie `channels.discord.guilds` nach Guild-ID (bevorzugt) oder Slug, mit Regeln pro Kanal.
10. Optionale native Befehle: `commands.native` ist standardmäßig `"auto"` (an für Discord/Telegram, aus für Slack). Überschreiben Sie mit `channels.discord.commands.native: true|false|"auto"`; `false` löscht zuvor registrierte Befehle. Textbefehle werden über `commands.text` gesteuert und müssen als eigenständige `/...`-Nachrichten gesendet werden. Verwenden Sie `commands.useAccessGroups: false`, um Zugriffskontrollen für Befehle zu umgehen.
    - Vollständige Befehlsliste + Konfiguration: [Slash commands](/tools/slash-commands)
11. Optionaler Guild-Kontextverlauf: setzen Sie `channels.discord.historyLimit` (Standard 20, Fallback auf `messages.groupChat.historyLimit`), um beim Antworten auf eine Erwähnung die letzten N Guild-Nachrichten als Kontext einzubeziehen. Setzen Sie `0`, um dies zu deaktivieren.
12. Reaktionen: Der Agent kann Reaktionen über das Werkzeug `discord` auslösen (gesteuert durch `channels.discord.actions.*`).
    - Semantik zum Entfernen von Reaktionen: siehe [/tools/reactions](/tools/reactions).
    - Das Werkzeug `discord` ist nur verfügbar, wenn der aktuelle Kanal Discord ist.
13. Native Befehle verwenden isolierte Sitzungsschlüssel (`agent:<agentId>:discord:slash:<userId>`) statt der gemeinsamen Sitzung `main`.

Hinweis: Namens-→ID-Auflösung nutzt die Guild-Mitgliedersuche und erfordert Server Members Intent; wenn der Bot keine Mitglieder suchen kann, verwenden Sie IDs oder `<@id>`-Erwähnungen.
Hinweis: Slugs sind klein geschrieben, Leerzeichen werden durch `-` ersetzt. Kanalnamen werden ohne das führende `#` gesluggified.
Hinweis: Guild-Kontextzeilen `[from:]` enthalten `author.tag` + `id`, um ping-fähige Antworten zu erleichtern.

## Konfigurationsschreibzugriffe

Standardmäßig darf Discord Konfigurationsupdates schreiben, die durch `/config set|unset` ausgelöst werden (erfordert `commands.config: true`).

Deaktivieren mit:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## So erstellen Sie Ihren eigenen Bot

Dies ist die Einrichtung im „Discord Developer Portal“ für den Betrieb von OpenClaw in einem Server-(Guild-)Kanal wie `#help`.

### 1. Discord-App + Bot-Benutzer erstellen

1. Discord Developer Portal → **Applications** → **New Application**
2. In Ihrer App:
   - **Bot** → **Add Bot**
   - Kopieren Sie das **Bot Token** (dieses tragen Sie in `DISCORD_BOT_TOKEN` ein)

### 2) Gateway-Intents aktivieren, die OpenClaw benötigt

Discord blockiert „privilegierte Intents“, sofern sie nicht explizit aktiviert werden.

Unter **Bot** → **Privileged Gateway Intents** aktivieren Sie:

- **Message Content Intent** (erforderlich, um Nachrichtentext in den meisten Guilds zu lesen; ohne ihn sehen Sie „Used disallowed intents“ oder der Bot verbindet sich, reagiert aber nicht)
- **Server Members Intent** (empfohlen; erforderlich für einige Mitglieder-/Benutzerabfragen und Allowlist-Abgleiche in Guilds)

In der Regel benötigen Sie **Presence Intent** **nicht**. Das Setzen der eigenen Präsenz des Bots (Aktion `setPresence`) verwendet Gateway OP3 und erfordert diesen Intent nicht; er ist nur nötig, wenn Sie Präsenz-Updates anderer Guild-Mitglieder empfangen möchten.

### 3. Einladungs-URL erzeugen (OAuth2 URL Generator)

In Ihrer App: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (erforderlich für native Befehle)

**Bot-Berechtigungen** (minimale Basis)

- ✅ Kanäle anzeigen
- ✅ Nachrichten senden
- ✅ Nachrichtenverlauf lesen
- ✅ Links einbetten
- ✅ Dateien anhängen
- ✅ Reaktionen hinzufügen (optional, aber empfohlen)
- ✅ Externe Emojis / Sticker verwenden (optional; nur wenn gewünscht)

Vermeiden Sie **Administrator**, außer Sie debuggen und vertrauen dem Bot vollständig.

Kopieren Sie die generierte URL, öffnen Sie sie, wählen Sie Ihren Server aus und installieren Sie den Bot.

### 4. IDs ermitteln (Guild/Benutzer/Kanal)

Discord verwendet überall numerische IDs; die OpenClaw-Konfiguration bevorzugt IDs.

1. Discord (Desktop/Web) → **User Settings** → **Advanced** → **Developer Mode** aktivieren
2. Rechtsklick:
   - Servername → **Copy Server ID** (Guild-ID)
   - Kanal (z. B. `#help`) → **Copy Channel ID**
   - Ihr Benutzer → **Copy User ID**

### 5) OpenClaw konfigurieren

#### Token

Setzen Sie das Bot-Token per Env-Var (auf Servern empfohlen):

- `DISCORD_BOT_TOKEN=...`

Oder per Konfiguration:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Multi-Account-Unterstützung: Verwenden Sie `channels.discord.accounts` mit Tokens pro Account und optionalem `name`. Siehe [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) für das gemeinsame Muster.

#### Allowlist + Kanal-Routing

Beispiel „ein Server, nur ich erlaubt, nur #help erlaubt“:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Hinweise:

- `requireMention: true` bedeutet, dass der Bot nur bei Erwähnung antwortet (empfohlen für geteilte Kanäle).
- `agents.list[].groupChat.mentionPatterns` (oder `messages.groupChat.mentionPatterns`) zählen ebenfalls als Erwähnungen für Guild-Nachrichten.
- Multi-Agent-Override: Setzen Sie pro Agent Muster unter `agents.list[].groupChat.mentionPatterns`.
- Wenn `channels` vorhanden ist, werden alle nicht aufgeführten Kanäle standardmäßig abgelehnt.
- Verwenden Sie einen `"*"`-Kanal-Eintrag, um Standardwerte für alle Kanäle anzuwenden; explizite Kanal-Einträge überschreiben den Platzhalter.
- Threads erben die Konfiguration des Elternkanals (Allowlist, `requireMention`, Skills, Prompts usw.), sofern Sie die Thread-Kanal-ID nicht explizit hinzufügen. es sei denn, Sie fügen die Thread-Kanal-ID explizit hinzu.
- Owner-Hinweis: Wenn eine Allowlist `users` pro Guild oder pro Kanal auf den Absender zutrifft, behandelt OpenClaw diesen Absender im System-Prompt als Owner. Für einen globalen Owner über alle Kanäle hinweg setzen Sie `commands.ownerAllowFrom`.
- Vom Bot verfasste Nachrichten werden standardmäßig ignoriert; setzen Sie `channels.discord.allowBots=true`, um sie zuzulassen (eigene Nachrichten bleiben gefiltert).
- Warnung: Wenn Sie Antworten an andere Bots erlauben (`channels.discord.allowBots=true`), verhindern Sie Bot-zu-Bot-Schleifen mit `requireMention`, `channels.discord.guilds.*.channels.<id>.users`-Allowlists und/oder klaren Schutzmechanismen in `AGENTS.md` und `SOUL.md`.

### 6. Funktion prüfen

1. Starten Sie das Gateway.
2. Senden Sie im Serverkanal: `@Krill hello` (oder wie auch immer Ihr Bot heißt).
3. Wenn nichts passiert: prüfen Sie **Fehlerbehebung** unten.

### Fehlerbehebung

- Zuerst: führen Sie `openclaw doctor` und `openclaw channels status --probe` aus (umsetzbare Warnungen + Kurzprüfungen).
- **„Used disallowed intents“**: Aktivieren Sie **Message Content Intent** (und vermutlich **Server Members Intent**) im Developer Portal und starten Sie das Gateway neu.
- **Bot verbindet sich, antwortet aber nie in einem Guild-Kanal**:
  - Fehlender **Message Content Intent**, oder
  - Dem Bot fehlen Kanalberechtigungen (Anzeigen/Senden/Verlauf lesen), oder
  - Ihre Konfiguration erfordert Erwähnungen und Sie haben ihn nicht erwähnt, oder
  - Ihre Guild-/Kanal-Allowlist lehnt Kanal/Benutzer ab.
- **`requireMention: false` aber weiterhin keine Antworten**:
- `channels.discord.groupPolicy` ist standardmäßig **allowlist**; setzen Sie es auf `"open"` oder fügen Sie unter `channels.discord.guilds` einen Guild-Eintrag hinzu (optional Kanäle unter `channels.discord.guilds.<id>.channels` einschränken).
  - Wenn Sie nur `DISCORD_BOT_TOKEN` setzen und nie einen Abschnitt `channels.discord` erstellen, setzt die Laufzeit
    `groupPolicy` standardmäßig auf `open`. Fügen Sie `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy` oder eine Guild-/Kanal-Allowlist hinzu, um es abzusichern.
- `requireMention` muss unter `channels.discord.guilds` (oder einem spezifischen Kanal) liegen. `channels.discord.requireMention` auf oberster Ebene wird ignoriert.
- **Berechtigungsprüfungen** (`channels status --probe`) prüfen nur numerische Kanal-IDs. Wenn Sie Slugs/Namen als Schlüssel `channels.discord.guilds.*.channels` verwenden, kann die Prüfung Berechtigungen nicht verifizieren.
- **DMs funktionieren nicht**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"` oder Sie wurden noch nicht genehmigt (`channels.discord.dm.policy="pairing"`).
- **Exec-Genehmigungen in Discord**: Discord unterstützt eine **Button-UI** für Exec-Genehmigungen in DMs (Einmal erlauben / Immer erlauben / Ablehnen). `/approve <id> ...` gilt nur für weitergeleitete Genehmigungen und löst die Discord-Buttons nicht. Wenn Sie `❌ Failed to submit approval: Error: unknown approval id` sehen oder die UI nie erscheint, prüfen Sie:
  - `channels.discord.execApprovals.enabled: true` in Ihrer Konfiguration.
  - Ihre Discord-Benutzer-ID ist in `channels.discord.execApprovals.approvers` aufgeführt (die UI wird nur an Genehmiger gesendet).
  - Verwenden Sie die Buttons in der DM-Aufforderung (**Einmal erlauben**, **Immer erlauben**, **Ablehnen**).
  - Siehe [Exec approvals](/tools/exec-approvals) und [Slash commands](/tools/slash-commands) für den übergreifenden Genehmigungs- und Befehlsfluss.

## Funktionen & Grenzen

- DMs und Guild-Textkanäle (Threads werden als separate Kanäle behandelt; Sprache nicht unterstützt).
- Tippindikatoren werden nach bestem Effort gesendet; Nachrichten-Splitting nutzt `channels.discord.textChunkLimit` (Standard 2000) und teilt lange Antworten nach Zeilenanzahl (`channels.discord.maxLinesPerMessage`, Standard 17).
- Optionales Absatz-Splitting: setzen Sie `channels.discord.chunkMode="newline"`, um vor dem Längen-Splitting an Leerzeilen (Absatzgrenzen) zu trennen.
- Datei-Uploads bis zur konfigurierten Größe `channels.discord.mediaMaxMb` (Standard 8 MB).
- Erwähnungsbasierte Guild-Antworten standardmäßig aktiviert, um laute Bots zu vermeiden.
- Antwortkontext wird eingefügt, wenn eine Nachricht auf eine andere verweist (zitierter Inhalt + IDs).
- Native Antwort-Threading ist **standardmäßig aus**; aktivieren Sie es mit `channels.discord.replyToMode` und Antwort-Tags.

## Retry-Richtlinie

Ausgehende Discord-API-Aufrufe werden bei Rate Limits (429) unter Verwendung von Discord `retry_after` (sofern verfügbar) mit exponentiellem Backoff und Jitter wiederholt. Konfigurieren Sie dies über `channels.discord.retry`. Siehe [Retry policy](/concepts/retry).

## Konfiguration

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Ack-Reaktionen werden global über `messages.ackReaction` +
`messages.ackReactionScope` gesteuert. Verwenden Sie `messages.removeAckAfterReply`, um die
Ack-Reaktion nach der Antwort des Bots zu entfernen.

- `dm.enabled`: setzen Sie `false`, um alle DMs zu ignorieren (Standard `true`).
- `dm.policy`: DM-Zugriffskontrolle (`pairing` empfohlen). `"open"` erfordert `dm.allowFrom=["*"]`.
- `dm.allowFrom`: DM-Allowlist (Benutzer-IDs oder Namen). Verwendet von `dm.policy="allowlist"` und für `dm.policy="open"`-Validierung. Der Assistent akzeptiert Benutzernamen und löst sie zu IDs auf, wenn der Bot Mitglieder suchen kann.
- `dm.groupEnabled`: Gruppen-DMs aktivieren (Standard `false`).
- `dm.groupChannels`: optionale Allowlist für Gruppen-DM-Kanal-IDs oder Slugs.
- `groupPolicy`: steuert die Behandlung von Guild-Kanälen (`open|disabled|allowlist`); `allowlist` erfordert Kanal-Allowlists.
- `guilds`: Regeln pro Guild, nach Guild-ID (bevorzugt) oder Slug.
- `guilds."*"`: Standard-Guild-Einstellungen, wenn kein expliziter Eintrag existiert.
- `guilds.<id>.slug`: optionaler freundlicher Slug für Anzeigenamen.
- `guilds.<id>.users`: optionale Benutzer-Allowlist pro Guild (IDs oder Namen).
- `guilds.<id>.tools`: optionale Tool-Policy-Overrides pro Guild (`allow`/`deny`/`alsoAllow`), wenn der Kanal-Override fehlt.
- `guilds.<id>.toolsBySender`: optionale Tool-Policy-Overrides pro Absender auf Guild-Ebene (gilt, wenn der Kanal-Override fehlt; Platzhalter `"*"` unterstützt).
- `guilds.<id>.channels.<channel>.allow`: Kanal zulassen/ablehnen, wenn `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: Erwähnungs-Gating für den Kanal.
- `guilds.<id>.channels.<channel>.tools`: optionale Tool-Policy-Overrides pro Kanal (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: optionale Tool-Policy-Overrides pro Absender innerhalb des Kanals (Platzhalter `"*"` unterstützt).
- `guilds.<id>.channels.<channel>.users`: optionale Benutzer-Allowlist pro Kanal.
- `guilds.<id>.channels.<channel>.skills`: Skill-Filter (weglassen = alle Skills, leer = keine).
- `guilds.<id>.channels.<channel>.systemPrompt`: zusätzlicher System-Prompt für den Kanal. Discord-Kanalthemen werden als **nicht vertrauenswürdiger** Kontext injiziert (nicht als System-Prompt).
- `guilds.<id>.channels.<channel>.enabled`: setzen Sie `false`, um den Kanal zu deaktivieren.
- `guilds.<id>.channels`: Kanalregeln (Schlüssel sind Kanal-Slugs oder -IDs).
- `guilds.<id>.requireMention`: Erwähnungspflicht pro Guild (pro Kanal überschreibbar).
- `guilds.<id>.reactionNotifications`: Reaktions-Systemereignismodus (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: Größe der ausgehenden Text-Chunks (Zeichen). Standard: 2000.
- `chunkMode`: `length` (Standard) teilt nur bei Überschreitung von `textChunkLimit`; `newline` teilt an Leerzeilen (Absatzgrenzen) vor dem Längen-Splitting.
- `maxLinesPerMessage`: weiches Maximum der Zeilenanzahl pro Nachricht. Standard: 17.
- `mediaMaxMb`: Begrenzung eingehender Medien, die auf Datenträger gespeichert werden.
- `historyLimit`: Anzahl der jüngsten Guild-Nachrichten, die beim Antworten auf eine Erwähnung als Kontext einbezogen werden (Standard 20; Fallback auf `messages.groupChat.historyLimit`; `0` deaktiviert).
- `dmHistoryLimit`: DM-Verlaufslimit in Benutzerzügen. Pro-Benutzer-Overrides: `dms["<user_id>"].historyLimit`.
- `retry`: Retry-Richtlinie für ausgehende Discord-API-Aufrufe (Versuche, minDelayMs, maxDelayMs, Jitter).
- `pluralkit`: PluralKit-proxied Nachrichten auflösen, sodass Systemmitglieder als separate Absender erscheinen.
- `actions`: Tool-Gates pro Aktion; weglassen = alles erlauben (setzen Sie `false`, um zu deaktivieren).
  - `reactions` (deckt Reaktionen + Reaktionen lesen ab)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (Kanäle + Kategorien + Berechtigungen erstellen/bearbeiten/löschen)
  - `roles` (Rollen hinzufügen/entfernen, Standard `false`)
  - `moderation` (Timeout/Kick/Ban, Standard `false`)
  - `presence` (Bot-Status/Aktivität, Standard `false`)
- `execApprovals`: Discord-spezifische Exec-Genehmigungs-DMs (Button-UI). Unterstützt `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Reaktionsbenachrichtigungen verwenden `guilds.<id>.reactionNotifications`:

- `off`: keine Reaktionsereignisse.
- `own`: Reaktionen auf eigene Bot-Nachrichten (Standard).
- `all`: alle Reaktionen auf allen Nachrichten.
- `allowlist`: Reaktionen von `guilds.<id>.users` auf allen Nachrichten (leere Liste deaktiviert).

### PluralKit (PK)-Unterstützung

Aktivieren Sie PK-Lookups, damit proxied Nachrichten dem zugrunde liegenden System + Mitglied zugeordnet werden.
Wenn aktiviert, verwendet OpenClaw die Mitgliederidentität für Allowlists und kennzeichnet den
Absender als `Member (PK:System)`, um unbeabsichtigte Discord-Pings zu vermeiden.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Allowlist-Hinweise (PK aktiviert):

- Verwenden Sie `pk:<memberId>` in `dm.allowFrom`, `guilds.<id>.users` oder pro Kanal `users`.
- Anzeigenamen von Mitgliedern werden ebenfalls nach Name/Slug abgeglichen.
- Lookups verwenden die **ursprüngliche** Discord-Nachrichten-ID (die vor dem Proxy), sodass
  die PK-API sie nur innerhalb ihres 30‑Minuten-Fensters auflöst.
- Wenn PK-Lookups fehlschlagen (z. B. privates System ohne Token), werden proxied Nachrichten
  als Bot-Nachrichten behandelt und verworfen, sofern nicht `channels.discord.allowBots=true` gesetzt ist.

### Standardwerte für Tool-Aktionen

| Aktionsgruppe  | Standard    | Hinweise                                               |
| -------------- | ----------- | ------------------------------------------------------ |
| reactions      | aktiviert   | Reagieren + Reaktionen auflisten + emojiList           |
| stickers       | aktiviert   | Sticker senden                                         |
| emojiUploads   | aktiviert   | Emojis hochladen                                       |
| stickerUploads | aktiviert   | Sticker hochladen                                      |
| polls          | aktiviert   | Umfragen erstellen                                     |
| permissions    | aktiviert   | Kanal-Berechtigungssnapshot                            |
| messages       | aktiviert   | Lesen/senden/bearbeiten/löschen                        |
| threads        | aktiviert   | Erstellen/auflisten/antworten                          |
| pins           | aktiviert   | Anpinnen/abpinnen/auflisten                            |
| search         | aktiviert   | Nachrichtensuche (Vorschaufunktion) |
| memberInfo     | aktiviert   | Mitgliederinformationen                                |
| roleInfo       | aktiviert   | Rollenliste                                            |
| channelInfo    | aktiviert   | Kanalinfo + Liste                                      |
| channels       | aktiviert   | Kanal-/Kategorieverwaltung                             |
| voiceStatus    | aktiviert   | Voice-Statusabfrage                                    |
| events         | aktiviert   | Geplante Events auflisten/erstellen                    |
| roles          | deaktiviert | Rollen hinzufügen/entfernen                            |
| moderation     | deaktiviert | Timeout/Kick/Ban                                       |
| presence       | deaktiviert | Bot-Status/Aktivität (setPresence)  |

- `replyToMode`: `off` (Standard), `first` oder `all`. Gilt nur, wenn das Modell ein Antwort-Tag enthält.

## Antwort-Tags

Um eine Thread-Antwort anzufordern, kann das Modell ein Tag in seiner Ausgabe enthalten:

- `[[reply_to_current]]` — Antwort auf die auslösende Discord-Nachricht.
- `[[reply_to:<id>]]` — Antwort auf eine bestimmte Nachrichten-ID aus Kontext/Verlauf.
  Aktuelle Nachrichten-IDs werden den Prompts als `[message_id: …]` angehängt; Verlaufseinträge enthalten bereits IDs.

Das Verhalten wird durch `channels.discord.replyToMode` gesteuert:

- `off`: Tags ignorieren.
- `first`: Nur der erste ausgehende Chunk/Anhang ist eine Antwort.
- `all`: Jeder ausgehende Chunk/Anhang ist eine Antwort.

Hinweise zum Allowlist-Abgleich:

- `allowFrom`/`users`/`groupChannels` akzeptieren IDs, Namen, Tags oder Erwähnungen wie `<@id>`.
- Präfixe wie `discord:`/`user:` (Benutzer) und `channel:` (Gruppen-DMs) werden unterstützt.
- Verwenden Sie `*`, um jeden Absender/Kanal zu erlauben.
- Wenn `guilds.<id>.channels` vorhanden ist, werden nicht aufgeführte Kanäle standardmäßig abgelehnt.
- Wenn `guilds.<id>.channels` fehlt, sind alle Kanäle in der allowlisteten Guild erlaubt.
- Um **keine Kanäle** zu erlauben, setzen Sie `channels.discord.groupPolicy: "disabled"` (oder lassen Sie die Allowlist leer).
- Der Konfigurationsassistent akzeptiert `Guild/Channel`-Namen (öffentlich + privat) und löst sie nach Möglichkeit zu IDs auf.
- Beim Start löst OpenClaw Kanal-/Benutzernamen in Allowlists zu IDs auf (wenn der Bot Mitglieder suchen kann)
  und protokolliert die Zuordnung; nicht auflösbare Einträge bleiben unverändert.

Hinweise zu nativen Befehlen:

- Die registrierten Befehle spiegeln OpenClaws Chat-Befehle wider.
- Native Befehle beachten dieselben Allowlists wie DMs/Guild-Nachrichten (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, Regeln pro Kanal).
- Slash-Befehle können in der Discord-UI für nicht allowlistete Benutzer sichtbar sein; OpenClaw erzwingt die Allowlists bei der Ausführung und antwortet mit „not authorized“.

## Tool-Aktionen

Der Agent kann `discord` mit Aktionen wie folgenden aufrufen:

- `react` / `reactions` (Reaktionen hinzufügen oder auflisten)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Read/Search/Pin-Tool-Payloads enthalten normalisierte `timestampMs` (UTC-Epoch-ms) und `timestampUtc` neben den rohen Discord-`timestamp`.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (Bot-Aktivität und Online-Status)

Discord-Nachrichten-IDs werden im injizierten Kontext (`[discord message id: …]` und Verlaufzeilen) bereitgestellt, sodass der Agent sie gezielt ansprechen kann.
Emojis können Unicode sein (z. B. `✅`) oder benutzerdefinierte Emoji-Syntax wie `<:party_blob:1234567890>`.

## Sicherheit & Betrieb

- Behandeln Sie das Bot-Token wie ein Passwort; bevorzugen Sie die Env-Var `DISCORD_BOT_TOKEN` auf überwachten Hosts oder beschränken Sie die Dateiberechtigungen der Konfigurationsdatei.
- Gewähren Sie dem Bot nur die Berechtigungen, die er benötigt (typischerweise Nachrichten lesen/senden).
- Wenn der Bot festhängt oder rate-limitiert ist, starten Sie das Gateway (`openclaw gateway --force`) neu, nachdem Sie bestätigt haben, dass keine anderen Prozesse die Discord-Sitzung besitzen.
