---
summary: "Zainstaluj OpenClaw — skrypt instalatora, npm/pnpm, ze źródeł, Docker i inne"
read_when:
  - Potrzebujesz metody instalacji innej niż Szybki start w Pierwszych krokach
  - Chcesz wdrożyć na platformie chmurowej
  - Musisz zaktualizować, zmigrować lub odinstalować
title: "Instalacja"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:24Z
---

# Instalacja

Masz już za sobą [Pierwsze kroki](/start/getting-started)? Świetnie — ta strona dotyczy alternatywnych metod instalacji, instrukcji specyficznych dla platform oraz utrzymania.

## Wymagania systemowe

- **[Node 22+](/install/node)** ( [skrypt instalatora](#install-methods) zainstaluje go, jeśli go brakuje)
- macOS, Linux lub Windows
- `pnpm` tylko jeśli budujesz ze źródeł

<Note>
W systemie Windows zdecydowanie zalecamy uruchamianie OpenClaw w [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## Metody instalacji

<Tip>
**Skrypt instalatora** to zalecany sposób instalacji OpenClaw. W jednym kroku obsługuje wykrywanie Node, instalację oraz onboarding.
</Tip>

<AccordionGroup>
  <Accordion title="Skrypt instalatora" icon="rocket" defaultOpen>
    Pobiera CLI, instaluje je globalnie przez npm i uruchamia kreator onboardingu.

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

    To wszystko — skrypt zajmuje się wykrywaniem Node, instalacją i onboardingiem.

    Aby pominąć onboarding i tylko zainstalować binarkę:

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

    Wszystkie flagi, zmienne środowiskowe oraz opcje CI/automatyzacji znajdziesz w [Wnętrzu instalatora](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Jeśli masz już Node 22+ i wolisz samodzielnie zarządzać instalacją:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="błędy budowania sharp?">
          Jeśli masz globalnie zainstalowane libvips (częste na macOS przez Homebrew) i `sharp` kończy się niepowodzeniem, wymuś prekompilowane binaria:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Jeśli zobaczysz `sharp: Please add node-gyp to your dependencies`, zainstaluj narzędzia do budowania (macOS: Xcode CLT + `npm install -g node-gyp`) albo użyj powyższej zmiennej środowiskowej.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm wymaga jawnej zgody dla pakietów ze skryptami budowania. Po pierwszej instalacji, gdy pojawi się ostrzeżenie „Ignored build scripts”, uruchom `pnpm approve-builds -g` i wybierz wymienione pakiety.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="Ze źródeł" icon="github">
    Dla współtwórców lub każdego, kto chce uruchamiać z lokalnego checkoutu.

    <Steps>
      <Step title="Klonowanie i budowanie">
        Sklonuj [repozytorium OpenClaw](https://github.com/openclaw/openclaw) i zbuduj:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Podlinkowanie CLI">
        Udostępnij polecenie `openclaw` globalnie:

        ```bash
        pnpm link --global
        ```

        Alternatywnie pomiń linkowanie i uruchamiaj polecenia przez `pnpm openclaw ...` z poziomu repozytorium.
      </Step>
      <Step title="Uruchom onboarding">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    Bardziej zaawansowane przepływy deweloperskie znajdziesz w [Konfiguracji](/start/setup).

  </Accordion>
</AccordionGroup>

## Inne metody instalacji

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Wdrożenia kontenerowe lub bez interfejsu.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Deklaratywna instalacja przez Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Zautomatyzowane wdrażanie floty.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Użycie wyłącznie CLI przez środowisko uruchomieniowe Bun.
  </Card>
</CardGroup>

## Po instalacji

Sprawdź, czy wszystko działa poprawnie:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Rozwiązywanie problemów: nie znaleziono `openclaw`

<Accordion title="Diagnoza i naprawa PATH">
  Szybka diagnoza:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Jeśli `$(npm prefix -g)/bin` (macOS/Linux) lub `$(npm prefix -g)` (Windows) **nie** znajduje się w Twoim `$PATH`, Twoja powłoka nie może znaleźć globalnych binariów npm (w tym `openclaw`).

Naprawa — dodaj to do pliku startowego powłoki (`~/.zshrc` lub `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

W systemie Windows dodaj wynik polecenia `npm prefix -g` do PATH.

Następnie otwórz nowy terminal (lub `rehash` w zsh / `hash -r` w bash).
</Accordion>

## Aktualizacja / odinstalowanie

<CardGroup cols={3}>
  <Card title="Aktualizacja" href="/install/updating" icon="refresh-cw">
    Utrzymuj OpenClaw na bieżąco.
  </Card>
  <Card title="Migracja" href="/install/migrating" icon="arrow-right">
    Przenieś się na nową maszynę.
  </Card>
  <Card title="Odinstalowanie" href="/install/uninstall" icon="trash-2">
    Całkowicie usuń OpenClaw.
  </Card>
</CardGroup>
