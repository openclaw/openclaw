---
summary: "„Slash-Befehle: Text vs. nativ, Konfiguration und unterstützte Befehle“"
read_when:
  - Beim Verwenden oder Konfigurieren von Chat-Befehlen
  - Beim Debuggen von Befehlsrouting oder Berechtigungen
title: "Slash-Befehle"
---

# tools/slash-commands.md

Befehle werden vom Gateway verarbeitet. Die meisten Befehle müssen als **eigenständige** Nachricht gesendet werden, die mit `/` beginnt.
Der nur für den Host verfügbare Bash-Chat-Befehl verwendet `! <cmd>` (mit `/bash <cmd>` als Alias).

Es gibt zwei verwandte Systeme:

- **Befehle**: eigenständige `/...`-Nachrichten.
- **Direktiven**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Direktiven werden aus der Nachricht entfernt, bevor das Modell sie sieht.
  - In normalen Chat-Nachrichten (nicht nur Direktiven) werden sie als „Inline-Hinweise“ behandelt und **persistieren** keine Sitzungseinstellungen.
  - In Nachrichten, die nur aus Direktiven bestehen (die Nachricht enthält ausschließlich Direktiven), persistieren sie in der Sitzung und antworten mit einer Bestätigung.
  - Direktiven werden nur für **autorisierte Absender** angewendet (Kanal-Allowlists/Pairing plus `commands.useAccessGroups`).
    Nicht autorisierte Absender sehen Direktiven als normalen Text.

Es gibt außerdem einige **Inline-Shortcuts** (nur für allowlistete/autorisierte Absender): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Sie werden sofort ausgeführt, vor dem Modell aus der Nachricht entfernt, und der verbleibende Text durchläuft den normalen Ablauf.

## Konfiguration

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (Standard `true`) aktiviert das Parsen von `/...` in Chat-Nachrichten.
  - Auf Oberflächen ohne native Befehle (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams) funktionieren Textbefehle weiterhin, selbst wenn Sie dies auf `false` setzen.
- `commands.native` (Standard `"auto"`) registriert native Befehle.
  - Auto: an für Discord/Telegram; aus für Slack (bis Sie Slash-Befehle hinzufügen); ignoriert für Anbieter ohne native Unterstützung.
  - Setzen Sie `channels.discord.commands.native`, `channels.telegram.commands.native` oder `channels.slack.commands.native`, um pro Anbieter zu überschreiben (bool oder `"auto"`).
  - `false` löscht zuvor registrierte Befehle auf Discord/Telegram beim Start. Slack-Befehle werden in der Slack-App verwaltet und nicht automatisch entfernt.
- `commands.nativeSkills` (Standard `"auto"`) registriert **Skill**-Befehle nativ, wenn unterstützt.
  - Auto: an für Discord/Telegram; aus für Slack (Slack erfordert das Erstellen eines Slash-Befehls pro Skill).
  - Setzen Sie `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` oder `channels.slack.commands.nativeSkills`, um pro Anbieter zu überschreiben (bool oder `"auto"`).
- `commands.bash` (Standard `false`) aktiviert `! <cmd>` zum Ausführen von Host-Shell-Befehlen (`/bash <cmd>` ist ein Alias; erfordert `tools.elevated`-Allowlists).
- `commands.bashForegroundMs` (Standard `2000`) steuert, wie lange Bash wartet, bevor in den Hintergrundmodus gewechselt wird (`0` geht sofort in den Hintergrund).
- `commands.config` (Standard `false`) aktiviert `/config` (liest/schreibt `openclaw.json`).
- `commands.debug` (Standard `false`) aktiviert `/debug` (nur Laufzeit-Overrides).
- `commands.useAccessGroups` (Standard `true`) erzwingt Allowlists/Richtlinien für Befehle.

## Befehlsliste

Text + nativ (wenn aktiviert):

- `/help`
- `/commands`
- `/skill <name> [input]` (führt einen Skill nach Namen aus)
- `/status` (zeigt den aktuellen Status; enthält bei Verfügbarkeit die Anbieter-Nutzung/Quote für den aktuellen Modellanbieter)
- `/allowlist` (Allowlist-Einträge auflisten/hinzufügen/entfernen)
- `/approve <id> allow-once|allow-always|deny` (Exec-Genehmigungsabfragen auflösen)
- `/context [list|detail|json]` (erklärt „Kontext“; `detail` zeigt Größe pro Datei + pro Werkzeug + pro Skill + System-Prompt)
- `/whoami` (zeigt Ihre Absender-ID; Alias: `/id`)
- `/subagents list|stop|log|info|send` (Untersuchen, stoppen, protokollieren oder Nachrichten an Sub-Agent-Läufe für die aktuelle Sitzung senden)
- `/config show|get|set|unset` (Konfiguration auf Datenträger persistieren, nur Eigentümer; erfordert `commands.config: true`)
- `/debug show|set|unset|reset` (Laufzeit-Overrides, nur Eigentümer; erfordert `commands.debug: true`)
- `/usage off|tokens|full|cost` (Nutzungs-Fußzeile pro Antwort oder lokale Kostenübersicht)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (TTS steuern; siehe [/tts](/tts))
  - Discord: nativer Befehl ist `/voice` (Discord reserviert `/tts`); Text `/tts` funktioniert weiterhin.
- `/stop`
- `/restart`
- `/dock-telegram` (Alias: `/dock_telegram`) (Antworten zu Telegram wechseln)
- `/dock-discord` (Alias: `/dock_discord`) (Antworten zu Discord wechseln)
- `/dock-slack` (Alias: `/dock_slack`) (Antworten zu Slack wechseln)
- `/activation mention|always` (nur Gruppen)
- `/send on|off|inherit` (nur Eigentümer)
- `/reset` oder `/new [model]` (optionaler Modellhinweis; der Rest wird durchgereicht)
- `/think <off|minimal|low|medium|high|xhigh>` (dynamische Auswahl nach Modell/Anbieter; Aliase: `/thinking`, `/t`)
- `/verbose on|full|off` (Alias: `/v`)
- `/reasoning on|off|stream` (Alias: `/reason`; wenn aktiviert, wird eine separate Nachricht mit Präfix `Reasoning:` gesendet; `stream` = nur Telegram-Entwurf)
- `/elevated on|off|ask|full` (Alias: `/elev`; `full` überspringt Exec-Genehmigungen)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (senden Sie `/exec`, um den aktuellen Stand anzuzeigen)
- `/model <name>` (Alias: `/models`; oder `/<alias>` von `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus Optionen wie `debounce:2s cap:25 drop:summarize`; senden Sie `/queue`, um die aktuellen Einstellungen zu sehen)
- `/bash <command>` (nur Host; Alias für `! <command>`; erfordert `commands.bash: true` + `tools.elevated`-Allowlists)

Nur Text:

- `/compact [instructions]` (siehe [/concepts/compaction](/concepts/compaction))
- `! <command>` (nur Host; jeweils einer; verwenden Sie `!poll` + `!stop` für langlaufende Jobs)
- `!poll` (Ausgabe/Status prüfen; akzeptiert optional `sessionId`; `/bash poll` funktioniert ebenfalls)
- `!stop` (den laufenden Bash-Job stoppen; akzeptiert optional `sessionId`; `/bash stop` funktioniert ebenfalls)

Hinweise:

- Befehle akzeptieren ein optionales `:` zwischen Befehl und Argumenten (z. B. `/think: high`, `/send: on`, `/help:`).
- `/new <model>` akzeptiert einen Modell-Alias, `provider/model` oder einen Anbieternamen (unscharfe Übereinstimmung); bei keiner Übereinstimmung wird der Text als Nachrichteninhalt behandelt.
- Für eine vollständige Aufschlüsselung der Anbieternutzung verwenden Sie `openclaw status --usage`.
- `/allowlist add|remove` erfordert `commands.config=true` und beachtet die Kanal-`configWrites`.
- `/usage` steuert die Nutzungs-Fußzeile pro Antwort; `/usage cost` gibt eine lokale Kostenübersicht aus OpenClaw-Sitzungsprotokollen aus.
- `/restart` ist standardmäßig deaktiviert; setzen Sie `commands.restart: true`, um es zu aktivieren.
- `/verbose` ist für Debugging und zusätzliche Transparenz gedacht; lassen Sie es im normalen Betrieb **aus**.
- `/reasoning` (und `/verbose`) sind in Gruppeneinstellungen riskant: Sie können interne Überlegungen oder Werkzeugausgaben offenlegen, die Sie nicht beabsichtigt haben. Bevorzugen Sie, sie deaktiviert zu lassen, insbesondere in Gruppenchats.
- **Schneller Pfad:** reine Befehlsnachrichten von allowlisteten Absendern werden sofort verarbeitet (Umgehung von Warteschlange + Modell).
- **Gruppen-Erwähnungs-Gating:** reine Befehlsnachrichten von allowlisteten Absendern umgehen Erwähnungsanforderungen.
- **Inline-Shortcuts (nur allowlistete Absender):** bestimmte Befehle funktionieren auch, wenn sie in eine normale Nachricht eingebettet sind, und werden entfernt, bevor das Modell den verbleibenden Text sieht.
  - Beispiel: `hey /status` löst eine Statusantwort aus, und der verbleibende Text durchläuft den normalen Ablauf.
- Aktuell: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Nicht autorisierte reine Befehlsnachrichten werden stillschweigend ignoriert, und Inline-`/...`-Tokens werden als normaler Text behandelt.
- **Skill-Befehle:** `user-invocable` Skills werden als Slash-Befehle verfügbar gemacht. Namen werden zu `a-z0-9_` bereinigt (max. 32 Zeichen); Kollisionen erhalten numerische Suffixe (z. B. `_2`).
  - `/skill <name> [input]` führt einen Skill nach Namen aus (nützlich, wenn native Befehlslimits Befehle pro Skill verhindern).
  - Standardmäßig werden Skill-Befehle als normale Anfrage an das Modell weitergeleitet.
  - Skills können optional `command-dispatch: tool` deklarieren, um den Befehl direkt an ein Werkzeug zu routen (deterministisch, ohne Modell).
  - Beispiel: `/prose` (OpenProse-Plugin) — siehe [OpenProse](/prose).
- **Argumente nativer Befehle:** Discord verwendet Autovervollständigung für dynamische Optionen (und Button-Menüs, wenn Sie erforderliche Argumente weglassen). Telegram und Slack zeigen ein Button-Menü, wenn ein Befehl Auswahlmöglichkeiten unterstützt und Sie das Argument weglassen.

## Nutzungsoberflächen (was wo angezeigt wird)

- **Anbieter-Nutzung/Quote** (Beispiel: „Claude 80 % übrig“) wird in `/status` für den aktuellen Modellanbieter angezeigt, wenn Nutzungsverfolgung aktiviert ist.
- **Tokens/Kosten pro Antwort** werden durch `/usage off|tokens|full` gesteuert (an normale Antworten angehängt).
- `/model status` betrifft **Modelle/Auth/Endpunkte**, nicht die Nutzung.

## Modellauswahl (`/model`)

`/model` ist als Direktive implementiert.

Beispiele:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Hinweise:

- `/model` und `/model list` zeigen eine kompakte, nummerierte Auswahl (Modellfamilie + verfügbare Anbieter).
- `/model <#>` wählt aus dieser Auswahl (und bevorzugt, wenn möglich, den aktuellen Anbieter).
- `/model status` zeigt die Detailansicht, einschließlich des konfigurierten Anbieter-Endpunkts (`baseUrl`) und des API-Modus (`api`), sofern verfügbar.

## Debug-Overrides

`/debug` ermöglicht es Ihnen, **nur zur Laufzeit** Konfigurations-Overrides zu setzen (im Speicher, nicht auf Datenträger). Nur Eigentümer. Standardmäßig deaktiviert; aktivieren Sie es mit `commands.debug: true`.

Beispiele:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Hinweise:

- Overrides gelten sofort für neue Konfigurationslesevorgänge, schreiben jedoch **nicht** nach `openclaw.json`.
- Verwenden Sie `/debug reset`, um alle Overrides zu löschen und zur On-Disk-Konfiguration zurückzukehren.

## Konfigurationsaktualisierungen

`/config` schreibt in Ihre On-Disk-Konfiguration (`openclaw.json`). Nur Eigentümer. Standardmäßig deaktiviert; aktivieren Sie es mit `commands.config: true`.

Beispiele:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Hinweise:

- Die Konfiguration wird vor dem Schreiben validiert; ungültige Änderungen werden abgelehnt.
- `/config`-Aktualisierungen bleiben über Neustarts hinweg erhalten.

## Oberflächenhinweise

- **Textbefehle** laufen in der normalen Chat-Sitzung (DMs teilen sich `main`, Gruppen haben ihre eigene Sitzung).
- **Native Befehle** verwenden isolierte Sitzungen:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (Präfix konfigurierbar über `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (zielt über `CommandTargetSessionKey` auf die Chat-Sitzung)
- **`/stop`** zielt auf die aktive Chat-Sitzung, sodass der aktuelle Lauf abgebrochen werden kann.
- **Slack:** `channels.slack.slashCommand` wird weiterhin für einen einzelnen `/openclaw`-artigen Befehl unterstützt. Wenn Sie `commands.native` aktivieren, müssen Sie einen Slack-Slash-Befehl pro eingebautem Befehl erstellen (gleiche Namen wie `/help`). Befehlsargument-Menüs für Slack werden als ephemere Block-Kit-Buttons ausgeliefert.
