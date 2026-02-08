---
summary: "WhatsApp-Integration (Web-Kanal): Login, Inbox, Antworten, Medien und Betrieb"
read_when:
  - Arbeit am Verhalten des WhatsApp/Web-Kanals oder an der Inbox-Routinglogik
title: "WhatsApp"
x-i18n:
  source_path: channels/whatsapp.md
  source_hash: 9f7acdf2c71819ae
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:57Z
---

# WhatsApp (Web-Kanal)

Status: Nur WhatsApp Web über Baileys. Das Gateway besitzt die Sitzung(en).

## Schnellstart (Anfänger)

1. Verwenden Sie nach Möglichkeit eine **separate Telefonnummer** (empfohlen).
2. Konfigurieren Sie WhatsApp in `~/.openclaw/openclaw.json`.
3. Führen Sie `openclaw channels login` aus, um den QR-Code zu scannen (Verknüpfte Geräte).
4. Starten Sie das Gateway.

Minimale Konfiguration:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

## Ziele

- Mehrere WhatsApp-Konten (Multi-Account) in einem Gateway-Prozess.
- Deterministisches Routing: Antworten gehen zurück zu WhatsApp, kein Modell-Routing.
- Das Modell sieht ausreichend Kontext, um zitierte Antworten zu verstehen.

## Konfigurationsschreibzugriffe

Standardmäßig darf WhatsApp Konfigurationsupdates schreiben, die durch `/config set|unset` ausgelöst werden (erfordert `commands.config: true`).

Deaktivieren mit:

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## Architektur (wer besitzt was)

- **Gateway** besitzt den Baileys-Socket und die Inbox-Schleife.
- **CLI / macOS-App** kommunizieren mit dem Gateway; keine direkte Baileys-Nutzung.
- **Aktiver Listener** ist für ausgehende Sendungen erforderlich; andernfalls schlägt das Senden sofort fehl.

## Eine Telefonnummer erhalten (zwei Modi)

WhatsApp erfordert eine echte Mobilnummer zur Verifizierung. VoIP- und virtuelle Nummern werden meist blockiert. Es gibt zwei unterstützte Wege, OpenClaw mit WhatsApp zu betreiben:

### Dedizierte Nummer (empfohlen)

Verwenden Sie eine **separate Telefonnummer** für OpenClaw. Beste UX, sauberes Routing, keine Self-Chat-Eigenheiten. Ideales Setup: **Ersatz-/altes Android-Telefon + eSIM**. Lassen Sie es mit WLAN und Strom verbunden und verknüpfen Sie es per QR.

**WhatsApp Business:** Sie können WhatsApp Business auf demselben Gerät mit einer anderen Nummer verwenden. Ideal, um Ihr persönliches WhatsApp getrennt zu halten — installieren Sie WhatsApp Business und registrieren Sie dort die OpenClaw-Nummer.

**Beispielkonfiguration (dedizierte Nummer, Single-User-Allowlist):**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

**Pairing-Modus (optional):**  
Wenn Sie Pairing statt Allowlist möchten, setzen Sie `channels.whatsapp.dmPolicy` auf `pairing`. Unbekannte Absender erhalten einen Pairing-Code; genehmigen Sie mit:
`openclaw pairing approve whatsapp <code>`

### Persönliche Nummer (Fallback)

Schneller Fallback: Betreiben Sie OpenClaw mit **Ihrer eigenen Nummer**. Schreiben Sie sich selbst (WhatsApp „Nachricht an mich“) zum Testen, damit Sie keine Kontakte spammen. Rechnen Sie damit, während Setup und Experimenten Verifizierungscodes auf Ihrem Haupttelefon zu lesen. **Self-Chat-Modus muss aktiviert sein.**  
Wenn der Assistent nach Ihrer persönlichen WhatsApp-Nummer fragt, geben Sie das Telefon ein, von dem Sie schreiben werden (Eigentümer/Absender), nicht die Assistenten-Nummer.

**Beispielkonfiguration (persönliche Nummer, Self-Chat):**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

Self-Chat-Antworten verwenden standardmäßig `[{identity.name}]`, wenn gesetzt (ansonsten `[openclaw]`),  
falls `messages.responsePrefix` nicht gesetzt ist. Setzen Sie es explizit, um das Präfix anzupassen oder zu deaktivieren  
(verwenden Sie `""`, um es zu entfernen).

### Tipps zur Nummernbeschaffung

- **Lokale eSIM** Ihres Mobilfunkanbieters (am zuverlässigsten)
  - Österreich: [hot.at](https://www.hot.at)
  - UK: [giffgaff](https://www.giffgaff.com) — kostenlose SIM, kein Vertrag
- **Prepaid-SIM** — günstig, muss nur eine SMS zur Verifizierung empfangen

**Vermeiden:** TextNow, Google Voice, die meisten „kostenlosen SMS“-Dienste — WhatsApp blockiert diese aggressiv.

**Tipp:** Die Nummer muss nur eine Verifizierungs-SMS empfangen. Danach bleiben WhatsApp-Web-Sitzungen über `creds.json` bestehen.

## Warum nicht Twilio?

- Frühe OpenClaw-Builds unterstützten Twilios WhatsApp-Business-Integration.
- WhatsApp-Business-Nummern sind für einen persönlichen Assistenten ungeeignet.
- Meta erzwingt ein 24‑Stunden-Antwortfenster; wenn Sie in den letzten 24 Stunden nicht geantwortet haben, kann die Business-Nummer keine neuen Nachrichten initiieren.
- Hohe Volumina oder „chatty“ Nutzung führen zu aggressiven Sperren, da Business-Konten nicht für dutzende persönliche Assistenten-Nachrichten gedacht sind.
- Ergebnis: Unzuverlässige Zustellung und häufige Sperren, daher wurde der Support entfernt.

## Login + Anmeldedaten

- Login-Befehl: `openclaw channels login` (QR über Verknüpfte Geräte).
- Multi-Account-Login: `openclaw channels login --account <id>` (`<id>` = `accountId`).
- Standardkonto (wenn `--account` weggelassen wird): `default`, falls vorhanden, sonst die erste konfigurierte Konto-ID (sortiert).
- Anmeldedaten gespeichert in `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`.
- Sicherungskopie unter `creds.json.bak` (wird bei Beschädigung wiederhergestellt).
- Legacy-Kompatibilität: Ältere Installationen speicherten Baileys-Dateien direkt in `~/.openclaw/credentials/`.
- Logout: `openclaw channels logout` (oder `--account <id>`) löscht den WhatsApp-Auth-Status (behält jedoch gemeinsame `oauth.json`).
- Abgemeldeter Socket ⇒ Fehler weist auf erneutes Verknüpfen hin.

## Eingehender Fluss (DM + Gruppe)

- WhatsApp-Ereignisse kommen von `messages.upsert` (Baileys).
- Inbox-Listener werden beim Shutdown getrennt, um das Ansammeln von Event-Handlern bei Tests/Neustarts zu vermeiden.
- Status-/Broadcast-Chats werden ignoriert.
- Direktchats verwenden E.164; Gruppen verwenden Group-JID.
- **DM-Richtlinie**: `channels.whatsapp.dmPolicy` steuert den Zugriff auf Direktchats (Standard: `pairing`).
  - Pairing: Unbekannte Absender erhalten einen Pairing-Code (Genehmigung über `openclaw pairing approve whatsapp <code>`; Codes laufen nach 1 Stunde ab).
  - Offen: erfordert, dass `channels.whatsapp.allowFrom` `"*"` enthält.
  - Ihre verknüpfte WhatsApp-Nummer ist implizit vertrauenswürdig, daher überspringen Selbstnachrichten die Prüfungen `channels.whatsapp.dmPolicy` und `channels.whatsapp.allowFrom`.

### Persönliche-Nummer-Modus (Fallback)

Wenn Sie OpenClaw mit **Ihrer persönlichen WhatsApp-Nummer** betreiben, aktivieren Sie `channels.whatsapp.selfChatMode` (siehe Beispiel oben).

Verhalten:

- Ausgehende DMs lösen niemals Pairing-Antworten aus (verhindert das Spammen von Kontakten).
- Eingehende unbekannte Absender folgen weiterhin `channels.whatsapp.dmPolicy`.
- Self-Chat-Modus (allowFrom enthält Ihre Nummer) vermeidet automatische Lesebestätigungen und ignoriert Mention-JIDs.
- Lesebestätigungen werden für Nicht-Self-Chat-DMs gesendet.

## Lesebestätigungen

Standardmäßig markiert das Gateway eingehende WhatsApp-Nachrichten als gelesen (blaue Häkchen), sobald sie akzeptiert werden.

Global deaktivieren:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

Pro Konto deaktivieren:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false },
      },
    },
  },
}
```

Hinweise:

- Im Self-Chat-Modus werden Lesebestätigungen immer übersprungen.

## WhatsApp-FAQ: Nachrichten senden + Pairing

**Wird OpenClaw zufällige Kontakte anschreiben, wenn ich WhatsApp verknüpfe?**  
Nein. Die Standard-DM-Richtlinie ist **Pairing**, daher erhalten unbekannte Absender nur einen Pairing-Code und ihre Nachricht wird **nicht verarbeitet**. OpenClaw antwortet nur auf Chats, die es erhält, oder auf Sendungen, die Sie explizit auslösen (Agent/CLI).

**Wie funktioniert Pairing bei WhatsApp?**  
Pairing ist ein DM-Gate für unbekannte Absender:

- Erste DM eines neuen Absenders gibt einen kurzen Code zurück (Nachricht wird nicht verarbeitet).
- Genehmigen mit: `openclaw pairing approve whatsapp <code>` (Liste mit `openclaw pairing list whatsapp`).
- Codes laufen nach 1 Stunde ab; ausstehende Anfragen sind auf 3 pro Kanal begrenzt.

**Können mehrere Personen verschiedene OpenClaw-Instanzen mit einer WhatsApp-Nummer nutzen?**  
Ja, indem jeder Absender über `bindings` zu einem anderen Agenten geroutet wird (Peer `kind: "dm"`, Absender E.164 wie `+15551234567`). Antworten kommen weiterhin vom **gleichen WhatsApp-Konto**, und Direktchats kollabieren zur Hauptsitzung jedes Agenten, daher **ein Agent pro Person** verwenden. Die DM-Zugriffskontrolle (`dmPolicy`/`allowFrom`) ist global pro WhatsApp-Konto. Siehe [Multi-Agent Routing](/concepts/multi-agent).

**Warum fragt der Assistent nach meiner Telefonnummer?**  
Der Assistent verwendet sie, um Ihre **Allowlist/Eigentümer** zu setzen, damit Ihre eigenen DMs erlaubt sind. Sie wird nicht für automatisches Senden verwendet. Wenn Sie mit Ihrer persönlichen WhatsApp-Nummer arbeiten, verwenden Sie dieselbe Nummer und aktivieren Sie `channels.whatsapp.selfChatMode`.

## Nachrichten-Normalisierung (was das Modell sieht)

- `Body` ist der aktuelle Nachrichtenkörper mit Umschlag.
- Kontext zitierter Antworten wird **immer angehängt**:

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- Antwort-Metadaten werden ebenfalls gesetzt:
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = zitierter Textkörper oder Medien-Platzhalter
  - `ReplyToSender` = E.164, wenn bekannt
- Eingehende Nachrichten nur mit Medien verwenden Platzhalter:
  - `<media:image|video|audio|document|sticker>`

## Gruppen

- Gruppen werden auf `agent:<agentId>:whatsapp:group:<jid>`-Sitzungen abgebildet.
- Gruppenrichtlinie: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (Standard `allowlist`).
- Aktivierungsmodi:
  - `mention` (Standard): erfordert @Erwähnung oder Regex-Treffer.
  - `always`: löst immer aus.
- `/activation mention|always` ist nur für Eigentümer und muss als eigenständige Nachricht gesendet werden.
- Eigentümer = `channels.whatsapp.allowFrom` (oder Self E.164, wenn nicht gesetzt).
- **History Injection** (nur ausstehend):
  - Aktuelle _unverarbeitete_ Nachrichten (Standard 50) werden eingefügt unter:
    `[Chat messages since your last reply - for context]` (Nachrichten, die bereits in der Sitzung sind, werden nicht erneut injiziert)
  - Aktuelle Nachricht unter:
    `[Current message - respond to this]`
  - Absender-Suffix angehängt: `[from: Name (+E164)]`
- Gruppenmetadaten werden 5 Minuten gecacht (Thema + Teilnehmer).

## Antwortzustellung (Threading)

- WhatsApp Web sendet Standardnachrichten (kein Zitier-Threading im aktuellen Gateway).
- Antwort-Tags werden in diesem Kanal ignoriert.

## Bestätigungsreaktionen (Auto-Reaktion beim Empfang)

WhatsApp kann automatisch Emoji-Reaktionen auf eingehende Nachrichten senden, unmittelbar nach dem Empfang, bevor der Bot eine Antwort generiert. Dies gibt Nutzern sofortiges Feedback, dass ihre Nachricht eingegangen ist.

**Konfiguration:**

```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**Optionen:**

- `emoji` (String): Emoji für die Bestätigung (z. B. „👀“, „✅“, „📨“). Leer oder nicht gesetzt = Funktion deaktiviert.
- `direct` (Boolean, Standard: `true`): Reaktionen in Direkt-/DM-Chats senden.
- `group` (String, Standard: `"mentions"`): Verhalten in Gruppenchats:
  - `"always"`: Auf alle Gruppennachrichten reagieren (auch ohne @Erwähnung)
  - `"mentions"`: Nur reagieren, wenn der Bot @erwähnt wird
  - `"never"`: Niemals in Gruppen reagieren

**Pro-Konto-Override:**

```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**Verhaltenshinweise:**

- Reaktionen werden **sofort** beim Nachrichteneingang gesendet, vor Tippindikatoren oder Bot-Antworten.
- In Gruppen mit `requireMention: false` (Aktivierung: immer) reagiert `group: "mentions"` auf alle Nachrichten (nicht nur @Erwähnungen).
- Fire-and-forget: Fehler bei Reaktionen werden protokolliert, verhindern aber keine Bot-Antwort.
- Teilnehmer-JID wird für Gruppenreaktionen automatisch eingeschlossen.
- WhatsApp ignoriert `messages.ackReaction`; verwenden Sie stattdessen `channels.whatsapp.ackReaction`.

## Agent-Werkzeug (Reaktionen)

- Werkzeug: `whatsapp` mit Aktion `react` (`chatJid`, `messageId`, `emoji`, optional `remove`).
- Optional: `participant` (Gruppenabsender), `fromMe` (Reaktion auf eigene Nachricht), `accountId` (Multi-Account).
- Semantik zum Entfernen von Reaktionen: siehe [/tools/reactions](/tools/reactions).
- Werkzeug-Gating: `channels.whatsapp.actions.reactions` (Standard: aktiviert).

## Limits

- Ausgehender Text wird in `channels.whatsapp.textChunkLimit` gechunked (Standard 4000).
- Optionale Newline-Chunking: Setzen Sie `channels.whatsapp.chunkMode="newline"`, um vor dem Längen-Chunking an Leerzeilen (Absatzgrenzen) zu trennen.
- Eingehende Medienspeicher sind durch `channels.whatsapp.mediaMaxMb` begrenzt (Standard 50 MB).
- Ausgehende Medien sind durch `agents.defaults.mediaMaxMb` begrenzt (Standard 5 MB).

## Ausgehendes Senden (Text + Medien)

- Verwendet aktiven Web-Listener; Fehler, wenn das Gateway nicht läuft.
- Text-Chunking: max. 4k pro Nachricht (konfigurierbar über `channels.whatsapp.textChunkLimit`, optional `channels.whatsapp.chunkMode`).
- Medien:
  - Bild/Video/Audio/Dokument unterstützt.
  - Audio wird als PTT gesendet; `audio/ogg` ⇒ `audio/ogg; codecs=opus`.
  - Beschriftung nur beim ersten Medienelement.
  - Medienabruf unterstützt HTTP(S) und lokale Pfade.
  - Animierte GIFs: WhatsApp erwartet MP4 mit `gifPlayback: true` für Inline-Looping.
    - CLI: `openclaw message send --media <mp4> --gif-playback`
    - Gateway: `send`-Parameter enthalten `gifPlayback: true`

## Sprachnachrichten (PTT-Audio)

WhatsApp sendet Audio als **Sprachnachrichten** (PTT-Blase).

- Beste Ergebnisse: OGG/Opus. OpenClaw schreibt `audio/ogg` zu `audio/ogg; codecs=opus` um.
- `[[audio_as_voice]]` wird für WhatsApp ignoriert (Audio wird bereits als Sprachnachricht geliefert).

## Medienlimits + Optimierung

- Standard-Limit ausgehend: 5 MB (pro Medienelement).
- Override: `agents.defaults.mediaMaxMb`.
- Bilder werden automatisch zu JPEG unter das Limit optimiert (Resize + Qualitäts-Sweep).
- Übergroße Medien ⇒ Fehler; Medienantwort fällt auf Textwarnung zurück.

## Heartbeats

- **Gateway-Heartbeat** protokolliert den Verbindungszustand (`web.heartbeatSeconds`, Standard 60 s).
- **Agent-Heartbeat** kann pro Agent (`agents.list[].heartbeat`) oder global  
  über `agents.defaults.heartbeat` konfiguriert werden (Fallback, wenn keine Pro-Agent-Einträge gesetzt sind).
  - Verwendet den konfigurierten Heartbeat-Prompt (Standard: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + `HEARTBEAT_OK`-Skip-Verhalten.
  - Zustellung standardmäßig über den zuletzt verwendeten Kanal (oder konfiguriertes Ziel).

## Wiederverbindungsverhalten

- Backoff-Richtlinie: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- Wenn maxAttempts erreicht ist, stoppt das Web-Monitoring (degradiert).
- Abgemeldet ⇒ stoppen und erneutes Verknüpfen erforderlich.

## Konfigurations-Schnellübersicht

- `channels.whatsapp.dmPolicy` (DM-Richtlinie: pairing/allowlist/open/disabled).
- `channels.whatsapp.selfChatMode` (Same-Phone-Setup; Bot verwendet Ihre persönliche WhatsApp-Nummer).
- `channels.whatsapp.allowFrom` (DM-Allowlist). WhatsApp verwendet E.164-Telefonnummern (keine Benutzernamen).
- `channels.whatsapp.mediaMaxMb` (Limit für eingehende Medienspeicherung).
- `channels.whatsapp.ackReaction` (Auto-Reaktion beim Nachrichteneingang: `{emoji, direct, group}`).
- `channels.whatsapp.accounts.<accountId>.*` (Pro-Konto-Einstellungen + optional `authDir`).
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (Pro-Konto-Limit für eingehende Medien).
- `channels.whatsapp.accounts.<accountId>.ackReaction` (Pro-Konto-Override für Bestätigungsreaktionen).
- `channels.whatsapp.groupAllowFrom` (Allowlist für Gruppenabsender).
- `channels.whatsapp.groupPolicy` (Gruppenrichtlinie).
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit` (Gruppen-History-Kontext; `0` deaktiviert).
- `channels.whatsapp.dmHistoryLimit` (DM-History-Limit in Benutzer-Turns). Pro-Benutzer-Overrides: `channels.whatsapp.dms["<phone>"].historyLimit`.
- `channels.whatsapp.groups` (Gruppen-Allowlist + Mention-Gating-Defaults; verwenden Sie `"*"`, um alle zu erlauben)
- `channels.whatsapp.actions.reactions` (Gating für WhatsApp-Werkzeugreaktionen).
- `agents.list[].groupChat.mentionPatterns` (oder `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (eingehendes Präfix; pro Konto: `channels.whatsapp.accounts.<accountId>.messagePrefix`; veraltet: `messages.messagePrefix`)
- `messages.responsePrefix` (ausgehendes Präfix)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (optional Override)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (Pro-Agent-Overrides)
- `session.*` (Scope, Idle, Store, mainKey)
- `web.enabled` (deaktiviert den Kanalstart, wenn false)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Logs + Fehlerbehebung

- Subsysteme: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- Logdatei: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (konfigurierbar).
- Leitfaden zur Fehlerbehebung: [Gateway troubleshooting](/gateway/troubleshooting).

## Fehlerbehebung (kurz)

**Nicht verknüpft / QR-Login erforderlich**

- Symptom: `channels status` zeigt `linked: false` oder warnt „Not linked“.
- Lösung: Führen Sie `openclaw channels login` auf dem Gateway-Host aus und scannen Sie den QR (WhatsApp → Einstellungen → Verknüpfte Geräte).

**Verknüpft, aber getrennt / Wiederverbindungs-Loop**

- Symptom: `channels status` zeigt `running, disconnected` oder warnt „Linked but disconnected“.
- Lösung: `openclaw doctor` (oder Gateway neu starten). Wenn es anhält, erneut verknüpfen über `channels login` und `openclaw logs --follow` prüfen.

**Bun-Runtime**

- Bun wird **nicht empfohlen**. WhatsApp (Baileys) und Telegram sind unter Bun unzuverlässig.  
  Führen Sie das Gateway mit **Node** aus. (Siehe Hinweis zur Runtime in Erste Schritte.)
