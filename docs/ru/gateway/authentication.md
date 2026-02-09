---
summary: "Аутентификация моделей: OAuth, ключи API и setup-token"
read_when:
  - Отладка аутентификации модели или истечения OAuth
  - Документирование аутентификации или хранения учётных данных
title: "Аутентификация"
---

# Аутентификация

OpenClaw поддерживает OAuth и ключи API для провайдеров моделей. Для аккаунтов
Anthropic мы рекомендуем использовать **ключ API**. Для доступа по подписке
Claude используйте долгоживущий токен, созданный с помощью `claude setup-token`.

[/concepts/oauth](/concepts/oauth) для полного описания потока OAuth и схемы
хранения.

## Рекомендуемая настройка Anthropic (ключ API)

Если вы используете Anthropic напрямую, применяйте ключ API.

1. Создайте ключ API в консоли Anthropic.
2. Разместите его на **хосте шлюза Gateway** (на машине, где запущен `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Если Gateway работает под systemd/launchd, предпочтительно поместить ключ в
   `~/.openclaw/.env`, чтобы демон мог его читать:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Затем перезапустите демон (или перезапустите процесс Gateway) и выполните
повторную проверку:

```bash
openclaw models status
openclaw doctor
```

Если вы не хотите управлять переменными окружения вручную, мастер онбординга
может сохранить ключи API для использования демоном: `openclaw onboard`.

Подробности о наследовании окружения см. в разделе [Help](/help)
(`env.shellEnv`, `~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (аутентификация по подписке)

Для Anthropic рекомендуемый путь — **ключ API**. Если вы используете подписку
Claude, также поддерживается поток setup-token. Запустите его на
**хосте шлюза Gateway**:

```bash
claude setup-token
```

Затем вставьте его в OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Если токен был создан на другой машине, вставьте его вручную:

```bash
openclaw models auth paste-token --provider anthropic
```

Если вы видите ошибку Anthropic вида:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…используйте вместо этого ключ API Anthropic.

Ручной ввод токена (любой провайдер; выполняет запись `auth-profiles.json` +
обновляет конфиг):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Проверка, удобная для автоматизации (код выхода `1` при
истечении/отсутствии, `2` при скором истечении):

```bash
openclaw models status --check
```

Необязательные ops-скрипты (systemd/Termux) описаны здесь:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` требует интерактивный TTY.

## Проверка статуса аутентификации модели

```bash
openclaw models status
openclaw doctor
```

## Управление используемыми учётными данными

### Для сеанса (команда чата)

Используйте `/model <alias-or-id>@<profileId>`, чтобы закрепить конкретные учётные данные
провайдера для текущего сеанса (примеры идентификаторов профилей:
`anthropic:default`, `anthropic:work`).

Используйте `/model` (или `/model list`) для компактного выбора;
используйте `/model status` для полного представления (кандидаты + следующий
профиль аутентификации, а также сведения об endpoint провайдера при настройке).

### Для агента (переопределение CLI)

Задайте явное переопределение порядка профилей аутентификации для агента
(сохраняется в `auth-profiles.json` этого агента):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Используйте `--agent <id>` для нацеливания на конкретного агента; опустите
его, чтобы использовать настроенного агента по умолчанию.

## Устранение неполадок

### «Учётные данные не найдены»

Если профиль токена Anthropic отсутствует, запустите `claude setup-token` на
**хосте шлюза Gateway**, затем выполните повторную проверку:

```bash
openclaw models status
```

### Срок действия или срок действия токена истек

Запустите `openclaw models status`, чтобы подтвердить, какой профиль истекает. Если
профиль отсутствует, повторно выполните `claude setup-token` и снова вставьте токен.

## Требования

- Подписка Claude Max или Pro (для `claude setup-token`)
- Установленный Claude Code CLI (доступна команда `claude`)
