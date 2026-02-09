---
summary: "Скриптовая онбординг‑процедура и настройка агентов для OpenClaw CLI"
read_when:
  - Вы автоматизируете онбординг в скриптах или CI
  - Вам нужны неинтерактивные примеры для конкретных провайдеров
title: "Автоматизация CLI"
sidebarTitle: "CLI automation"
---

# Автоматизация CLI

Используйте `--non-interactive` для автоматизации `openclaw onboard`.

<Note>
`--json` не означает неинтерактивный режим. Для скриптов используйте `--non-interactive` (и `--workspace`).
</Note>

## Базовый неинтерактивный пример

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Добавьте `--json` для машиночитаемого сводного вывода.

## Примеры для конкретных провайдеров

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

## Добавление ещё одного агента

Используйте `openclaw agents add <name>` для создания отдельного агента с собственным рабочим пространством,
сеансами и профилями аутентификации. Запуск без `--workspace` открывает мастер.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Что настраивается:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Примечания:

- Рабочие пространства по умолчанию следуют `~/.openclaw/workspace-<agentId>`.
- Добавьте `bindings` для маршрутизации входящих сообщений (мастер может сделать это).
- Неинтерактивные флаги: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Связанная документация

- Центр онбординга: [Onboarding Wizard (CLI)](/start/wizard)
- Полный справочник: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Справочник команд: [`openclaw onboard`](/cli/onboard)
