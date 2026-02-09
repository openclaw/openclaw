---
summary: "Kung paano gumagana ang mga installer script (install.sh, install-cli.sh, install.ps1), mga flag, at automation"
read_when:
  - Gusto mong maunawaan ang `openclaw.ai/install.sh`
  - Gusto mong i-automate ang mga install (CI / headless)
  - Gusto mong mag-install mula sa isang GitHub checkout
title: "Mga Internal ng Installer"
---

# Mga internal ng installer

Nagpapadala ang OpenClaw ng tatlong installer script, na inihahain mula sa `openclaw.ai`.

| Script                             | Platform                                | Ano ang ginagawa                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | Nag-i-install ng Node kung kailangan, nag-i-install ng OpenClaw sa pamamagitan ng npm (default) o git, at maaaring magpatakbo ng onboarding.                         |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | 43. Ini-install ang Node + OpenClaw sa isang lokal na prefix (`~/.openclaw`). 44. Walang kinakailangang root. |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Nag-i-install ng Node kung kailangan, nag-i-install ng OpenClaw sa pamamagitan ng npm (default) o git, at maaaring magpatakbo ng onboarding.                         |

## Mga mabilis na command

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
Kung matagumpay ang install ngunit hindi makita ang `openclaw` sa isang bagong terminal, tingnan ang [Node.js troubleshooting](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Inirerekomenda para sa karamihan ng interactive na install sa macOS/Linux/WSL.
</Tip>

### Daloy (install.sh)

<Steps>
  <Step title="Detect OS">
    45. Sinusuportahan ang macOS at Linux (kasama ang WSL). Kung matukoy ang macOS, mag-iinstall ito ng Homebrew kung wala pa.
  </Step>
  <Step title="Ensure Node.js 22+">
    Sinusuri ang bersyon ng Node at nag-i-install ng Node 22 kung kailangan (Homebrew sa macOS, NodeSource setup scripts sa Linux apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    Nag-i-install ng Git kung wala.
  </Step>
  <Step title="Install OpenClaw">
    - `npm` na paraan (default): global npm install
    - `git` na paraan: i-clone/i-update ang repo, i-install ang deps gamit ang pnpm, i-build, at pagkatapos ay i-install ang wrapper sa `~/.local/bin/openclaw`
  </Step>
  <Step title="Post-install tasks">
    - Pinapatakbo ang `openclaw doctor --non-interactive` sa mga upgrade at git install (best effort)
    - Sinusubukang patakbuhin ang onboarding kapag naaangkop (may TTY, hindi naka-disable ang onboarding, at pumasa ang bootstrap/config checks)
    - Default na `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Pag-detect ng source checkout

Kung pinatakbo sa loob ng isang OpenClaw checkout (`package.json` + `pnpm-workspace.yaml`), inaalok ng script ang:

- gamitin ang checkout (`git`), o
- gamitin ang global install (`npm`)

Kung walang available na TTY at walang nakatakdang install method, magde-default ito sa `npm` at magbibigay ng babala.

Lumalabas ang script na may code na `2` para sa hindi wastong pagpili ng paraan o hindi wastong mga halaga ng `--install-method`.

### Mga halimbawa (install.sh)

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

| Flag                              | Paglalarawan                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | Pumili ng paraan ng pag-install (default: `npm`). Alias: `--method` |
| `--npm`                           | Shortcut para sa npm na paraan                                                                                                         |
| `--git`                           | 49. Shortcut para sa git method. Alias: `--github`                              |
| `--version <version\\|dist-tag>` | Bersyon ng npm o dist-tag (default: `latest`)                                                       |
| `--beta`                          | Gamitin ang beta dist-tag kung available, kung hindi ay fallback sa `latest`                                                           |
| `--git-dir <path>`                | Checkout na direktoryo (default: `~/openclaw`). Alias: `--dir`      |
| `--no-git-update`                 | Laktawan ang `git pull` para sa umiiral na checkout                                                                                    |
| `--no-prompt`                     | I-disable ang mga prompt                                                                                                               |
| `--no-onboard`                    | Laktawan ang onboarding                                                                                                                |
| `--onboard`                       | I-enable ang onboarding                                                                                                                |
| `--dry-run`                       | I-print ang mga aksyon nang hindi naglalapat ng mga pagbabago                                                                          |
| `--verbose`                       | I-enable ang debug output (`set -x`, npm notice-level logs)                                                         |
| `--help`                          | Ipakita ang paggamit (`-h`)                                                                                         |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | Paglalarawan                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | Paraan ng install                                                                     |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | Bersyon ng npm o dist-tag                                                             |
| `OPENCLAW_BETA=0\\|1`                          | Gamitin ang beta kung available                                                       |
| `OPENCLAW_GIT_DIR=<path>`                       | Direktoryo ng checkout                                                                |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | I-toggle ang mga git update                                                           |
| `OPENCLAW_NO_PROMPT=1`                          | I-disable ang mga prompt                                                              |
| `OPENCLAW_NO_ONBOARD=1`                         | Laktawan ang onboarding                                                               |
| `OPENCLAW_DRY_RUN=1`                            | Dry run mode                                                                          |
| `OPENCLAW_VERBOSE=1`                            | Debug mode                                                                            |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Antas ng npm log                                                                      |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Kontrolin ang gawi ng sharp/libvips (default: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Dinisenyo para sa mga environment kung saan gusto mong nasa ilalim ng isang local prefix ang lahat (default `~/.openclaw`) at walang system Node dependency.
</Info>

### Daloy (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Dina-download ang Node tarball (default `22.22.0`) sa `<prefix>/tools/node-v<version>` at sine-verify ang SHA-256.
  </Step>
  <Step title="Ensure Git">
    Kung wala ang Git, sinusubukang mag-install sa pamamagitan ng apt/dnf/yum sa Linux o Homebrew sa macOS.
  </Step>
  <Step title="Install OpenClaw under prefix">
    Nag-i-install gamit ang npm gamit ang `--prefix <prefix>`, pagkatapos ay nagsusulat ng wrapper sa `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Mga halimbawa (install-cli.sh)

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

| Flag                   | Paglalarawan                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Install prefix (default: `~/.openclaw`)                      |
| `--version <ver>`      | Bersyon ng OpenClaw o dist-tag (default: `latest`)           |
| `--node-version <ver>` | Bersyon ng Node (default: `22.22.0`)                         |
| `--json`               | Maglabas ng NDJSON events                                                                       |
| `--onboard`            | Patakbuhin ang `openclaw onboard` pagkatapos ng install                                         |
| `--no-onboard`         | Laktawan ang onboarding (default)                                            |
| `--set-npm-prefix`     | Sa Linux, pilitin ang npm prefix sa `~/.npm-global` kung hindi writable ang kasalukuyang prefix |
| `--help`               | Ipakita ang paggamit (`-h`)                                                  |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | Paglalarawan                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | Install prefix                                                                                                   |
| `OPENCLAW_VERSION=<ver>`                        | Bersyon ng OpenClaw o dist-tag                                                                                   |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Bersyon ng Node                                                                                                  |
| `OPENCLAW_NO_ONBOARD=1`                         | Laktawan ang onboarding                                                                                          |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Antas ng npm log                                                                                                 |
| `OPENCLAW_GIT_DIR=<path>`                       | Legacy cleanup lookup path (ginagamit kapag inaalis ang lumang `Peekaboo` submodule checkout) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Kontrolin ang gawi ng sharp/libvips (default: `1`)                            |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Daloy (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Nangangailangan ng PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    Kung wala, sinusubukang mag-install sa pamamagitan ng winget, pagkatapos ay Chocolatey, pagkatapos ay Scoop.
  </Step>
  <Step title="Install OpenClaw">
    - `npm` na paraan (default): global npm install gamit ang napiling `-Tag`
    - `git` na paraan: i-clone/i-update ang repo, mag-install/mag-build gamit ang pnpm, at i-install ang wrapper sa `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Post-install tasks">
    Idinadagdag ang kinakailangang bin directory sa user PATH kapag posible, pagkatapos ay pinapatakbo ang `openclaw doctor --non-interactive` sa mga upgrade at git install (best effort).
  </Step>
</Steps>

### Mga halimbawa (install.ps1)

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

| Flag                        | Paglalarawan                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | Paraan ng install (default: `npm`)                          |
| `-Tag <tag>`                | npm dist-tag (default: `latest`)                            |
| `-GitDir <path>`            | Direktoryo ng checkout (default: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | Laktawan ang onboarding                                                                        |
| `-NoGitUpdate`              | Laktawan ang `git pull`                                                                        |
| `-DryRun`                   | I-print lamang ang mga aksyon                                                                  |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                             | Paglalarawan            |
| ------------------------------------ | ----------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | Paraan ng install       |
| `OPENCLAW_GIT_DIR=<path>`            | Direktoryo ng checkout  |
| `OPENCLAW_NO_ONBOARD=1`              | Laktawan ang onboarding |
| `OPENCLAW_GIT_UPDATE=0`              | I-disable ang git pull  |
| `OPENCLAW_DRY_RUN=1`                 | Dry run mode            |

  </Accordion>
</AccordionGroup>

<Note>
Kung ginamit ang `-InstallMethod git` at wala ang Git, lalabas ang script at ipi-print ang link ng Git for Windows.
</Note>

---

## CI at automation

Gumamit ng mga non-interactive na flag/env vars para sa predictable na mga run.

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

## Pag-troubleshoot

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Kailangan ang Git para sa `git` na paraan ng pag-install. Para sa mga `npm` install, chine-check/ini-install pa rin ang Git upang maiwasan ang `spawn git ENOENT` na mga failure kapag gumagamit ang dependencies ng mga git URL.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    May ilang Linux setup na itinuturo ang npm global prefix sa mga path na pagmamay-ari ng root. Maaaring ilipat ng `install.sh` ang prefix sa `~/.npm-global` at magdagdag ng PATH exports sa mga shell rc file (kapag umiiral ang mga file na iyon).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    Default na sine-set ng mga script ang `SHARP_IGNORE_GLOBAL_LIBVIPS=1` upang maiwasan ang pag-build ng sharp laban sa system libvips. Upang i-override:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    I-install ang Git for Windows, muling buksan ang PowerShell, at muling patakbuhin ang installer.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Patakbuhin ang `npm config get prefix`, idagdag ang `\bin`, idagdag ang direktoryong iyon sa user PATH, pagkatapos ay muling buksan ang PowerShell.
  </Accordion>

  <Accordion title="openclaw not found after install">
    Karaniwan itong isyu sa PATH. Tingnan ang [Node.js troubleshooting](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
