---
summary: "„Heartbeat-Abfragemeldungen und Benachrichtigungsregeln“"
read_when:
  - Anpassen der Heartbeat-Taktung oder -Nachrichten
  - Entscheidung zwischen Heartbeat und Cron für geplante Aufgaben
title: "„Heartbeat“"
---

# Heartbeat (Gateway)

> **Heartbeat vs. Cron?** Siehe [Cron vs Heartbeat](/automation/cron-vs-heartbeat) für Hinweise, wann welches Verfahren zu verwenden ist.

Heartbeat führt **periodische Agent-Turns** in der Hauptsitzung aus, damit das Modell
alles, was Aufmerksamkeit erfordert, anzeigen kann, ohne Sie zu spammen.

Fehlerbehebung: [/automation/troubleshooting](/automation/troubleshooting)

## Schnellstart (Anfänger)

1. Lassen Sie Heartbeats aktiviert (Standard ist `30m` oder `1h` für Anthropic OAuth/Setup-Token) oder legen Sie Ihre eigene Taktung fest.
2. Erstellen Sie eine kleine `HEARTBEAT.md`-Checkliste im Agent-Workspace (optional, aber empfohlen).
3. Entscheiden Sie, wohin Heartbeat-Nachrichten gesendet werden sollen (`target: "last"` ist der Standard).
4. Optional: Aktivieren Sie die Auslieferung der Heartbeat-Begründung für Transparenz.
5. Optional: Beschränken Sie Heartbeats auf aktive Stunden (lokale Zeit).

Beispielkonfiguration:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Standardwerte

- Intervall: `30m` (oder `1h`, wenn Anthropic OAuth/Setup-Token als Authentifizierungsmodus erkannt wird). Setzen Sie `agents.defaults.heartbeat.every` oder pro Agent `agents.list[].heartbeat.every`; verwenden Sie `0m`, um zu deaktivieren.
- Prompt-Text (konfigurierbar über `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Der Heartbeat-Prompt wird **wortgetreu** als Benutzernachricht gesendet. Der System-
  Prompt enthält einen Abschnitt „Heartbeat“, und der Lauf wird intern gekennzeichnet.
- Aktive Stunden (`heartbeat.activeHours`) werden in der konfigurierten Zeitzone geprüft.
  Außerhalb des Fensters werden Heartbeats übersprungen, bis der nächste Tick innerhalb des Fensters erfolgt.
  Außerhalb des Fensters werden Herzbeats übersprungen bis zum nächsten Häkchen im Fenster.

## Wofür der Heartbeat-Prompt gedacht ist

Der Standard-Prompt ist absichtlich breit gefasst:

- **Hintergrundaufgaben**: „Consider outstanding tasks“ veranlasst den Agenten,
  Nachverfolgungen (Posteingang, Kalender, Erinnerungen, Warteschlangenarbeit) zu prüfen
  und Dringendes hervorzuheben.
- **Menschlicher Check-in**: „Checkup sometimes on your human during day time“ regt
  gelegentliche, leichte „Brauchen Sie etwas?“-Nachrichten an, vermeidet aber
  nächtlichen Spam durch Verwendung Ihrer konfigurierten lokalen Zeitzone
  (siehe [/concepts/timezone](/concepts/timezone)).

Wenn ein Heartbeat etwas sehr Spezifisches tun soll (z. B. „Gmail-PubSub-Statistiken prüfen“
oder „Gateway-Gesundheit verifizieren“), setzen Sie `agents.defaults.heartbeat.prompt` (oder
`agents.list[].heartbeat.prompt`) auf einen benutzerdefinierten Text (wortgetreu gesendet).

## Antwortvertrag

- Wenn nichts Aufmerksamkeit erfordert, antworten Sie mit **`HEARTBEAT_OK`**.
- Während Heartbeat-Läufen behandelt OpenClaw `HEARTBEAT_OK` als Bestätigung, wenn es
  **am Anfang oder Ende** der Antwort erscheint. Das Token wird entfernt, und die
  Antwort wird verworfen, wenn der verbleibende Inhalt **≤ `ackMaxChars`**
  ist (Standard: 300).
- Wenn `HEARTBEAT_OK` **in der Mitte** einer Antwort erscheint, wird es nicht
  speziell behandelt.
- Für Alarme **nicht** `HEARTBEAT_OK` einfügen; geben Sie nur den Alarmtext zurück.

Außerhalb von Heartbeats werden vereinzelte `HEARTBEAT_OK` am Anfang/Ende einer Nachricht
entfernt und protokolliert; eine Nachricht, die nur aus `HEARTBEAT_OK` besteht, wird verworfen.

## Konfiguration

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Geltungsbereich und Priorität

- `agents.defaults.heartbeat` legt das globale Heartbeat-Verhalten fest.
- `agents.list[].heartbeat` wird darübergelegt; wenn irgendein Agent einen `heartbeat`-Block hat,
  führen **nur diese Agenten** Heartbeats aus.
- `channels.defaults.heartbeat` legt Sichtbarkeits-Standardwerte für alle Kanäle fest.
- `channels.<channel>.heartbeat` überschreibt Kanal-Standardwerte.
- `channels.<channel>.accounts.<id>.heartbeat` (Mehrkonten-Kanäle) überschreibt kanalweise Einstellungen.

### Pro-Agent-Heartbeats

Wenn irgendein `agents.list[]`-Eintrag einen `heartbeat`-Block enthält, führen
**nur diese Agenten** Heartbeats aus. Der Pro-Agent-Block wird über `agents.defaults.heartbeat`
gelegt (so können Sie gemeinsame Standardwerte einmal festlegen und pro Agent überschreiben).

Beispiel: zwei Agenten, nur der zweite Agent führt Heartbeats aus.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Beispiel für aktive Stunden

Beschränken Sie Heartbeats auf Geschäftszeiten in einer bestimmten Zeitzone:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Außerhalb dieses Fensters (vor 9 Uhr oder nach 22 Uhr Eastern) werden Heartbeats übersprungen. Der nächste geplante Tick innerhalb des Fensters läuft normal.

### Beispiel für mehrere Konten

Verwenden Sie `accountId`, um ein bestimmtes Konto in Mehrkonten-Kanälen wie Telegram anzusprechen:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Feldnotizen

- `every`: Heartbeat-Intervall (Dauerzeichenfolge; Standardeinheit = Minuten).
- `model`: optionale Modellüberschreibung für Heartbeat-Läufe (`provider/model`).
- `includeReasoning`: wenn aktiviert, wird auch die separate `Reasoning:`-Nachricht
  ausgeliefert, sofern verfügbar (gleiche Form wie `/reasoning on`).
- `session`: optionaler Sitzungs-Schlüssel für Heartbeat-Läufe.
  - `main` (Standard): Hauptsitzung des Agenten.
  - Expliziter Sitzungs-Schlüssel (kopieren Sie ihn aus `openclaw sessions --json` oder der
    [sessions CLI](/cli/sessions)).
  - Sitzungs-Schlüsselformate: siehe [Sessions](/concepts/session) und [Groups](/channels/groups).
- `target`:
  - `last` (Standard): Auslieferung an den zuletzt verwendeten externen Kanal.
  - Expliziter Kanal: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: Heartbeat ausführen, aber **nicht extern ausliefern**.
- `to`: optionale Empfängerüberschreibung (kanalspezifische ID, z. B. E.164 für WhatsApp oder eine Telegram-Chat-ID).
- `accountId`: optionale Konto-ID für Mehrkonten-Kanäle. Wenn `target: "last"`, gilt die Konto-ID für den aufgelösten letzten Kanal, sofern dieser Konten unterstützt; andernfalls wird sie ignoriert. Wenn die Konto-ID keinem konfigurierten Konto für den aufgelösten Kanal entspricht, wird die Auslieferung übersprungen.
- `prompt`: überschreibt den Standard-Prompt-Text (wird nicht zusammengeführt).
- `ackMaxChars`: maximale Zeichenanzahl, die nach `HEARTBEAT_OK` vor der Auslieferung erlaubt ist.
- `activeHours`: beschränkt Heartbeat-Läufe auf ein Zeitfenster. Objekt mit `start` (HH:MM, inklusiv), `end` (HH:MM exklusiv; `24:00` für Tagesende zulässig) und optional `timezone`.
  - Weggelassen oder `"user"`: verwendet Ihre `agents.defaults.userTimezone`, falls gesetzt, andernfalls die Zeitzone des Host-Systems.
  - `"local"`: verwendet immer die Zeitzone des Host-Systems.
  - Beliebige IANA-Kennung (z. B. `America/New_York`): wird direkt verwendet; bei Ungültigkeit fällt es auf das oben genannte `"user"`-Verhalten zurück.
  - Außerhalb des aktiven Fensters werden Heartbeats übersprungen, bis der nächste Tick innerhalb des Fensters erfolgt.

## Auslieferungsverhalten

- Heartbeats laufen standardmäßig in der Hauptsitzung des Agenten (`agent:<id>:<mainKey>`)
  oder `global`, wenn `session.scope = "global"`. Setzen Sie `session`, um auf eine
  bestimmte Kanal-Sitzung (Discord/WhatsApp/etc.)
- `session` beeinflusst nur den Laufkontext; die Auslieferung wird durch
  `target` und `to` gesteuert.
- Um an einen bestimmten Kanal/Empfänger zu liefern, setzen Sie `target` +
  `to`. Mit `target: "last"` verwendet die Auslieferung den letzten externen
  Kanal für diese Sitzung.
- Wenn die Hauptwarteschlange ausgelastet ist, wird der Heartbeat übersprungen und
  später erneut versucht.
- Wenn `target` zu keinem externen Ziel aufgelöst wird, findet der Lauf dennoch
  statt, aber es wird keine ausgehende Nachricht gesendet.
- Nur-Heartbeat-Antworten halten die Sitzung **nicht** aktiv; der letzte
  `updatedAt` wird wiederhergestellt, sodass das Leerlauf-Ablaufen normal erfolgt.

## Sichtbarkeitssteuerungen

Standardmäßig werden `HEARTBEAT_OK`-Bestätigungen unterdrückt, während Alarm-Inhalte
ausgeliefert werden. Sie können dies pro Kanal oder pro Konto anpassen:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Priorität: Pro-Konto → Pro-Kanal → Kanal-Standardwerte → Eingebaute Standardwerte.

### Was jedes Flag bewirkt

- `showOk`: sendet eine `HEARTBEAT_OK`-Bestätigung, wenn das Modell eine reine OK-Antwort zurückgibt.
- `showAlerts`: sendet den Alarm-Inhalt, wenn das Modell eine Nicht-OK-Antwort zurückgibt.
- `useIndicator`: erzeugt Indikator-Ereignisse für UI-Statusoberflächen.

Wenn **alle drei** false sind, überspringt OpenClaw den Heartbeat-Lauf vollständig
(kein Modellaufruf).

### Beispiele: Pro-Kanal vs. Pro-Konto

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Häufige Muster

| Ziel                                                                     | Konfiguration                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Standardverhalten (stille OKs, Alarme an)             | _(keine Konfiguration erforderlich)_                                  |
| Vollständig still (keine Nachrichten, kein Indikator) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Nur Indikator (keine Nachrichten)                     | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OKs nur in einem Kanal                                                   | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (optional)

Wenn im Workspace eine `HEARTBEAT.md`-Datei existiert, weist der Standard-Prompt den
Agenten an, sie zu lesen. Denken Sie daran als Ihre „Heartbeat-Checkliste“: klein,
stabil und sicher, um sie alle 30 Minuten einzubinden.

Wenn `HEARTBEAT.md` existiert, aber faktisch leer ist (nur Leerzeilen und Markdown-
Überschriften wie `# Heading`), überspringt OpenClaw den Heartbeat-Lauf, um API-
Aufrufe zu sparen.
Wenn die Datei fehlt, läuft der Heartbeat trotzdem, und das Modell
entscheidet, was zu tun ist.

Halten Sie sie klein (kurze Checkliste oder Erinnerungen), um Prompt-Aufblähung zu vermeiden.

Beispiel `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Kann der Agent HEARTBEAT.md aktualisieren?

Ja — wenn Sie ihn darum bitten.

`HEARTBEAT.md` ist einfach eine normale Datei im Agent-Workspace, sodass Sie dem
Agenten (in einem normalen Chat) etwa Folgendes sagen können:

- „Aktualisiere `HEARTBEAT.md`, um eine tägliche Kalenderprüfung hinzuzufügen.“
- „Schreibe `HEARTBEAT.md` neu, damit es kürzer ist und sich auf Posteingangs-
  Nachverfolgungen konzentriert.“

Wenn Sie möchten, dass dies proaktiv geschieht, können Sie auch eine explizite Zeile
in Ihren Heartbeat-Prompt aufnehmen, etwa: „Wenn die Checkliste veraltet ist,
aktualisiere HEARTBEAT.md mit einer besseren.“

Sicherheitshinweis: Legen Sie keine Geheimnisse (API-Schlüssel, Telefonnummern,
private Tokens) in `HEARTBEAT.md` ab — es wird Teil des Prompt-Kontexts.

## Manueller Weckruf (on-demand)

Sie können ein Systemereignis in die Warteschlange stellen und einen sofortigen
Heartbeat auslösen mit:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Wenn mehrere Agenten `heartbeat` konfiguriert haben, führt ein manueller Weckruf
jede dieser Agenten-Heartbeats sofort aus.

Verwenden Sie `--mode next-heartbeat`, um auf den nächsten geplanten Tick zu warten.

## Auslieferung der Begründung (optional)

Standardmäßig liefern Heartbeats nur die finale „Antwort“-Nutzlast aus.

Wenn Sie Transparenz wünschen, aktivieren Sie:

- `agents.defaults.heartbeat.includeReasoning: true`

Wenn aktiviert, liefern Heartbeats zusätzlich eine separate Nachricht mit dem Präfix
`Reasoning:` (gleiche Form wie `/reasoning on`). Das kann nützlich sein, wenn der
Agent mehrere Sitzungen/Codizes verwaltet und Sie sehen möchten, warum er sich
entschieden hat, Sie anzupingen — kann aber auch mehr interne Details preisgeben,
als Ihnen lieb ist. Bevorzugen Sie, dies in Gruppenchats deaktiviert zu lassen.

## Kostenbewusstsein

Heartbeats führen vollständige Agent-Turns aus. Kürzere Intervalle verbrauchen mehr
Tokens. Halten Sie `HEARTBEAT.md` klein und erwägen Sie ein günstigeres
`model` oder `target: "none"`, wenn Sie nur interne Zustandsaktualisierungen wünschen.
