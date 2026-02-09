---
summary: "Интеграция с Telegram Bot API через grammY с примечаниями по настройке"
read_when:
  - При работе с Telegram или путями grammY
title: grammY
---

# Интеграция grammY (Telegram Bot API)

# Зачем grammY

- TS‑first клиент Bot API со встроенной поддержкой long‑poll и webhook, middleware, обработкой ошибок и ограничителем частоты.
- Более чистые помощники для работы с медиа по сравнению с ручной реализацией fetch + FormData; поддерживает все методы Bot API.
- Расширяемость: поддержка прокси через пользовательский fetch, middleware сессий (необязательно), типобезопасный контекст.

# Что мы реализовали

- **Единый путь клиента:** реализация на базе fetch удалена; grammY теперь является единственным Telegram‑клиентом (отправка + Gateway (шлюз)) с включённым по умолчанию ограничителем grammY.
- **Gateway (шлюз):** `monitorTelegramProvider` создаёт grammY `Bot`, настраивает проверку упоминаний/списка разрешённых, загрузку медиа через `getFile`/`download` и доставляет ответы с помощью `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Поддерживает long‑poll или webhook через `webhookCallback`.
- **Прокси:** необязательный `channels.telegram.proxy` использует `undici.ProxyAgent` через `client.baseFetch` grammY.
- **Поддержка webhook:** `webhook-set.ts` оборачивает `setWebhook/deleteWebhook`; `webhook.ts` размещает callback с проверкой здоровья и корректным завершением работы. Gateway (шлюз) включает режим webhook, когда заданы `channels.telegram.webhookUrl` и `channels.telegram.webhookSecret` (в противном случае используется long‑poll).
- **Сессии:** личные чаты схлопываются в основную сессию агента (`agent:<agentId>:<mainKey>`); группы используют `agent:<agentId>:telegram:group:<chatId>`; ответы маршрутизируются обратно в тот же канал.
- **Параметры конфига:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (значения по умолчанию для списка разрешённых и упоминаний), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Потоковая передача черновиков:** необязательный `channels.telegram.streamMode` использует `sendMessageDraft` в приватных тематических чатах (Bot API 9.3+). Это отдельно от потоковой передачи блоками для каналов.
- **Тесты:** моки grammY покрывают проверку упоминаний в личных сообщениях и группах, а также исходящую отправку; дополнительные фикстуры для медиа/webhook приветствуются.

Открытые вопросы

- Необязательные плагины grammY (throttler), если мы столкнёмся с ошибками Bot API 429.
- Добавить более структурированные тесты медиа (стикеры, голосовые заметки).
- Сделать порт прослушивания webhook настраиваемым (в настоящее время фиксирован на 8787, если не прокинут через Gateway (шлюз)).
