---
summary: "Использование Anthropic Claude через ключи API или setup-token в OpenClaw"
read_when:
  - Вы хотите использовать модели Anthropic в OpenClaw
  - Вы хотите использовать setup-token вместо ключей API
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic разрабатывает семейство моделей **Claude** и предоставляет доступ к ним через API.
В OpenClaw вы можете пройти аутентификацию с помощью ключа API или **setup-token**.

## Вариант A: ключ API Anthropic

**Лучше всего подходит для:** стандартного доступа к API и биллинга по факту использования.
Создайте свой ключ API в консоли Anthropic.

### CLI setup

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Config snippet

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Кэширование промптов (Anthropic API)

OpenClaw поддерживает функцию кэширования промптов Anthropic. Это **только для API**; аутентификация по подписке не учитывает настройки кэша.

### Конфигурация

Используйте параметр `cacheRetention` в конфиге модели:

| Value   | Cache Duration  | Description                                              |
| ------- | --------------- | -------------------------------------------------------- |
| `none`  | Без кэширования | Отключить кэширование промптов                           |
| `short` | 5 минут         | Значение по умолчанию для аутентификации по ключу API    |
| `long`  | 1 час           | Расширенный кэш (требуется бета-флаг) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Значения по умолчанию

При использовании аутентификации с помощью ключа API Anthropic OpenClaw автоматически применяет `cacheRetention: "short"` (кэш на 5 минут) для всех моделей Anthropic. Вы можете переопределить это, явно указав `cacheRetention` в конфиге.

### Устаревший параметр

Более старый параметр `cacheControlTtl` по-прежнему поддерживается для обратной совместимости:

- `"5m"` сопоставляется с `short`
- `"1h"` сопоставляется с `long`

Рекомендуется перейти на новый параметр `cacheRetention`.

OpenClaw включает бета-флаг `extended-cache-ttl-2025-04-11` для запросов к Anthropic API;
сохраните его, если вы переопределяете заголовки провайдера (см. [/gateway/configuration](/gateway/configuration)).

## Вариант B: Claude setup-token

**Лучше всего подходит для:** использования вашей подписки Claude.

### Где получить setup-token

Setup-token создаются с помощью **Claude Code CLI**, а не в консоли Anthropic. Вы можете запустить его на **любой машине**:

```bash
claude setup-token
```

Вставьте токен в OpenClaw (мастер: **Anthropic token (paste setup-token)**) или выполните команду на хосте шлюза Gateway:

```bash
openclaw models auth setup-token --provider anthropic
```

Если вы сгенерировали токен на другой машине, вставьте его:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI setup (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Config snippet (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Примечания

- Сгенерируйте setup-token с помощью `claude setup-token` и вставьте его, либо выполните `openclaw models auth setup-token` на хосте шлюза Gateway.
- Если вы видите сообщение «OAuth token refresh failed …» при использовании подписки Claude, повторно выполните аутентификацию с помощью setup-token. См. [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Подробности аутентификации и правила повторного использования описаны в [/concepts/oauth](/concepts/oauth).

## Устранение неполадок

**Ошибки 401 / токен внезапно стал недействительным**

- Аутентификация по подписке Claude может истечь или быть отозвана. Повторно выполните `claude setup-token`
  и вставьте токен на **хосте шлюза Gateway**.
- Если вход в Claude CLI выполнен на другой машине, используйте
  `openclaw models auth paste-token --provider anthropic` на хосте шлюза Gateway.

**No API key found for provider "anthropic"**

- Аутентификация выполняется **для каждого агента**. Новые агенты не наследуют ключи основного агента.
- Повторно запустите онбординг для этого агента либо вставьте setup-token / ключ API на
  хосте шлюза Gateway, затем проверьте с помощью `openclaw models status`.

**No credentials found for profile `anthropic:default`**

- Выполните `openclaw models status`, чтобы увидеть, какой профиль аутентификации активен.
- Повторно выполните онбординг либо вставьте setup-token / ключ API для этого профиля.

**No available auth profile (all in cooldown/unavailable)**

- Проверьте `openclaw models status --json` на наличие `auth.unusableProfiles`.
- Добавьте ещё один профиль Anthropic или дождитесь окончания периода cooldown.

Подробнее: [/gateway/troubleshooting](/gateway/troubleshooting) и [/help/faq](/help/faq).
