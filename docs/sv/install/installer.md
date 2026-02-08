---
summary: "Hur installationsskripten fungerar (install.sh, install-cli.sh, install.ps1), flaggor och automatisering"
read_when:
  - Du vill förstå `openclaw.ai/install.sh`
  - Du vill automatisera installationer (CI / headless)
  - Du vill installera från en GitHub-checkout
title: "Installationsprogrammens internals"
x-i18n:
  source_path: install/installer.md
  source_hash: 8517f9cf8e237b62
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:59Z
---

# Installationsprogrammens internals

OpenClaw levereras med tre installationsskript som tillhandahålls från `openclaw.ai`.

| Skript                             | Plattform            | Vad det gör                                                                                              |
| ---------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | Installerar Node vid behov, installerar OpenClaw via npm (standard) eller git och kan köra introduktion. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Installerar Node + OpenClaw till ett lokalt prefix (`~/.openclaw`). Ingen root krävs.                    |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Installerar Node vid behov, installerar OpenClaw via npm (standard) eller git och kan köra introduktion. |

## Snabba kommandon

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
Om installationen lyckas men `openclaw` inte hittas i en ny terminal, se [Node.js-felsökning](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Rekommenderas för de flesta interaktiva installationer på macOS/Linux/WSL.
</Tip>

### Flöde (install.sh)

<Steps>
  <Step title="Identifiera OS">
    Stöder macOS och Linux (inklusive WSL). Om macOS upptäcks installeras Homebrew om det saknas.
  </Step>
  <Step title="Säkerställ Node.js 22+">
    Kontrollerar Node-versionen och installerar Node 22 vid behov (Homebrew på macOS, NodeSource-installationsskript på Linux apt/dnf/yum).
  </Step>
  <Step title="Säkerställ Git">
    Installerar Git om det saknas.
  </Step>
  <Step title="Installera OpenClaw">
    - `npm`-metod (standard): global npm-installation
    - `git`-metod: klona/uppdatera repo, installera beroenden med pnpm, bygg och installera sedan wrapper i `~/.local/bin/openclaw`
  </Step>
  <Step title="Efterinstallationsuppgifter">
    - Kör `openclaw doctor --non-interactive` vid uppgraderingar och git-installationer (best effort)
    - Försöker köra introduktion när det är lämpligt (TTY tillgänglig, introduktion inte inaktiverad och bootstrap-/konfigkontroller passerar)
    - Standardvärde `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Detektering av källcheckout

Om skriptet körs inuti en OpenClaw-checkout (`package.json` + `pnpm-workspace.yaml`), erbjuder skriptet:

- använd checkout (`git`), eller
- använd global installation (`npm`)

Om ingen TTY är tillgänglig och ingen installationsmetod är satt, används som standard `npm` och en varning visas.

Skriptet avslutas med kod `2` vid ogiltigt metodval eller ogiltiga värden för `--install-method`.

### Exempel (install.sh)

<Tabs>
  <Tab title="Standard">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Hoppa över introduktion">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git-installation">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Torrkörning">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Referens för flaggor">

| Flagga                          | Beskrivning                                                        |
| ------------------------------- | ------------------------------------------------------------------ |
| `--install-method npm\|git`     | Välj installationsmetod (standard: `npm`). Alias: `--method`       |
| `--npm`                         | Genväg för npm-metoden                                             |
| `--git`                         | Genväg för git-metoden. Alias: `--github`                          |
| `--version <version\|dist-tag>` | npm-version eller dist-tag (standard: `latest`)                    |
| `--beta`                        | Använd beta dist-tag om tillgänglig, annars fallback till `latest` |
| `--git-dir <path>`              | Checkout-katalog (standard: `~/openclaw`). Alias: `--dir`          |
| `--no-git-update`               | Hoppa över `git pull` för befintlig checkout                       |
| `--no-prompt`                   | Inaktivera frågor                                                  |
| `--no-onboard`                  | Hoppa över introduktion                                            |
| `--onboard`                     | Aktivera introduktion                                              |
| `--dry-run`                     | Skriv ut åtgärder utan att tillämpa ändringar                      |
| `--verbose`                     | Aktivera debug-utdata (`set -x`, npm-logger på notice-nivå)        |
| `--help`                        | Visa användning (`-h`)                                             |

  </Accordion>

  <Accordion title="Referens för miljövariabler">

| Variabel                                    | Beskrivning                                 |
| ------------------------------------------- | ------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | Installationsmetod                          |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | npm-version eller dist-tag                  |
| `OPENCLAW_BETA=0\|1`                        | Använd beta om tillgänglig                  |
| `OPENCLAW_GIT_DIR=<path>`                   | Checkout-katalog                            |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | Växla git-uppdateringar                     |
| `OPENCLAW_NO_PROMPT=1`                      | Inaktivera frågor                           |
| `OPENCLAW_NO_ONBOARD=1`                     | Hoppa över introduktion                     |
| `OPENCLAW_DRY_RUN=1`                        | Torrkörningsläge                            |
| `OPENCLAW_VERBOSE=1`                        | Debug-läge                                  |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm-loggnivå                                |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Styr sharp/libvips-beteende (standard: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Utformad för miljöer där du vill ha allt under ett lokalt prefix (standard `~/.openclaw`) och inget systemberoende av Node.
</Info>

### Flöde (install-cli.sh)

<Steps>
  <Step title="Installera lokal Node-runtime">
    Laddar ner Node-tarball (standard `22.22.0`) till `<prefix>/tools/node-v<version>` och verifierar SHA-256.
  </Step>
  <Step title="Säkerställ Git">
    Om Git saknas försöker den installera via apt/dnf/yum på Linux eller Homebrew på macOS.
  </Step>
  <Step title="Installera OpenClaw under prefix">
    Installerar med npm med `--prefix <prefix>`, och skriver sedan wrapper till `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Exempel (install-cli.sh)

<Tabs>
  <Tab title="Standard">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Anpassat prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automatisering – JSON-utdata">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Kör introduktion">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Referens för flaggor">

| Flagga                 | Beskrivning                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Installationsprefix (standard: `~/.openclaw`)                                          |
| `--version <ver>`      | OpenClaw-version eller dist-tag (standard: `latest`)                                   |
| `--node-version <ver>` | Node-version (standard: `22.22.0`)                                                     |
| `--json`               | Emittera NDJSON-händelser                                                              |
| `--onboard`            | Kör `openclaw onboard` efter installation                                              |
| `--no-onboard`         | Hoppa över introduktion (standard)                                                     |
| `--set-npm-prefix`     | På Linux, tvinga npm-prefix till `~/.npm-global` om nuvarande prefix inte är skrivbart |
| `--help`               | Visa användning (`-h`)                                                                 |

  </Accordion>

  <Accordion title="Referens för miljövariabler">

| Variabel                                    | Beskrivning                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | Installationsprefix                                                                     |
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw-version eller dist-tag                                                         |
| `OPENCLAW_NODE_VERSION=<ver>`               | Node-version                                                                            |
| `OPENCLAW_NO_ONBOARD=1`                     | Hoppa över introduktion                                                                 |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm-loggnivå                                                                            |
| `OPENCLAW_GIT_DIR=<path>`                   | Äldre rensningssökväg (används vid borttagning av gammal `Peekaboo`-submodule-checkout) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Styr sharp/libvips-beteende (standard: `1`)                                             |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Flöde (install.ps1)

<Steps>
  <Step title="Säkerställ PowerShell + Windows-miljö">
    Kräver PowerShell 5+.
  </Step>
  <Step title="Säkerställ Node.js 22+">
    Om det saknas försöker den installera via winget, därefter Chocolatey och sedan Scoop.
  </Step>
  <Step title="Installera OpenClaw">
    - `npm`-metod (standard): global npm-installation med vald `-Tag`
    - `git`-metod: klona/uppdatera repo, installera/bygga med pnpm och installera wrapper i `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Efterinstallationsuppgifter">
    Lägger till nödvändig bin-katalog i användarens PATH när möjligt och kör sedan `openclaw doctor --non-interactive` vid uppgraderingar och git-installationer (best effort).
  </Step>
</Steps>

### Exempel (install.ps1)

<Tabs>
  <Tab title="Standard">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git-installation">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Anpassad git-katalog">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Torrkörning">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Referens för flaggor">

| Flagga                    | Beskrivning                                           |
| ------------------------- | ----------------------------------------------------- |
| `-InstallMethod npm\|git` | Installationsmetod (standard: `npm`)                  |
| `-Tag <tag>`              | npm dist-tag (standard: `latest`)                     |
| `-GitDir <path>`          | Checkout-katalog (standard: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`              | Hoppa över introduktion                               |
| `-NoGitUpdate`            | Hoppa över `git pull`                                 |
| `-DryRun`                 | Skriv endast ut åtgärder                              |

  </Accordion>

  <Accordion title="Referens för miljövariabler">

| Variabel                           | Beskrivning             |
| ---------------------------------- | ----------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | Installationsmetod      |
| `OPENCLAW_GIT_DIR=<path>`          | Checkout-katalog        |
| `OPENCLAW_NO_ONBOARD=1`            | Hoppa över introduktion |
| `OPENCLAW_GIT_UPDATE=0`            | Inaktivera git pull     |
| `OPENCLAW_DRY_RUN=1`               | Torrkörningsläge        |

  </Accordion>
</AccordionGroup>

<Note>
Om `-InstallMethod git` används och Git saknas avslutas skriptet och skriver ut länken till Git for Windows.
</Note>

---

## CI och automatisering

Använd icke-interaktiva flaggor/miljövariabler för förutsägbara körningar.

<Tabs>
  <Tab title="install.sh (icke-interaktiv npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (icke-interaktiv git)">
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
  <Tab title="install.ps1 (hoppa över introduktion)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Felsökning

<AccordionGroup>
  <Accordion title="Varför krävs Git?">
    Git krävs för installationsmetoden `git`. För `npm`-installationer kontrolleras/installeras Git fortfarande för att undvika `spawn git ENOENT`-fel när beroenden använder git-URL:er.
  </Accordion>

  <Accordion title="Varför får npm EACCES på Linux?">
    Vissa Linux-konfigurationer pekar npm:s globala prefix till root-ägda sökvägar. `install.sh` kan byta prefix till `~/.npm-global` och lägga till PATH-exporter i shell-rc-filer (när dessa filer finns).
  </Accordion>

  <Accordion title="Problem med sharp/libvips">
    Skripten använder som standard `SHARP_IGNORE_GLOBAL_LIBVIPS=1` för att undvika att sharp bygger mot systemets libvips. För att åsidosätta:

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Installera Git for Windows, öppna PowerShell igen och kör installationsprogrammet på nytt.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Kör `npm config get prefix`, lägg till `\bin`, lägg till den katalogen i användarens PATH och öppna sedan PowerShell igen.
  </Accordion>

  <Accordion title="openclaw hittas inte efter installation">
    Oftast ett PATH-problem. Se [Node.js-felsökning](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
