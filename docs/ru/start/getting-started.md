---
summary: "Установите OpenClaw и запустите первый чат за считанные минуты."
read_when:
  - Первоначальная настройка с нуля
  - Нужен самый быстрый путь к работающему чату
title: "Начало работы"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:59Z
---

# Начало работы

Цель: с минимальной настройкой перейти от нуля к первому работающему чату.

<Info>
Самый быстрый способ начать чат: откройте Control UI (настройка каналов не требуется). Запустите `openclaw dashboard`
и общайтесь в браузере, либо откройте `http://127.0.0.1:18789/` на
<Tooltip headline="Gateway host" tip="Машина, на которой запущен сервис шлюза OpenClaw.">хосте шлюза Gateway</Tooltip>.
Документация: [Dashboard](/web/dashboard) и [Control UI](/web/control-ui).
</Info>

## Предварительные требования

- Node 22 или новее

<Tip>
Если вы не уверены, проверьте версию Node с помощью `node --version`.
</Tip>

## Быстрая настройка (CLI)

<Steps>
  <Step title="Установка OpenClaw (рекомендуется)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Другие способы установки и требования: [Установка](/install).
    </Note>

  </Step>
  <Step title="Запуск мастера первичной настройки">
    ```bash
    openclaw onboard --install-daemon
    ```

    Мастер настраивает аутентификацию, параметры шлюза Gateway и необязательные каналы.
    Подробности см. в разделе [Мастер первичной настройки](/start/wizard).

  </Step>
  <Step title="Проверка Gateway">
    Если вы установили сервис, он уже должен быть запущен:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Открытие Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Если Control UI загружается, ваш Gateway готов к использованию.
</Check>

## Необязательные проверки и дополнения

<AccordionGroup>
  <Accordion title="Запуск Gateway на переднем плане">
    Полезно для быстрых тестов или устранения неполадок.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Отправка тестового сообщения">
    Требуется настроенный канал.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Углублённое изучение

<Columns>
  <Card title="Мастер первичной настройки (подробности)" href="/start/wizard">
    Полный справочник по CLI‑мастеру и расширенные параметры.
  </Card>
  <Card title="Онбординг приложения для macOS" href="/start/onboarding">
    Процесс первого запуска приложения для macOS.
  </Card>
</Columns>

## Что у вас будет

- Запущенный Gateway
- Настроенная аутентификация
- Доступ к Control UI или подключённый канал

## Дальнейшие шаги

- Безопасность личных сообщений и подтверждения: [Сопряжение](/channels/pairing)
- Подключение дополнительных каналов: [Каналы](/channels)
- Продвинутые сценарии и сборка из исходников: [Настройка](/start/setup)
