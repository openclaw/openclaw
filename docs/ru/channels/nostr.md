---
summary: "Канал личных сообщений Nostr через зашифрованные сообщения NIP-04"
read_when:
  - Вы хотите, чтобы OpenClaw принимал личные сообщения через Nostr
  - Вы настраиваете децентрализованный обмен сообщениями
title: "Nostr"
---

# Nostr

**Статус:** Необязательный плагин (по умолчанию отключён).

Nostr — это децентрализованный протокол для социальных сетей. Этот канал позволяет OpenClaw принимать и отвечать на зашифрованные личные сообщения (DM) через NIP-04.

## Install (on demand)

### Onboarding (recommended)

- Мастер онбординга (`openclaw onboard`) и `openclaw channels add` перечисляют необязательные плагины каналов.
- При выборе Nostr предлагается установить плагин по требованию.

Значения по умолчанию для установки:

- **Dev channel + git checkout available:** используется локальный путь плагина.
- **Stable/Beta:** загрузка из npm.

Вы всегда можете переопределить выбор в запросе.

### Manual install

```bash
openclaw plugins install @openclaw/nostr
```

Используйте локальный checkout (dev‑процессы):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

После установки или включения плагинов перезапустите Gateway (шлюз).

## Quick setup

1. Сгенерируйте пару ключей Nostr (при необходимости):

```bash
# Using nak
nak key generate
```

2. Добавьте в конфиг:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Экспортируйте ключ:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Перезапустите Gateway (шлюз).

## Configuration reference

| Key          | Type                                                         | Default                                     | Description                                       |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------- |
| `privateKey` | string                                                       | required                                    | Приватный ключ в формате `nsec` или hex           |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | URL ретрансляторов (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | Политика доступа к DM                             |
| `allowFrom`  | string[] | `[]`                                        | Разрешённые публичные ключи отправителей          |
| `enabled`    | boolean                                                      | `true`                                      | Включить/отключить канал                          |
| `name`       | string                                                       | -                                           | Отображаемое имя                                  |
| `profile`    | object                                                       | -                                           | Метаданные профиля NIP-01                         |

## Profile metadata

Данные профиля публикуются как событие NIP-01 `kind:0`. Управлять ими можно из Control UI (Channels -> Nostr -> Profile) или задать напрямую в конфиге.

Пример:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

Примечания:

- URL профиля должны использовать `https://`.
- Импорт из ретрансляторов объединяет поля и сохраняет локальные переопределения.

## Access control

### DM policies

- **pairing** (по умолчанию): неизвестные отправители получают код сопряжения.
- **allowlist**: DM могут отправлять только публичные ключи из `allowFrom`.
- **open**: публичные входящие DM (требуется `allowFrom: ["*"]`).
- **disabled**: игнорировать входящие DM.

### Allowlist example

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Key formats

Поддерживаемые форматы:

- **Приватный ключ:** `nsec...` или 64-символьный hex
- **Публичные ключи (`allowFrom`):** `npub...` или hex

## Relays

Значения по умолчанию: `relay.damus.io` и `nos.lol`.

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

Советы:

- Используйте 2–3 ретранслятора для избыточности.
- Избегайте слишком большого числа ретрансляторов (задержки, дублирование).
- Платные ретрансляторы могут повысить надёжность.
- Локальные ретрансляторы подходят для тестирования (`ws://localhost:7777`).

## Protocol support

| NIP    | Status    | Description                                    |
| ------ | --------- | ---------------------------------------------- |
| NIP-01 | Supported | Базовый формат событий + метаданные профиля    |
| NIP-04 | Supported | Зашифрованные DM (`kind:4`) |
| NIP-17 | Planned   | DM с «gift-wrap»                               |
| NIP-44 | Planned   | Версионированное шифрование                    |

## Testing

### Local relay

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Manual test

1. Запишите публичный ключ бота (npub) из логов.
2. Откройте клиент Nostr (Damus, Amethyst и т. д.).
3. Отправьте DM на публичный ключ бота.
4. Проверьте ответ.

## Troubleshooting

### Not receiving messages

- Проверьте, что приватный ключ корректен.
- Убедитесь, что URL ретрансляторов доступны и используют `wss://` (или `ws://` для локальных).
- Подтвердите, что `enabled` не равно `false`.
- Проверьте логи Gateway (шлюза) на ошибки подключения к ретрансляторам.

### Not sending responses

- Проверьте, принимает ли ретранслятор записи.
- Убедитесь в наличии исходящей сетевой доступности.
- Следите за ограничениями скорости ретрансляторов.

### Duplicate responses

- Ожидаемо при использовании нескольких ретрансляторов.
- Сообщения дедуплицируются по ID события; только первая доставка инициирует ответ.

## Security

- Никогда не коммитьте приватные ключи.
- Используйте переменные окружения для ключей.
- Рассмотрите `allowlist` для production‑ботов.

## Limitations (MVP)

- Только личные сообщения (без групповых чатов).
- Нет медиа‑вложений.
- Только NIP-04 (планируется gift‑wrap NIP-17).
