---
summary: "Jak działają skrypty instalatora (install.sh, install-cli.sh, install.ps1), flagi i automatyzacja"
read_when:
  - Chcesz zrozumieć `openclaw.ai/install.sh`
  - Chcesz zautomatyzować instalacje (CI / bez interakcji)
  - Chcesz zainstalować z checkoutu GitHub
title: "Wewnętrzne mechanizmy instalatora"
x-i18n:
  source_path: install/installer.md
  source_hash: 8517f9cf8e237b62
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:43Z
---

# Wewnętrzne mechanizmy instalatora

OpenClaw dostarcza trzy skrypty instalatora, udostępniane z `openclaw.ai`.

| Skrypt                             | Platforma            | Co robi                                                                                                       |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | Instaluje Node, jeśli potrzeba, instaluje OpenClaw przez npm (domyślnie) lub git i może uruchomić onboarding. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Instaluje Node + OpenClaw do lokalnego prefiksu (`~/.openclaw`). Nie wymaga uprawnień roota.                  |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Instaluje Node, jeśli potrzeba, instaluje OpenClaw przez npm (domyślnie) lub git i może uruchomić onboarding. |

## Szybkie polecenia

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```

  </Tab>
</Tabs>

<Note>
Jeśli instalacja się powiedzie, ale w nowym terminalu nie znaleziono `openclaw`, zobacz [Rozwiązywanie problemów z Node.js](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Zalecany dla większości interaktywnych instalacji na macOS/Linux/WSL.
</Tip>

### Przebieg (install.sh)

<Steps>
  <Step title="Wykrywanie systemu operacyjnego">
    Obsługuje macOS i Linux (w tym WSL). Jeśli wykryto macOS, instaluje Homebrew, jeśli brakuje.
  </Step>
  <Step title="Zapewnienie Node.js 22+">
    Sprawdza wersję Node i instaluje Node 22 w razie potrzeby (Homebrew na macOS, skrypty konfiguracyjne NodeSource na Linux apt/dnf/yum).
  </Step>
  <Step title="Zapewnienie Git">
    Instaluje Git, jeśli brakuje.
  </Step>
  <Step title="Instalacja OpenClaw">
    - metoda `npm` (domyślna): globalna instalacja npm
    - metoda `git`: klonowanie/aktualizacja repozytorium, instalacja zależności przez pnpm, build, a następnie instalacja wrappera w `~/.local/bin/openclaw`
  </Step>
  <Step title="Zadania po instalacji">
    - Uruchamia `openclaw doctor --non-interactive` przy aktualizacjach i instalacjach git (best effort)
    - Próbuje uruchomić onboarding, gdy jest to właściwe (dostępny TTY, onboarding nie jest wyłączony oraz przechodzą kontrole bootstrap/konfiguracji)
    - Domyślnie `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Wykrywanie checkoutu źródłowego

Jeśli uruchomiono wewnątrz checkoutu OpenClaw (`package.json` + `pnpm-workspace.yaml`), skrypt oferuje:

- użycie checkoutu (`git`), lub
- użycie instalacji globalnej (`npm`)

Jeśli nie ma dostępnego TTY i nie ustawiono metody instalacji, domyślnie wybierane jest `npm` i wyświetlane jest ostrzeżenie.

Skrypt kończy się kodem `2` przy nieprawidłowym wyborze metody lub nieprawidłowych wartościach `--install-method`.

### Przykłady (install.sh)

<Tabs>
  <Tab title="Domyślne">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Pomiń onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Instalacja git">
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
  <Accordion title="Referencja flag">

| Flaga                           | Opis                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `--install-method npm\|git`     | Wybór metody instalacji (domyślnie: `npm`). Alias: `--method`               |
| `--npm`                         | Skrót do metody npm                                                         |
| `--git`                         | Skrót do metody git. Alias: `--github`                                      |
| `--version <version\|dist-tag>` | Wersja npm lub dist-tag (domyślnie: `latest`)                               |
| `--beta`                        | Użyj dist-tag beta, jeśli dostępny, w przeciwnym razie fallback do `latest` |
| `--git-dir <path>`              | Katalog checkoutu (domyślnie: `~/openclaw`). Alias: `--dir`                 |
| `--no-git-update`               | Pomiń `git pull` dla istniejącego checkoutu                                 |
| `--no-prompt`                   | Wyłącz monity                                                               |
| `--no-onboard`                  | Pomiń onboarding                                                            |
| `--onboard`                     | Włącz onboarding                                                            |
| `--dry-run`                     | Wyświetl akcje bez stosowania zmian                                         |
| `--verbose`                     | Włącz wyjście debug (`set -x`, logi npm na poziomie notice)                 |
| `--help`                        | Pokaż użycie (`-h`)                                                         |

  </Accordion>

  <Accordion title="Referencja zmiennych środowiskowych">

| Zmienna                                     | Opis                                               |
| ------------------------------------------- | -------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | Metoda instalacji                                  |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | Wersja npm lub dist-tag                            |
| `OPENCLAW_BETA=0\|1`                        | Użyj beta, jeśli dostępne                          |
| `OPENCLAW_GIT_DIR=<path>`                   | Katalog checkoutu                                  |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | Przełącznik aktualizacji git                       |
| `OPENCLAW_NO_PROMPT=1`                      | Wyłącz monity                                      |
| `OPENCLAW_NO_ONBOARD=1`                     | Pomiń onboarding                                   |
| `OPENCLAW_DRY_RUN=1`                        | Tryb dry run                                       |
| `OPENCLAW_VERBOSE=1`                        | Tryb debug                                         |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | Poziom logów npm                                   |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Kontrola zachowania sharp/libvips (domyślnie: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Zaprojektowany dla środowisk, w których wszystko ma znajdować się pod lokalnym prefiksem (domyślnie `~/.openclaw`) i bez zależności od systemowego Node.
</Info>

### Przebieg (install-cli.sh)

<Steps>
  <Step title="Instalacja lokalnego runtime Node">
    Pobiera archiwum Node (domyślnie `22.22.0`) do `<prefix>/tools/node-v<version>` i weryfikuje SHA-256.
  </Step>
  <Step title="Zapewnienie Git">
    Jeśli brakuje Git, próbuje instalacji przez apt/dnf/yum na Linux lub Homebrew na macOS.
  </Step>
  <Step title="Instalacja OpenClaw pod prefiksem">
    Instaluje przez npm używając `--prefix <prefix>`, a następnie zapisuje wrapper do `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Przykłady (install-cli.sh)

<Tabs>
  <Tab title="Domyślne">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Własny prefiks + wersja">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automatyzacja – wyjście JSON">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Uruchom onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Referencja flag">

| Flaga                  | Opis                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Prefiks instalacji (domyślnie: `~/.openclaw`)                                             |
| `--version <ver>`      | Wersja OpenClaw lub dist-tag (domyślnie: `latest`)                                        |
| `--node-version <ver>` | Wersja Node (domyślnie: `22.22.0`)                                                        |
| `--json`               | Emituj zdarzenia NDJSON                                                                   |
| `--onboard`            | Uruchom `openclaw onboard` po instalacji                                                  |
| `--no-onboard`         | Pomiń onboarding (domyślnie)                                                              |
| `--set-npm-prefix`     | Na Linux wymuś prefiks npm na `~/.npm-global`, jeśli bieżący prefiks nie jest zapisywalny |
| `--help`               | Pokaż użycie (`-h`)                                                                       |

  </Accordion>

  <Accordion title="Referencja zmiennych środowiskowych">

| Zmienna                                     | Opis                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | Prefiks instalacji                                                                                        |
| `OPENCLAW_VERSION=<ver>`                    | Wersja OpenClaw lub dist-tag                                                                              |
| `OPENCLAW_NODE_VERSION=<ver>`               | Wersja Node                                                                                               |
| `OPENCLAW_NO_ONBOARD=1`                     | Pomiń onboarding                                                                                          |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | Poziom logów npm                                                                                          |
| `OPENCLAW_GIT_DIR=<path>`                   | Ścieżka wyszukiwania do czyszczenia legacy (używana przy usuwaniu starego checkoutu submodułu `Peekaboo`) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Kontrola zachowania sharp/libvips (domyślnie: `1`)                                                        |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Przebieg (install.ps1)

<Steps>
  <Step title="Zapewnienie PowerShell + środowiska Windows">
    Wymaga PowerShell 5+.
  </Step>
  <Step title="Zapewnienie Node.js 22+">
    Jeśli brakuje, próbuje instalacji przez winget, następnie Chocolatey, a potem Scoop.
  </Step>
  <Step title="Instalacja OpenClaw">
    - metoda `npm` (domyślna): globalna instalacja npm z użyciem wybranego `-Tag`
    - metoda `git`: klonowanie/aktualizacja repozytorium, instalacja/build przez pnpm oraz instalacja wrappera w `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Zadania po instalacji">
    Dodaje wymagany katalog bin do użytkowego PATH, gdy to możliwe, a następnie uruchamia `openclaw doctor --non-interactive` przy aktualizacjach i instalacjach git (best effort).
  </Step>
</Steps>

### Przykłady (install.ps1)

<Tabs>
  <Tab title="Domyślne">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Instalacja git">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Własny katalog git">
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
  <Accordion title="Referencja flag">

| Flaga                     | Opis                                                    |
| ------------------------- | ------------------------------------------------------- |
| `-InstallMethod npm\|git` | Metoda instalacji (domyślnie: `npm`)                    |
| `-Tag <tag>`              | dist-tag npm (domyślnie: `latest`)                      |
| `-GitDir <path>`          | Katalog checkoutu (domyślnie: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`              | Pomiń onboarding                                        |
| `-NoGitUpdate`            | Pomiń `git pull`                                        |
| `-DryRun`                 | Wyświetl tylko akcje                                    |

  </Accordion>

  <Accordion title="Referencja zmiennych środowiskowych">

| Zmienna                            | Opis              |
| ---------------------------------- | ----------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | Metoda instalacji |
| `OPENCLAW_GIT_DIR=<path>`          | Katalog checkoutu |
| `OPENCLAW_NO_ONBOARD=1`            | Pomiń onboarding  |
| `OPENCLAW_GIT_UPDATE=0`            | Wyłącz git pull   |
| `OPENCLAW_DRY_RUN=1`               | Tryb dry run      |

  </Accordion>
</AccordionGroup>

<Note>
Jeśli użyto `-InstallMethod git` i brakuje Git, skrypt kończy działanie i wypisuje link do Git for Windows.
</Note>

---

## CI i automatyzacja

Używaj nieinteraktywnych flag/zmiennych środowiskowych dla przewidywalnych uruchomień.

<Tabs>
  <Tab title="install.sh (nieinteraktywne npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (nieinteraktywne git)">
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
  <Tab title="install.ps1 (pomiń onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Rozwiązywanie problemów

<AccordionGroup>
  <Accordion title="Dlaczego wymagany jest Git?">
    Git jest wymagany dla metody instalacji `git`. Dla instalacji `npm` Git jest nadal sprawdzany/instalowany, aby uniknąć błędów `spawn git ENOENT`, gdy zależności używają adresów URL git.
  </Accordion>

  <Accordion title="Dlaczego npm trafia na EACCES na Linux?">
    Niektóre konfiguracje Linux wskazują globalny prefiks npm na ścieżki należące do roota. `install.sh` może przełączyć prefiks na `~/.npm-global` i dodać eksporty PATH do plików rc powłoki (gdy te pliki istnieją).
  </Accordion>

  <Accordion title="Problemy sharp/libvips">
    Skrypty domyślnie ustawiają `SHARP_IGNORE_GLOBAL_LIBVIPS=1`, aby uniknąć budowania sharp przeciwko systemowemu libvips. Aby nadpisać:

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Zainstaluj Git for Windows, otwórz ponownie PowerShell i uruchom instalator ponownie.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Uruchom `npm config get prefix`, dołącz `\bin`, dodaj ten katalog do użytkowego PATH, a następnie otwórz ponownie PowerShell.
  </Accordion>

  <Accordion title="openclaw nie znaleziono po instalacji">
    Zwykle jest to problem z PATH. Zobacz [Rozwiązywanie problemów z Node.js](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
