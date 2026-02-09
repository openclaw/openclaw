---
title: "Рефакторинг зеркалирования исходящих сессий (Issue #1520)" #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# Рефакторинг зеркалирования исходящих сессий (Issue #1520)

## Статус

- В процессе.
- Маршрутизация каналов core + плагинов обновлена для исходящего зеркалирования.
- Отправка через Gateway теперь выводит целевую сессию, когда sessionKey не указан.

## Контекст

Исходящие отправки зеркалировались в _текущую_ сессию агента (ключ сессии инструмента), а не в сессию целевого канала. Входящая маршрутизация использует ключи сессий каналов/пиров, поэтому исходящие ответы попадали не в ту сессию, а у целей первого контакта часто отсутствовали записи сессий.

## Цели

- Зеркалировать исходящие сообщения в ключ сессии целевого канала.
- Создавать записи сессий при исходящих отправках, если они отсутствуют.
- Сохранять согласованность области потоков/тем с ключами входящих сессий.
- Покрыть основные каналы и расширения из комплекта.

## Краткое описание реализации

- Новый помощник маршрутизации исходящих сессий:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` формирует целевой sessionKey с использованием `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` записывает минимальный `MsgContext` через `recordSessionMetaFromInbound`.
- `runMessageAction` (send) выводит целевой sessionKey и передаёт его в `executeSendAction` для зеркалирования.
- `message-tool` больше не зеркалирует напрямую; он только определяет agentId из ключа текущей сессии.
- Путь отправки плагинов зеркалирует через `appendAssistantMessageToSessionTranscript` с использованием выведенного sessionKey.
- Отправка через Gateway выводит целевой ключ сессии, если он не предоставлен (агент по умолчанию), и гарантирует наличие записи сессии.

## Обработка тем

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (суффикс).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` с `useSuffix=false` для соответствия входящим (id канала потока уже ограничивает сессию).
- Telegram: идентификаторы тем сопоставляются с `chatId:topic:<id>` через `buildTelegramGroupPeerId`.

## Покрытые расширения

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Примечания:
  - У целей Mattermost теперь удаляется `@` для маршрутизации ключа DM-сессии.
  - Zalo Personal использует тип пира DM для целей 1:1 (группа — только при наличии `group:`).
  - Для групповых целей BlueBubbles удаляются префиксы `chat_*`, чтобы соответствовать входящим ключам сессий.
  - Автозеркалирование потоков Slack сопоставляет id каналов без учёта регистра.
  - Отправка через Gateway приводит предоставленные ключи сессий к нижнему регистру перед зеркалированием.

## Решения

- **Вывод сессии при отправке через Gateway**: если предоставлен `sessionKey`, использовать его. Если опущен — вывести sessionKey из цели + агента по умолчанию и зеркалировать туда.
- **Создание записи сессии**: всегда использовать `recordSessionMetaFromInbound` с `Provider/From/To/ChatType/AccountId/Originating*`, согласованным с форматами входящих.
- **Нормализация целей**: исходящая маршрутизация использует разрешённые цели (после `resolveChannelTarget`), когда они доступны.
- **Регистр ключей сессий**: канонизировать ключи сессий к нижнему регистру при записи и во время миграций.

## Добавленные/обновлённые тесты

- `src/infra/outbound/outbound-session.test.ts`
  - Ключ сессии потока Slack.
  - Ключ сессии темы Telegram.
  - dmScope identityLinks с Discord.
- `src/agents/tools/message-tool.test.ts`
  - Определяет agentId из ключа сессии (без передачи sessionKey).
- `src/gateway/server-methods/send.test.ts`
  - Выводит ключ сессии, когда он опущен, и создаёт запись сессии.

## Открытые вопросы / последующие шаги

- Плагин голосовых вызовов использует пользовательские ключи сессий `voice:<phone>`. Исходящее сопоставление здесь не стандартизировано; если инструмент сообщений должен поддерживать отправки для голосовых вызовов, добавить явное сопоставление.
- Подтвердить, использует ли какой-либо внешний плагин нестандартные форматы `From/To` помимо набора из комплекта.

## Затронутые файлы

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Тесты в:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
