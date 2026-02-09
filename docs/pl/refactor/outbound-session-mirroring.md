---
title: "Refaktoryzacja lustrzanego odwzorowania sesji wychodzących (Issue #1520)" #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Refaktoryzacja lustrzanego odwzorowania sesji wychodzących (Issue #1520)

## Status

- W toku.
- Zaktualizowano routowanie kanałów core + wtyczek dla lustrzanego odwzorowania wychodzącego.
- Wysyłanie przez Gateway teraz wyprowadza docelową sesję, gdy pominięto sessionKey.

## Kontekst

Wysyłki wychodzące były lustrzanie odwzorowywane do _bieżącej_ sesji agenta (klucz sesji narzędzia), zamiast do docelowej sesji kanału. Routowanie przychodzące używa kluczy sesji kanału/peera, więc odpowiedzi wychodzące trafiały do niewłaściwej sesji, a cele pierwszego kontaktu często nie miały wpisów sesji.

## Cele

- Lustrzanie odwzorowywać wiadomości wychodzące do klucza sesji docelowego kanału.
- Tworzyć wpisy sesji przy wysyłkach wychodzących, gdy ich brakuje.
- Zachować zakres wątków/tematów spójny z kluczami sesji przychodzących.
- Objąć kanały core oraz dołączone rozszerzenia.

## Podsumowanie implementacji

- Nowy pomocnik routowania sesji wychodzących:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` buduje docelowy sessionKey przy użyciu `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` zapisuje minimalny `MsgContext` przez `recordSessionMetaFromInbound`.
- `runMessageAction` (send) wyprowadza docelowy sessionKey i przekazuje go do `executeSendAction` w celu lustrzanego odwzorowania.
- `message-tool` nie wykonuje już bezpośredniego lustrzanego odwzorowania; jedynie rozwiązuje agentId z bieżącego klucza sesji.
- Ścieżka wysyłania wtyczek wykonuje lustrzane odwzorowanie przez `appendAssistantMessageToSessionTranscript` z użyciem wyprowadzonego sessionKey.
- Wysyłanie przez Gateway wyprowadza docelowy klucz sesji, gdy nie został podany (domyślny agent), i zapewnia utworzenie wpisu sesji.

## Obsługa wątków/tematów

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (sufiks).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` z `useSuffix=false` w celu dopasowania do przychodzących (identyfikator kanału wątku już zakresuje sesję).
- Telegram: identyfikatory tematów mapowane do `chatId:topic:<id>` przez `buildTelegramGroupPeerId`.

## Obsługiwane rozszerzenia

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Uwagi:
  - Cele Mattermost teraz usuwają `@` dla routowania klucza sesji DM.
  - Zalo Personal używa rodzaju peera DM dla celów 1:1 (grupa tylko wtedy, gdy obecne jest `group:`).
  - Cele grupowe BlueBubbles usuwają prefiksy `chat_*`, aby dopasować klucze sesji przychodzących.
  - Automatyczne lustrzane odwzorowanie wątków Slack dopasowuje identyfikatory kanałów bez rozróżniania wielkości liter.
  - Wysyłanie przez Gateway zamienia podane klucze sesji na małe litery przed lustrzanym odwzorowaniem.

## Decyzje

- **Wyprowadzanie sesji przy wysyłaniu przez Gateway**: jeśli podano `sessionKey`, użyj go. Jeśli pominięto, wyprowadź sessionKey z celu + domyślnego agenta i wykonaj lustrzane odwzorowanie tam.
- **Tworzenie wpisu sesji**: zawsze używaj `recordSessionMetaFromInbound` z `Provider/From/To/ChatType/AccountId/Originating*` dopasowanymi do formatów przychodzących.
- **Normalizacja celu**: routowanie wychodzące używa rozwiązywanych celów (po `resolveChannelTarget`), gdy są dostępne.
- **Wielkość liter klucza sesji**: kanonizuj klucze sesji do małych liter przy zapisie i podczas migracji.

## Dodane/Zaktualizowane testy

- `src/infra/outbound/outbound-session.test.ts`
  - Klucz sesji wątku Slack.
  - Klucz sesji tematu Telegram.
  - identityLinks dmScope z Discord.
- `src/agents/tools/message-tool.test.ts`
  - Wyprowadza agentId z klucza sesji (bez przekazywania sessionKey).
- `src/gateway/server-methods/send.test.ts`
  - Wyprowadza klucz sesji, gdy jest pominięty, i tworzy wpis sesji.

## Otwarte elementy / Dalsze kroki

- Wtyczka połączeń głosowych używa niestandardowych kluczy sesji `voice:<phone>`. Mapowanie wychodzące nie jest tu ustandaryzowane; jeśli narzędzie wiadomości ma wspierać wysyłki połączeń głosowych, należy dodać jawne mapowanie.
- Potwierdzić, czy jakakolwiek zewnętrzna wtyczka używa niestandardowych formatów `From/To` poza dołączonym zestawem.

## Zmienione pliki

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Testy w:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
