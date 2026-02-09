---
summary: "Настройка, конфигурация и использование плагина LINE Messaging API"
read_when:
  - Вы хотите подключить OpenClaw к LINE
  - Вам нужна настройка вебхука и учётных данных LINE
  - Вам нужны специфичные для LINE параметры сообщений
title: LINE
---

# LINE (плагин)

LINE подключается к OpenClaw через LINE Messaging API. Плагин работает как получатель
вебхуков на Gateway (шлюз) и использует ваш токен доступа канала и секрет канала для
аутентификации.

Статус: поддерживается через плагин. Поддерживаются личные сообщения, групповые чаты,
медиа, локации, Flex‑сообщения, шаблонные сообщения и быстрые ответы. Реакции и
треды не поддерживаются.

## Требуется плагин

Установите плагин LINE:

```bash
openclaw plugins install @openclaw/line
```

Локальная установка (при запуске из git‑репозитория):

```bash
openclaw plugins install ./extensions/line
```

## Настройка

1. Создайте аккаунт LINE Developers и откройте консоль:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Создайте (или выберите) Provider и добавьте канал **Messaging API**.
3. Скопируйте **Channel access token** и **Channel secret** из настроек канала.
4. Включите **Use webhook** в настройках Messaging API.
5. Установите URL вебхука на эндпоинт вашего Gateway (шлюз) (требуется HTTPS):

```
https://gateway-host/line/webhook
```

Gateway (шлюз) отвечает на проверку вебхука LINE (GET) и входящие события (POST).
Если нужен пользовательский путь, задайте `channels.line.webhookPath` или
`channels.line.accounts.<id>.webhookPath` и соответствующим образом обновите URL.

## Конфигурация

Минимальный конфиг:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Переменные окружения (только для аккаунта по умолчанию):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Файлы токена/секрета:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Несколько аккаунтов:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Контроль доступа

Личные сообщения по умолчанию требуют сопряжения. Неизвестные отправители получают
код сопряжения, а их сообщения игнорируются до одобрения.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Списки разрешённых и политики:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: разрешённые LINE user ID для личных сообщений
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: разрешённые LINE user ID для групп
- Переопределения для отдельных групп: `channels.line.groups.<groupId>.allowFrom`

ID LINE чувствительны к регистру. Корректные ID выглядят так:

- Пользователь: `U` + 32 шестнадцатеричных символа
- Группа: `C` + 32 шестнадцатеричных символа
- Комната: `R` + 32 шестнадцатеричных символа

## Поведение сообщений

- Текст разбивается на фрагменты по 5000 символов.
- Форматирование Markdown удаляется; блоки кода и таблицы по возможности
  преобразуются в Flex‑карточки.
- Потоковые ответы буферизуются; LINE получает полные фрагменты с анимацией
  загрузки, пока агент работает.
- Загрузка медиа ограничена значением `channels.line.mediaMaxMb` (по умолчанию 10).

## Данные канала (богатые сообщения)

Используйте `channelData.line` для отправки быстрых ответов, локаций, Flex‑карточек
или шаблонных сообщений.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

Плагин LINE также включает команду `/card` для пресетов Flex‑сообщений:

```
/card info "Welcome" "Thanks for joining!"
```

## Устранение неполадок

- **Сбой проверки вебхука:** убедитесь, что URL вебхука использует HTTPS и
  `channelSecret` совпадает с данными в консоли LINE.
- **Нет входящих событий:** проверьте, что путь вебхука соответствует
  `channels.line.webhookPath` и что Gateway (шлюз) доступен из LINE.
- **Ошибки загрузки медиа:** увеличьте `channels.line.mediaMaxMb`, если размер медиа
  превышает ограничение по умолчанию.
