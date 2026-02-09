---
title: refactor/outbound-session-mirroring.md #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Refaktorierung der ausgehenden Sitzungs-Spiegelung (Issue #1520)

## Status

- In Bearbeitung.
- Core- und Plugin-Kanal-Routing für ausgehende Spiegelung aktualisiert.
- Gateway-Senden leitet nun die Ziel-Sitzung ab, wenn `sessionKey` ausgelassen wird.

## Kontext

Ausgehende Sendungen wurden in die _aktuelle_ Agenten-Sitzung (Werkzeug-Sitzungsschlüssel) gespiegelt, statt in die Ziel-Kanal-Sitzung. Das eingehende Routing verwendet Kanal-/Peer-Sitzungsschlüssel; dadurch landeten ausgehende Antworten in der falschen Sitzung, und Erstkontakt-Ziele hatten häufig keine Sitzungseinträge.

## Ziele

- Ausgehende Nachrichten in den Sitzungsschlüssel des Ziel-Kanals spiegeln.
- Sitzungseinträge bei ausgehenden Sendungen erstellen, wenn sie fehlen.
- Thread-/Themen-Scoping mit den eingehenden Sitzungsschlüsseln ausrichten.
- Kernkanäle sowie gebündelte Erweiterungen abdecken.

## Implementierungsübersicht

- Neuer Helper für ausgehendes Sitzungs-Routing:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` erstellt den Ziel-`sessionKey` mit `buildAgentSessionKey` (`dmScope` + `identityLinks`).
  - `ensureOutboundSessionEntry` schreibt minimale `MsgContext` über `recordSessionMetaFromInbound`.
- `runMessageAction` (send) leitet den Ziel-`sessionKey` ab und übergibt ihn an `executeSendAction` zum Spiegeln.
- `message-tool` spiegelt nicht mehr direkt; es löst nur `agentId` aus dem aktuellen Sitzungsschlüssel auf.
- Der Plugin-Sendepfad spiegelt über `appendAssistantMessageToSessionTranscript` unter Verwendung des abgeleiteten `sessionKey`.
- Gateway-Senden leitet einen Ziel-Sitzungsschlüssel ab, wenn keiner bereitgestellt wird (Standard-Agent), und stellt einen Sitzungseintrag sicher.

## Thread-/Themenbehandlung

- Slack: `replyTo`/`threadId` -> `resolveThreadSessionKeys` (Suffix).
- Discord: `threadId`/`replyTo` -> `resolveThreadSessionKeys` mit `useSuffix=false`, um eingehend übereinzustimmen (Thread-Kanal-ID grenzt die Sitzung bereits ab).
- Telegram: Themen-IDs werden über `buildTelegramGroupPeerId` auf `chatId:topic:<id>` abgebildet.

## Abgedeckte Erweiterungen

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Hinweise:
  - Mattermost Targets entfernen nun `@` für DM Session-Schlüsselrouting.
  - Zalo Personal verwendet den DM-Peer-Typ für 1:1-Ziele (Gruppe nur, wenn `group:` vorhanden ist).
  - BlueBubbles-Gruppenziele entfernen `chat_*`-Präfixe, um eingehenden Sitzungsschlüsseln zu entsprechen.
  - Slack Auto-Thread-Spiegelung gleicht Kanal-IDs ohne Beachtung der Groß-/Kleinschreibung ab.
  - Gateway-Senden wandelt bereitgestellte Sitzungsschlüssel vor dem Spiegeln in Kleinbuchstaben um.

## Entscheidungen

- **Ableitung des Sitzungsschlüssels beim Gateway-Senden**: Wenn `sessionKey` bereitgestellt wird, wird dieser verwendet. Wenn ausgelassen, wird ein `sessionKey` aus Ziel + Standard-Agent abgeleitet und dorthin gespiegelt.
- **Erstellung von Sitzungseinträgen**: Immer `recordSessionMetaFromInbound` mit `Provider/From/To/ChatType/AccountId/Originating*` verwenden, ausgerichtet an eingehenden Formaten.
- **Ziel-Normalisierung**: Das ausgehende Routing verwendet aufgelöste Ziele (nach `resolveChannelTarget`), sofern verfügbar.
- **Schreibweise von Sitzungsschlüsseln**: Sitzungsschlüssel beim Schreiben und während Migrationen kanonisch in Kleinbuchstaben umwandeln.

## Hinzugefügte/Aktualisierte Tests

- `src/infra/outbound/outbound-session.test.ts`
  - Slack-Thread-Sitzungsschlüssel.
  - Telegram-Themen-Sitzungsschlüssel.
  - `dmScope`-`identityLinks` mit Discord.
- `src/agents/tools/message-tool.test.ts`
  - Leitet `agentId` aus dem Sitzungsschlüssel ab (kein `sessionKey` wird durchgereicht).
- `src/gateway/server-methods/send.test.ts`
  - Leitet den Sitzungsschlüssel ab, wenn er ausgelassen wird, und erstellt einen Sitzungseintrag.

## Offene Punkte / Follow-ups

- Das Voice-Call-Plugin verwendet benutzerdefinierte `voice:<phone>`-Sitzungsschlüssel. Die ausgehende Zuordnung ist hier nicht standardisiert; falls das Message-Tool Voice-Call-Sendungen unterstützen soll, fügen Sie eine explizite Zuordnung hinzu.
- Bestätigen Sie, ob ein externes Plugin nicht-standardisierte `From/To`-Formate jenseits des gebündelten Sets verwendet.

## Geänderte Dateien

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Tests in:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
