---
summary: "Как работают скрипты установщика (install.sh, install-cli.sh, install.ps1), флаги и автоматизация"
read_when:
  - Вы хотите понять `openclaw.ai/install.sh`
  - Вы хотите автоматизировать установку (CI / headless)
  - Вы хотите установить из checkout репозитория GitHub
title: "Внутреннее устройство установщика"
---

# Внутреннее устройство установщика

OpenClaw поставляется с тремя скриптами установщика, доступными по адресу `openclaw.ai`.

| Скрипт                             | Платформа                               | Что делает                                                                                                                                                    |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | Устанавливает Node при необходимости, устанавливает OpenClaw через npm (по умолчанию) или git и может запустить онбординг. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Устанавливает Node + OpenClaw в локальный префикс (`~/.openclaw`). Права root не требуются.                |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Устанавливает Node при необходимости, устанавливает OpenClaw через npm (по умолчанию) или git и может запустить онбординг. |

## Быстрые команды

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ````
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```
    ````

  </Tab>
</Tabs>

<Note>Если установка прошла успешно, но `openclaw` не найден в новом терминале, см. [устранение неполадок Node.js](/install/node#troubleshooting).</Note>

---

## install.sh

<Tip>
Рекомендуется для большинства интерактивных установок на macOS/Linux/WSL.
</Tip>

### Поток выполнения (install.sh)

<Steps>
  <Step title="Detect OS">
    Поддерживаются macOS и Linux (включая WSL). Если обнаружена macOS, устанавливается Homebrew при отсутствии.
  </Step>
  <Step title="Ensure Node.js 22+">
    Проверяет версию Node и устанавливает Node 22 при необходимости (Homebrew на macOS, скрипты NodeSource на Linux apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    Устанавливает Git при отсутствии.
  </Step>
  <Step title="Install OpenClaw">
    - метод `npm` (по умолчанию): глобальная установка через npm
    - метод `git`: клонирование/обновление репозитория, установка зависимостей через pnpm, сборка и установка обёртки в `~/.local/bin/openclaw`
  </Step>
  <Step title="Post-install tasks">
    - Запускает `openclaw doctor --non-interactive` при обновлениях и установках из git (best effort)
    - Пытается выполнить онбординг при подходящих условиях (доступен TTY, онбординг не отключён, проверки bootstrap/конфига пройдены)
    - По умолчанию `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Обнаружение checkout исходников

Если скрипт запущен внутри checkout OpenClaw (`package.json` + `pnpm-workspace.yaml`), он предлагает:

- использовать checkout (`git`), или
- использовать глобальную установку (`npm`)

Если TTY недоступен и метод установки не задан, по умолчанию выбирается `npm` и выводится предупреждение.

Скрипт завершает работу с кодом `2` при неверном выборе метода или некорректных значениях `--install-method`.

### Примеры (install.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Флаг                              | Описание                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | Выбор метода установки (по умолчанию: `npm`). Псевдоним: `--method` |
| `--npm`                           | Быстрый выбор метода npm                                                                                                               |
| `--git`                           | Быстрый выбор метода git. Псевдоним: `--github`                                                        |
| `--version <version\\|dist-tag>` | Версия npm или dist-tag (по умолчанию: `latest`)                                                    |
| `--beta`                          | Использовать beta dist-tag при наличии, иначе fallback на `latest`                                                                     |
| `--git-dir <path>`                | Каталог checkout (по умолчанию: `~/openclaw`). Псевдоним: `--dir`   |
| `--no-git-update`                 | Пропустить `git pull` для существующего checkout                                                                                       |
| `--no-prompt`                     | Отключить запросы                                                                                                                      |
| `--no-onboard`                    | Пропустить онбординг                                                                                                                   |
| `--onboard`                       | Включить онбординг                                                                                                                     |
| `--dry-run`                       | Печать действий без применения изменений                                                                                               |
| `--verbose`                       | Включить отладочный вывод (`set -x`, логи npm уровня notice)                                                        |
| `--help`                          | Показать справку (`-h`)                                                                                             |

  </Accordion>

  <Accordion title="Environment variables reference">

| Переменная                                      | Описание                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | Метод установки                                                                            |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | Версия npm или dist-tag                                                                    |
| `OPENCLAW_BETA=0\\|1`                          | Использовать beta при наличии                                                              |
| `OPENCLAW_GIT_DIR=<path>`                       | Каталог checkout                                                                           |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | Переключение обновлений git                                                                |
| `OPENCLAW_NO_PROMPT=1`                          | Отключить запросы                                                                          |
| `OPENCLAW_NO_ONBOARD=1`                         | Пропустить онбординг                                                                       |
| `OPENCLAW_DRY_RUN=1`                            | Режим пробного запуска                                                                     |
| `OPENCLAW_VERBOSE=1`                            | Режим отладки                                                                              |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Уровень логирования npm                                                                    |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Управление поведением sharp/libvips (по умолчанию: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Предназначен для сред, где всё должно находиться под локальным префиксом (по умолчанию `~/.openclaw`) и без зависимости от системного Node.
</Info>

### Поток выполнения (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Загружает tarball Node (по умолчанию `22.22.0`) в `<prefix>/tools/node-v<version>` и проверяет SHA-256.
  </Step>
  <Step title="Ensure Git">
    Если Git отсутствует, пытается установить через apt/dnf/yum на Linux или Homebrew на macOS.
  </Step>
  <Step title="Install OpenClaw under prefix">
    Устанавливает через npm с использованием `--prefix <prefix>`, затем записывает обёртку в `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Примеры (install-cli.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Флаг                   | Описание                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Префикс установки (по умолчанию: `~/.openclaw`)                       |
| `--version <ver>`      | Версия OpenClaw или dist-tag (по умолчанию: `latest`)                 |
| `--node-version <ver>` | Версия Node (по умолчанию: `22.22.0`)                                 |
| `--json`               | Вывод событий NDJSON                                                                                     |
| `--onboard`            | Запустить `openclaw onboard` после установки                                                             |
| `--no-onboard`         | Пропустить онбординг (по умолчанию)                                                   |
| `--set-npm-prefix`     | В Linux принудительно установить npm prefix в `~/.npm-global`, если текущий prefix недоступен для записи |
| `--help`               | Показать справку (`-h`)                                                               |

  </Accordion>

  <Accordion title="Environment variables reference">

| Переменная                                      | Описание                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | Префикс установки                                                                                                       |
| `OPENCLAW_VERSION=<ver>`                        | Версия OpenClaw или dist-tag                                                                                            |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Версия Node                                                                                                             |
| `OPENCLAW_NO_ONBOARD=1`                         | Пропустить онбординг                                                                                                    |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Уровень логирования npm                                                                                                 |
| `OPENCLAW_GIT_DIR=<path>`                       | Путь поиска для устаревшей очистки (используется при удалении старого checkout подмодуля `Peekaboo`) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Управление поведением sharp/libvips (по умолчанию: `1`)                              |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Поток выполнения (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Требуется PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    При отсутствии пытается установить через winget, затем Chocolatey, затем Scoop.
  </Step>
  <Step title="Install OpenClaw">
    - метод `npm` (по умолчанию): глобальная установка через npm с использованием выбранного `-Tag`
    - метод `git`: клонирование/обновление репозитория, установка/сборка через pnpm и установка обёртки в `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Post-install tasks">
    Добавляет необходимый каталог bin в пользовательский PATH при возможности, затем запускает `openclaw doctor --non-interactive` при обновлениях и установках из git (best effort).
  </Step>
</Steps>

### Примеры (install.ps1)

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Флаг                        | Описание                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | Метод установки (по умолчанию: `npm`)                      |
| `-Tag <tag>`                | npm dist-tag (по умолчанию: `latest`)                      |
| `-GitDir <path>`            | Каталог checkout (по умолчанию: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | Пропустить онбординг                                                                          |
| `-NoGitUpdate`              | Пропустить `git pull`                                                                         |
| `-DryRun`                   | Печать только действий                                                                        |

  </Accordion>

  <Accordion title="Environment variables reference">

| Переменная                           | Описание               |
| ------------------------------------ | ---------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | Метод установки        |
| `OPENCLAW_GIT_DIR=<path>`            | Каталог checkout       |
| `OPENCLAW_NO_ONBOARD=1`              | Пропустить онбординг   |
| `OPENCLAW_GIT_UPDATE=0`              | Отключить git pull     |
| `OPENCLAW_DRY_RUN=1`                 | Режим пробного запуска |

  </Accordion>
</AccordionGroup>

<Note>
Если используется `-InstallMethod git` и Git отсутствует, скрипт завершает работу и выводит ссылку на Git for Windows.
</Note>

---

## CI и автоматизация

Используйте неинтерактивные флаги/переменные окружения для предсказуемых запусков.

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Устранение неполадок

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git требуется для метода установки `git`. Для установок `npm` Git всё равно проверяется/устанавливается, чтобы избежать сбоев `spawn git ENOENT`, когда зависимости используют git URL.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    В некоторых конфигурациях Linux глобальный prefix npm указывает на пути, принадлежащие root. `install.sh` может переключить prefix на `~/.npm-global` и добавить экспорты PATH в файлы rc оболочки (когда такие файлы существуют).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    По умолчанию скрипты устанавливают `SHARP_IGNORE_GLOBAL_LIBVIPS=1`, чтобы избежать сборки sharp против системного libvips. Чтобы переопределить:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Установите Git for Windows, перезапустите PowerShell и повторно запустите установщик.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Выполните `npm config get prefix`, добавьте `\bin`, добавьте этот каталог в пользовательский PATH, затем перезапустите PowerShell.
  </Accordion>

  <Accordion title="openclaw not found after install">
    Обычно это проблема PATH. См. [устранение неполадок Node.js](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
