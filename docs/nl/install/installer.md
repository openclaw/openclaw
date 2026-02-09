---
summary: "Hoe de installerscripts werken (install.sh, install-cli.sh, install.ps1), flags en automatisering"
read_when:
  - Je wilt begrijpen hoe `openclaw.ai/install.sh` werkt
  - Je wilt installaties automatiseren (CI / headless)
  - Je wilt installeren vanuit een GitHub-checkout
title: "Installer-interne werking"
---

# Installer-interne werking

OpenClaw levert drie installerscripts, geserveerd vanaf `openclaw.ai`.

| Script                             | Platform                                | Wat het doet                                                                                                                                    |
| ---------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | Installeert Node indien nodig, installeert OpenClaw via npm (standaard) of git, en kan onboarding uitvoeren. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Installeert Node + OpenClaw in een lokaal prefix (`~/.openclaw`). Geen root vereist.         |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Installeert Node indien nodig, installeert OpenClaw via npm (standaard) of git, en kan onboarding uitvoeren. |

## Snelle opdrachten

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

<Note>
Als de installatie slaagt maar `openclaw` niet wordt gevonden in een nieuwe terminal, zie [Node.js troubleshooting](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Aanbevolen voor de meeste interactieve installaties op macOS/Linux/WSL.
</Tip>

### Verloop (install.sh)

<Steps>
  <Step title="Detect OS">
    Ondersteunt macOS en Linux (inclusief WSL). Als macOS wordt gedetecteerd, wordt Homebrew geïnstalleerd als het ontbreekt.
  </Step>
  <Step title="Ensure Node.js 22+">
    Controleert de Node-versie en installeert Node 22 indien nodig (Homebrew op macOS, NodeSource-setup scripts op Linux apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    Installeert Git als het ontbreekt.
  </Step>
  <Step title="Install OpenClaw">
    - `npm`-methode (standaard): globale npm-installatie
    - `git`-methode: repo klonen/bijwerken, dependencies installeren met pnpm, bouwen en vervolgens de wrapper installeren op `~/.local/bin/openclaw`
  </Step>
  <Step title="Post-install tasks">
    - Voert `openclaw doctor --non-interactive` uit bij upgrades en git-installaties (best effort)
    - Probeert onboarding uit te voeren wanneer passend (TTY beschikbaar, onboarding niet uitgeschakeld en bootstrap/config-controles geslaagd)
    - Standaard `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Detectie van source checkout

Als het script wordt uitgevoerd binnen een OpenClaw-checkout (`package.json` + `pnpm-workspace.yaml`), biedt het script aan om:

- de checkout te gebruiken (`git`), of
- een globale installatie te gebruiken (`npm`)

Als er geen TTY beschikbaar is en er geen installatiemethode is ingesteld, wordt standaard `npm` gebruikt en wordt een waarschuwing getoond.

Het script eindigt met exitcode `2` bij een ongeldige methodekeuze of ongeldige `--install-method`-waarden.

### Voorbeelden (install.sh)

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

| Flag                              | Beschrijving                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | Kies installatiemethode (standaard: `npm`). Alias: `--method` |
| `--npm`                           | Snelkoppeling voor npm-methode                                                                                                   |
| `--git`                           | Snelkoppeling voor git-methode. Alias: `--github`                                                |
| `--version <version\\|dist-tag>` | npm-versie of dist-tag (standaard: `latest`)                                                  |
| `--beta`                          | Gebruik beta dist-tag indien beschikbaar, anders terugvallen op `latest`                                                         |
| `--git-dir <path>`                | Checkout-directory (standaard: `~/openclaw`). Alias: `--dir`  |
| `--no-git-update`                 | `git pull` overslaan voor bestaande checkout                                                                                     |
| `--no-prompt`                     | Prompts uitschakelen                                                                                                             |
| `--no-onboard`                    | Onboarding overslaan                                                                                                             |
| `--onboard`                       | Onboarding inschakelen                                                                                                           |
| `--dry-run`                       | Acties afdrukken zonder wijzigingen toe te passen                                                                                |
| `--verbose`                       | Debug-uitvoer inschakelen (`set -x`, npm notice-level logs)                                                   |
| `--help`                          | Gebruik tonen (`-h`)                                                                                          |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variabele                                       | Beschrijving                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | Installatiemethode                                                                   |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | npm-versie of dist-tag                                                               |
| `OPENCLAW_BETA=0\\|1`                          | Beta gebruiken indien beschikbaar                                                    |
| `OPENCLAW_GIT_DIR=<path>`                       | Checkout-directory                                                                   |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | Git-updates schakelen                                                                |
| `OPENCLAW_NO_PROMPT=1`                          | Prompts uitschakelen                                                                 |
| `OPENCLAW_NO_ONBOARD=1`                         | Onboarding overslaan                                                                 |
| `OPENCLAW_DRY_RUN=1`                            | Dry run-modus                                                                        |
| `OPENCLAW_VERBOSE=1`                            | Debugmodus                                                                           |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm-logniveau                                                                        |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Gedrag van sharp/libvips bepalen (standaard: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Ontworpen voor omgevingen waar je alles onder een lokaal prefix wilt hebben (standaard `~/.openclaw`) en geen systeem-Node-afhankelijkheid.
</Info>

### Verloop (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Downloadt Node-tarball (standaard `22.22.0`) naar `<prefix>/tools/node-v<version>` en verifieert SHA-256.
  </Step>
  <Step title="Ensure Git">
    Als Git ontbreekt, probeert het te installeren via apt/dnf/yum op Linux of Homebrew op macOS.
  </Step>
  <Step title="Install OpenClaw under prefix">
    Installeert met npm via `--prefix <prefix>` en schrijft vervolgens de wrapper naar `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Voorbeelden (install-cli.sh)

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

| Flag                   | Beschrijving                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Installatieprefix (standaard: `~/.openclaw`)                                 |
| `--version <ver>`      | OpenClaw-versie of dist-tag (standaard: `latest`)                            |
| `--node-version <ver>` | Node-versie (standaard: `22.22.0`)                                           |
| `--json`               | NDJSON-events genereren                                                                                         |
| `--onboard`            | `openclaw onboard` uitvoeren na installatie                                                                     |
| `--no-onboard`         | Onboarding overslaan (standaard)                                                             |
| `--set-npm-prefix`     | Op Linux: npm-prefix forceren naar `~/.npm-global` als het huidige prefix niet beschrijfbaar is |
| `--help`               | Gebruik tonen (`-h`)                                                                         |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variabele                                       | Beschrijving                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | Installatieprefix                                                                                               |
| `OPENCLAW_VERSION=<ver>`                        | OpenClaw-versie of dist-tag                                                                                     |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Node-versie                                                                                                     |
| `OPENCLAW_NO_ONBOARD=1`                         | Onboarding overslaan                                                                                            |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm-logniveau                                                                                                   |
| `OPENCLAW_GIT_DIR=<path>`                       | Legacy cleanup-zoekpad (gebruikt bij het verwijderen van oude `Peekaboo` submodule-checkout) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Gedrag van sharp/libvips bepalen (standaard: `1`)                            |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Verloop (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Vereist PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    Als het ontbreekt, probeert het te installeren via winget, daarna Chocolatey en vervolgens Scoop.
  </Step>
  <Step title="Install OpenClaw">
    - `npm`-methode (standaard): globale npm-installatie met geselecteerde `-Tag`
    - `git`-methode: repo klonen/bijwerken, installeren/bouwen met pnpm en de wrapper installeren op `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Post-install tasks">
    Voegt waar mogelijk de benodigde bin-directory toe aan de gebruikers-PATH en voert vervolgens `openclaw doctor --non-interactive` uit bij upgrades en git-installaties (best effort).
  </Step>
</Steps>

### Voorbeelden (install.ps1)

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

| Flag                        | Beschrijving                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | Installatiemethode (standaard: `npm`)                     |
| `-Tag <tag>`                | npm dist-tag (standaard: `latest`)                        |
| `-GitDir <path>`            | Checkout-directory (standaard: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | Onboarding overslaan                                                                         |
| `-NoGitUpdate`              | `git pull` overslaan                                                                         |
| `-DryRun`                   | Alleen acties afdrukken                                                                      |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variabele                            | Beschrijving          |
| ------------------------------------ | --------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | Installatiemethode    |
| `OPENCLAW_GIT_DIR=<path>`            | Checkout-directory    |
| `OPENCLAW_NO_ONBOARD=1`              | Onboarding overslaan  |
| `OPENCLAW_GIT_UPDATE=0`              | Git pull uitschakelen |
| `OPENCLAW_DRY_RUN=1`                 | Dry run-modus         |

  </Accordion>
</AccordionGroup>

<Note>
Als `-InstallMethod git` wordt gebruikt en Git ontbreekt, stopt het script en wordt de Git for Windows-link weergegeven.
</Note>

---

## CI en automatisering

Gebruik niet-interactieve flags/omgevingsvariabelen voor voorspelbare runs.

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

## Problemen oplossen

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git is vereist voor de `git`-installatiemethode. Voor `npm`-installaties wordt Git nog steeds gecontroleerd/geïnstalleerd om `spawn git ENOENT`-fouten te voorkomen wanneer dependencies git-URL's gebruiken.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Sommige Linux-configuraties wijzen het npm globale prefix toe aan paden die eigendom zijn van root. `install.sh` kan het prefix wijzigen naar `~/.npm-global` en PATH-exports toevoegen aan shell rc-bestanden (wanneer die bestanden bestaan).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    De scripts stellen standaard `SHARP_IGNORE_GLOBAL_LIBVIPS=1` in om te voorkomen dat sharp tegen de systeem-libvips bouwt. Om te overschrijven:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Installeer Git for Windows, heropen PowerShell en voer de installer opnieuw uit.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Voer `npm config get prefix` uit, voeg `\bin` toe, voeg die directory toe aan de gebruikers-PATH en heropen vervolgens PowerShell.
  </Accordion>

  <Accordion title="openclaw not found after install">
    Meestal een PATH-probleem. Zie [Node.js troubleshooting](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
