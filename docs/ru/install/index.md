---
summary: "Установка OpenClaw — скрипт-установщик, npm/pnpm, из исходников, Docker и другое"
read_when:
  - Вам нужен способ установки, отличный от быстрого старта «Начало работы»
  - Вы хотите развернуть систему на облачной платформе
  - Вам нужно обновить, мигрировать или удалить установку
title: "Установка"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:46Z
---

# Установка

Уже прошли [Начало работы](/start/getting-started)? Тогда всё готово — эта страница посвящена альтернативным способам установки, инструкциям для конкретных платформ и обслуживанию.

## Системные требования

- **[Node 22+](/install/node)** (скрипт-установщик из раздела [способы установки](#install-methods) установит его при отсутствии)
- macOS, Linux или Windows
- `pnpm` — только при сборке из исходников

<Note>
В Windows настоятельно рекомендуется запускать OpenClaw под [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## Способы установки

<Tip>
**Скрипт-установщик** — рекомендуемый способ установки OpenClaw. Он выполняет обнаружение Node, установку и первичную настройку за один шаг.
</Tip>

<AccordionGroup>
  <Accordion title="Скрипт-установщик" icon="rocket" defaultOpen>
    Загружает CLI, устанавливает его глобально через npm и запускает мастер первичной настройки.

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
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

    Готово — скрипт выполняет обнаружение Node, установку и первичную настройку.

    Чтобы пропустить первичную настройку и просто установить бинарный файл:

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    Все флаги, переменные окружения и варианты для CI/автоматизации см. в разделе [Внутреннее устройство установщика](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Если у вас уже есть Node 22+ и вы предпочитаете управлять установкой самостоятельно:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="Ошибки сборки sharp?">
          Если у вас глобально установлен libvips (часто на macOS через Homebrew) и `sharp` завершается с ошибкой, принудительно используйте предварительно собранные бинарные файлы:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Если вы видите `sharp: Please add node-gyp to your dependencies`, установите инструменты сборки (macOS: Xcode CLT + `npm install -g node-gyp`) или используйте указанную выше переменную окружения.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm требует явного подтверждения для пакетов со скриптами сборки. После того как первая установка покажет предупреждение «Ignored build scripts», выполните `pnpm approve-builds -g` и выберите перечисленные пакеты.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="Из исходников" icon="github">
    Для контрибьюторов или тех, кто хочет запускать из локального репозитория.

    <Steps>
      <Step title="Клонировать и собрать">
        Клонируйте [репозиторий OpenClaw](https://github.com/openclaw/openclaw) и выполните сборку:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Подключить CLI">
        Сделайте команду `openclaw` доступной глобально:

        ```bash
        pnpm link --global
        ```

        Либо пропустите связывание и запускайте команды через `pnpm openclaw ...` изнутри репозитория.
      </Step>
      <Step title="Запустить первичную настройку">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    Для более глубоких рабочих процессов разработки см. раздел [Настройка](/start/setup).

  </Accordion>
</AccordionGroup>

## Другие способы установки

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Контейнеризованные или headless-развёртывания.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Декларативная установка через Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Автоматизированное развёртывание парка.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Использование только CLI через рантайм Bun.
  </Card>
</CardGroup>

## После установки

Проверьте, что всё работает:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Устранение неполадок: `openclaw` не найден

<Accordion title="Диагностика и исправление PATH">
  Быстрая диагностика:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Если `$(npm prefix -g)/bin` (macOS/Linux) или `$(npm prefix -g)` (Windows) **отсутствует** в вашем `$PATH`, оболочка не может найти глобальные бинарные файлы npm (включая `openclaw`).

Исправление — добавьте его в файл инициализации вашей оболочки (`~/.zshrc` или `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

В Windows добавьте вывод команды `npm prefix -g` в PATH.

Затем откройте новый терминал (или выполните `rehash` в zsh / `hash -r` в bash).
</Accordion>

## Обновление / удаление

<CardGroup cols={3}>
  <Card title="Обновление" href="/install/updating" icon="refresh-cw">
    Поддерживайте OpenClaw в актуальном состоянии.
  </Card>
  <Card title="Миграция" href="/install/migrating" icon="arrow-right">
    Перенос на новую машину.
  </Card>
  <Card title="Удаление" href="/install/uninstall" icon="trash-2">
    Полностью удалить OpenClaw.
  </Card>
</CardGroup>
