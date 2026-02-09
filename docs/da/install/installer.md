---
summary: "Hvordan installationsscripts fungerer (install.sh, install-cli.sh, install.ps1), flag og automatisering"
read_when:
  - Du vil forstå `openclaw.ai/install.sh`
  - Du vil automatisere installationer (CI / headless)
  - Du vil installere fra et GitHub-checkout
title: "Installerens indre"
---

# Installerens indre

OpenClaw leveres med tre installationsscripts, der serveres fra `openclaw.ai`.

| Script                             | Platform                                | Hvad det gør                                                                                                                                   |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | Installerer Node om nødvendigt, installerer OpenClaw via npm (standard) eller git og kan køre introduktion. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Installerer node + OpenClaw i et lokalt præfiks (`~/.openclaw`). Ingen rod påkrævet.        |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Installerer Node om nødvendigt, installerer OpenClaw via npm (standard) eller git og kan køre introduktion. |

## Hurtige kommandoer

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
Hvis installationen lykkes, men `openclaw` ikke findes i en ny terminal, se [Node.js-fejlfinding](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Anbefalet til de fleste interaktive installationer på macOS/Linux/WSL.
</Tip>

### Forløb (install.sh)

<Steps>
  <Step title="Detect OS">
    Understøtter macOS og Linux (herunder WSL). Hvis macOS opdages, installeres Homebrew, hvis det mangler.
  </Step>
  <Step title="Ensure Node.js 22+">
    Tjekker Node-versionen og installerer Node 22 om nødvendigt (Homebrew på macOS, NodeSource-opsætningsscripts på Linux apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    Installerer Git, hvis det mangler.
  </Step>
  <Step title="Install OpenClaw">
    - `npm`-metode (standard): global npm-installation
    - `git`-metode: klon/opdatér repo, installér afhængigheder med pnpm, byg, og installér derefter wrapper ved `~/.local/bin/openclaw`
  </Step>
  <Step title="Post-install tasks">
    - Kører `openclaw doctor --non-interactive` ved opgraderinger og git-installationer (best effort)
    - Forsøger introduktion, når det er passende (TTY tilgængelig, introduktion ikke deaktiveret, og bootstrap-/konfigurationstjek består)
    - Standarder `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Registrering af source-checkout

Hvis scriptet køres inde i et OpenClaw-checkout (`package.json` + `pnpm-workspace.yaml`), tilbyder scriptet:

- at bruge checkout (`git`), eller
- at bruge global installation (`npm`)

Hvis der ikke er nogen TTY tilgængelig, og der ikke er angivet en installationsmetode, standarder det til `npm` og advarer.

Scriptet afslutter med kode `2` ved ugyldigt metodevalg eller ugyldige `--install-method`-værdier.

### Eksempler (install.sh)

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

| Flag                              | Beskrivelse                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | Vælg installationsmetode (standard: `npm`). Alias: `--method` |
| `--npm`                           | Genvej til npm-metoden                                                                                                           |
| `--git`                           | Genvej for git metode. Alias: `--github`                                                         |
| `--version <version\\|dist-tag>` | npm-version eller dist-tag (standard: `latest`)                                               |
| `--beta`                          | Brug beta-dist-tag hvis tilgængelig, ellers fallback til `latest`                                                                |
| `--git-dir <path>`                | Checkout mappe (standard: `~/openclaw`). Alias: `--dir`       |
| `--no-git-update`                 | Spring `git pull` over for eksisterende checkout                                                                                 |
| `--no-prompt`                     | Deaktivér prompts                                                                                                                |
| `--no-onboard`                    | Spring introduktion over                                                                                                         |
| `--onboard`                       | Aktivér introduktion                                                                                                             |
| `--dry-run`                       | Udskriv handlinger uden at anvende ændringer                                                                                     |
| `--verbose`                       | Aktivér debug-output (`set -x`, npm-logs på notice-niveau)                                                    |
| `--help`                          | Vis brug (`-h`)                                                                                               |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variabel                                        | Beskrivelse                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | Installationsmetode                                                          |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | npm-version eller dist-tag                                                   |
| `OPENCLAW_BETA=0\\|1`                          | Brug beta hvis tilgængelig                                                   |
| `OPENCLAW_GIT_DIR=<path>`                       | Checkout-mappe                                                               |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | Slå git-opdateringer til/fra                                                 |
| `OPENCLAW_NO_PROMPT=1`                          | Deaktivér prompts                                                            |
| `OPENCLAW_NO_ONBOARD=1`                         | Spring introduktion over                                                     |
| `OPENCLAW_DRY_RUN=1`                            | Dry run-tilstand                                                             |
| `OPENCLAW_VERBOSE=1`                            | Debug-tilstand                                                               |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm-logniveau                                                                |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Styr sharp/libvips-adfærd (standard: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Designet til miljøer, hvor du vil have alt under et lokalt prefix (standard `~/.openclaw`) og ingen systemafhængighed af Node.
</Info>

### Forløb (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Downloader Node-tarball (standard `22.22.0`) til `<prefix>/tools/node-v<version>` og verificerer SHA-256.
  </Step>
  <Step title="Ensure Git">
    Hvis Git mangler, forsøges installation via apt/dnf/yum på Linux eller Homebrew på macOS.
  </Step>
  <Step title="Install OpenClaw under prefix">
    Installerer med npm ved brug af `--prefix <prefix>`, og skriver derefter wrapper til `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Eksempler (install-cli.sh)

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

| Flag                   | Beskrivelse                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Installationsprefix (standard: `~/.openclaw`)                            |
| `--version <ver>`      | OpenClaw-version eller dist-tag (standard: `latest`)                     |
| `--node-version <ver>` | Node-version (standard: `22.22.0`)                                       |
| `--json`               | Udsend NDJSON-hændelser                                                                                     |
| `--onboard`            | Kør `openclaw onboard` efter installation                                                                   |
| `--no-onboard`         | Spring introduktion over (standard)                                                      |
| `--set-npm-prefix`     | På Linux: tving npm-prefix til `~/.npm-global`, hvis det nuværende prefix ikke er skrivbart |
| `--help`               | Vis brug (`-h`)                                                                          |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variabel                                        | Beskrivelse                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | Installationsprefix                                                                                        |
| `OPENCLAW_VERSION=<ver>`                        | OpenClaw-version eller dist-tag                                                                            |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Node-version                                                                                               |
| `OPENCLAW_NO_ONBOARD=1`                         | Spring introduktion over                                                                                   |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm-logniveau                                                                                              |
| `OPENCLAW_GIT_DIR=<path>`                       | Ældre cleanup-opslagssti (bruges ved fjernelse af gammel `Peekaboo`-submodule-checkout) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Styr sharp/libvips-adfærd (standard: `1`)                               |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Forløb (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Kræver PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    Hvis det mangler, forsøges installation via winget, derefter Chocolatey og derefter Scoop.
  </Step>
  <Step title="Install OpenClaw">
    - `npm`-metode (standard): global npm-installation med valgt `-Tag`
    - `git`-metode: klon/opdatér repo, installér/byg med pnpm, og installér wrapper ved `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Post-install tasks">
    Tilføjer nødvendig bin-mappe til brugerens PATH, når det er muligt, og kører derefter `openclaw doctor --non-interactive` ved opgraderinger og git-installationer (best effort).
  </Step>
</Steps>

### Eksempler (install.ps1)

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

| Flag                        | Beskrivelse                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | Installationsmetode (standard: `npm`)                |
| `-Tag <tag>`                | npm dist-tag (standard: `latest`)                    |
| `-GitDir <path>`            | Checkout-mappe (standard: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | Spring introduktion over                                                                |
| `-NoGitUpdate`              | Spring `git pull` over                                                                  |
| `-DryRun`                   | Udskriv kun handlinger                                                                  |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variabel                             | Beskrivelse              |
| ------------------------------------ | ------------------------ |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | Installationsmetode      |
| `OPENCLAW_GIT_DIR=<path>`            | Checkout-mappe           |
| `OPENCLAW_NO_ONBOARD=1`              | Spring introduktion over |
| `OPENCLAW_GIT_UPDATE=0`              | Deaktivér git pull       |
| `OPENCLAW_DRY_RUN=1`                 | Dry run-tilstand         |

  </Accordion>
</AccordionGroup>

<Note>
Hvis `-InstallMethod git` bruges, og Git mangler, afslutter scriptet og udskriver linket til Git for Windows.
</Note>

---

## CI og automatisering

Brug ikke-interaktive flag/miljøvariabler for forudsigelige kørsler.

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

## Fejlfinding

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git er påkrævet for `git` installationsmetode. For `npm` installationer, Git stadig kontrolleret/installeret for at undgå `spawn git ENOENT` fejl når afhængigheder bruger git URL'er.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Nogle Linux opsætninger punkt npm globale præfiks til rodejede stier. `install.sh` kan skifte præfiks til `~/.npm-global` og tilføje PATH eksport til shell rc filer (når disse filer findes).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    De scripts standard `SHARP_IGNORE_GLOBAL_LIBVIPS=1` for at undgå skarp bygning mod system libvips. Til at tilsidesætte:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Installér Git for Windows, genåbn PowerShell, og genkør installationsprogrammet.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Kør `npm config get prefix`, tilføj `\bin`, føj den mappe til brugerens PATH, og genåbn derefter PowerShell.
  </Accordion>

  <Accordion title="openclaw not found after install">
    Normalt et PATH problem. Se [node.js fejlfinding](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
