---
summary: "Используйте OpenCode Zen (курируемые модели) с OpenClaw"
read_when:
  - Вам нужен OpenCode Zen для доступа к моделям
  - Вам нужен курируемый список моделей, удобных для программирования
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen — это **курируемый список моделей**, рекомендованных командой OpenCode для агентів программирования.
Это необязательный, размещённый вариант доступа к моделям, который использует ключ API и провайдер `opencode`.
В настоящее время Zen находится в бета-версии.

## настройка CLI

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## фрагмент конфига

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Примечания

- Также поддерживается `OPENCODE_ZEN_API_KEY`.
- Вы входите в Zen, добавляете платёжные данные и копируете свой ключ API.
- OpenCode Zen выставляет счета за запрос; подробности см. на панели управления OpenCode.
