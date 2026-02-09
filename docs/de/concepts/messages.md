---
summary: "Nachrichtenfluss, Sitzungen, Warteschlangen und Sichtbarkeit der Begründung"
read_when:
  - Erklären, wie eingehende Nachrichten zu Antworten werden
  - Klärung von Sitzungen, Warteschlangenmodi oder Streaming-Verhalten
  - Dokumentation der Sichtbarkeit der Begründung und der Nutzungsauswirkungen
title: "Nachrichten"
---

# Nachrichten

Diese Seite verbindet, wie OpenClaw eingehende Nachrichten, Sitzungen, Warteschlangen,
Streaming und die Sichtbarkeit der Begründung handhabt.

## Nachrichtenfluss (auf hoher Ebene)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Zentrale Stellschrauben befinden sich in der Konfiguration:

- `messages.*` für Präfixe, Warteschlangen und Gruppenverhalten.
- `agents.defaults.*` für Block-Streaming und Chunking-Standards.
- Kanalüberschreibungen (`channels.whatsapp.*`, `channels.telegram.*` usw.) für Limits und Streaming-Umschalter.

Siehe [Konfiguration](/gateway/configuration) für das vollständige Schema.

## Eingehende Deduplizierung

Kanäle können nach Wiederverbindungen dieselbe Nachricht erneut zustellen. OpenClaw hält einen
kurzlebigen Cache, der nach Kanal/Konto/Peer/Sitzung/Nachrichten-ID indiziert ist, sodass doppelte
Zustellungen keinen weiteren Agentenlauf auslösen.

## Eingehendes Debouncing

Schnell aufeinanderfolgende Nachrichten vom **gleichen Absender** können über `messages.inbound` zu
einem einzelnen Agenten-Zug gebündelt werden. Debouncing ist pro Kanal + Unterhaltung begrenzt
und verwendet die zuletzt eingegangene Nachricht für Antwort-Threading/IDs.

Konfiguration (globaler Standard + kanalweise Überschreibungen):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Hinweise:

- Debouncing gilt für **reine Text**-Nachrichten; Medien/Anhänge werden sofort weitergereicht.
- Steuerbefehle umgehen das Debouncing, sodass sie eigenständig bleiben.

## Sitzungen und Geräte

Sitzungen gehören dem Gateway, nicht den Clients.

- Direktchats werden auf den Hauptsitzungsschlüssel des Agenten zusammengeführt.
- Gruppen/Kanäle erhalten eigene Sitzungsschlüssel.
- Der Sitzungsspeicher und die Transkripte liegen auf dem Gateway-Host.

Mehrere Geräte/Kanäle können derselben Sitzung zugeordnet sein, aber der Verlauf wird nicht
vollständig an jeden Client zurücksynchronisiert. Empfehlung: Verwenden Sie für lange
Unterhaltungen ein primäres Gerät, um divergierenden Kontext zu vermeiden. Die Control UI und
die TUI zeigen stets das Gateway-gestützte Sitzungstranskript an und sind damit die
maßgebliche Quelle.

Details: [Sitzungsverwaltung](/concepts/session).

## Eingehende Körper und Verlaufskontext

OpenClaw trennt den **Prompt-Body** vom **Command-Body**:

- `Body`: Prompt-Text, der an den Agenten gesendet wird. Dies kann Kanalumschläge und
  optionale Verlaufs-Wrapper enthalten.
- `CommandBody`: Roher Benutzertext für die Direktiven-/Befehlsanalyse.
- `RawBody`: Legacy-Alias für `CommandBody` (aus Kompatibilitätsgründen beibehalten).

Wenn ein Kanal Verlauf liefert, verwendet er einen gemeinsamen Wrapper:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Bei **Nicht-Direktchats** (Gruppen/Kanäle/Räume) wird der **aktuelle Nachrichteninhalt** mit dem
Absenderlabel vorangestellt (derselbe Stil wie bei Verlaufseinträgen). Dadurch bleiben Echtzeit-
und warteschlangen-/verlaufsbasierte Nachrichten im Agenten-Prompt konsistent.

Verlaufspuffer sind **nur ausstehend**: Sie enthalten Gruppennachrichten, die _keinen_ Lauf
ausgelöst haben (z. B. erwähnungsbasierte Nachrichten), und **schließen** Nachrichten aus,
die bereits im Sitzungstranskript enthalten sind.

Das Entfernen von Direktiven gilt nur für den Abschnitt der **aktuellen Nachricht**, sodass der
Verlauf intakt bleibt. Kanäle, die Verlauf einbetten, sollten `CommandBody` (oder
`RawBody`) auf den ursprünglichen Nachrichtentext setzen und `Body` als
kombinierten Prompt beibehalten.
Verlaufspuffer sind über `messages.groupChat.historyLimit` (globaler
Standard) und kanalweise Überschreibungen wie `channels.slack.historyLimit` oder
`channels.telegram.accounts.<id>.historyLimit` konfigurierbar (zum Deaktivieren `0` setzen).

## Warteschlangen und Follow-ups

Wenn bereits ein Lauf aktiv ist, können eingehende Nachrichten in eine Warteschlange gestellt,
in den aktuellen Lauf gelenkt oder für einen Folgezug gesammelt werden.

- Konfiguration über `messages.queue` (und `messages.queue.byChannel`).
- Modi: `interrupt`, `steer`, `followup`, `collect`, plus Backlog-Varianten.

Details: [Warteschlangen](/concepts/queue).

## Streaming, Chunking und Batching

Block-Streaming sendet Teilantworten, während das Modell Textblöcke erzeugt.
Chunking berücksichtigt Textlimits der Kanäle und vermeidet das Aufteilen von umschlossenen Codeblöcken.

Zentrale Einstellungen:

- `agents.defaults.blockStreamingDefault` (`on|off`, standardmäßig aus)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (leerlaufbasiertes Batching)
- `agents.defaults.humanDelay` (menschenähnliche Pause zwischen Blockantworten)
- Kanalüberschreibungen: `*.blockStreaming` und `*.blockStreamingCoalesce` (Nicht-Telegram-Kanäle erfordern ein explizites `*.blockStreaming: true`)

Details: [Streaming + Chunking](/concepts/streaming).

## Sichtbarkeit der Begründung und Token

OpenClaw kann die Modellbegründung ein- oder ausblenden:

- `/reasoning on|off|stream` steuert die Sichtbarkeit.
- Begründungsinhalte zählen weiterhin zum Tokenverbrauch, wenn sie vom Modell erzeugt werden.
- Telegram unterstützt das Streaming der Begründung in die Entwurfsblase.

Details: [Thinking + Reasoning-Direktiven](/tools/thinking) und [Token-Nutzung](/reference/token-use).

## Präfixe, Threading und Antworten

Die Formatierung ausgehender Nachrichten ist zentralisiert in `messages`:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` und `channels.<channel>.accounts.<id>.responsePrefix` (Kaskade ausgehender Präfixe) sowie `channels.whatsapp.messagePrefix` (WhatsApp-Eingangspräfix)
- Antwort-Threading über `replyToMode` und kanalweise Standards

Details: [Konfiguration](/gateway/configuration#messages) und die Kanaldokumentation.
