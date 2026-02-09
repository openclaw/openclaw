---
summary: "„Routing-Regeln pro Kanal (WhatsApp, Telegram, Discord, Slack) und geteilter Kontext“"
read_when:
  - Beim Ändern des Kanal-Routings oder des Inbox-Verhaltens
title: "channels/channel-routing.md"
---

# Kanäle & Routing

OpenClaw leitet Antworten **zurück an den Kanal, aus dem eine Nachricht stammt**. Das
Modell wählt keinen Kanal; das Routing ist deterministisch und wird durch die
Host-Konfiguration gesteuert.

## Schlüsselbegriffe

- **Kanal**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: kanal­spezifische Account-Instanz (sofern unterstützt).
- **AgentId**: ein isolierter Workspace + Sitzungsspeicher („Gehirn“).
- **SessionKey**: der Bucket-Schlüssel zum Speichern von Kontext und zur Steuerung der Parallelität.

## Formen von Sitzungsschlüsseln (Beispiele)

Direktnachrichten werden in die **Haupt**-Sitzung des Agenten zusammengeführt:

- `agent:<agentId>:<mainKey>` (Standard: `agent:main:main`)

Gruppen und Kanäle bleiben pro Kanal isoliert:

- Gruppen: `agent:<agentId>:<channel>:group:<id>`
- Kanäle/Räume: `agent:<agentId>:<channel>:channel:<id>`

Threads:

- Slack-/Discord-Threads hängen `:thread:<threadId>` an den Basisschlüssel an.
- Telegram-Forum-Themen betten `:topic:<topicId>` in den Gruppenschlüssel ein.

Beispiele:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Routing-Regeln (wie ein Agent ausgewählt wird)

Das Routing wählt **einen Agenten** für jede eingehende Nachricht:

1. **Exakte Peer-Übereinstimmung** (`bindings` mit `peer.kind` + `peer.id`).
2. **Guild-Übereinstimmung** (Discord) über `guildId`.
3. **Team-Übereinstimmung** (Slack) über `teamId`.
4. **Account-Übereinstimmung** (`accountId` auf dem Kanal).
5. **Kanal-Übereinstimmung** (beliebiger Account auf diesem Kanal).
6. **Standard-Agent** (`agents.list[].default`, andernfalls erster Listeneintrag, Fallback auf `main`).

Der gefundene Agent bestimmt, welcher Workspace und welcher Sitzungsspeicher verwendet werden.

## Broadcast-Gruppen (mehrere Agenten ausführen)

Broadcast-Gruppen ermöglichen es Ihnen, **mehrere Agenten** für denselben Peer auszuführen,
**wenn OpenClaw normalerweise antworten würde** (z. B. in WhatsApp-Gruppen nach Erwähnungs‑/Aktivierungs-Gating).

Konfiguration:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Siehe: [Broadcast Groups](/channels/broadcast-groups).

## Konfigurationsübersicht

- `agents.list`: benannte Agentendefinitionen (Workspace, Modell usw.).
- `bindings`: Zuordnung eingehender Kanäle/Accounts/Peers zu Agenten.

Beispiel:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## Sitzungsspeicher

Sitzungsspeicher liegen unterhalb des State-Verzeichnisses (Standard `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL-Transkripte liegen neben dem Store

Sie können den Store-Pfad über `session.store` und `{agentId}`-Templating überschreiben.

## WebChat-Verhalten

WebChat bindet sich an den **ausgewählten Agenten** und verwendet standardmäßig die
Hauptsitzung des Agenten. Dadurch ermöglicht WebChat, kanalübergreifenden Kontext
für diesen Agenten an einem Ort einzusehen.

## Antwortkontext

Eingehende Antworten enthalten:

- `ReplyToId`, `ReplyToBody` und `ReplyToSender`, sofern verfügbar.
- Zitierter Kontext wird als `[Replying to ...]`-Block an `Body` angehängt.

Dies ist über alle Kanäle hinweg konsistent.
