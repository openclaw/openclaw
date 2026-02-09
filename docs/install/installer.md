---
summary: "How the installer scripts work (install.sh, install-cli.sh, install.ps1), flags, and automation"
read_when:
  - You want to understand `EasyHub.ai/install.sh`
  - You want to automate installs (CI / headless)
  - You want to install from a GitHub checkout
title: "Installer Internals"
---

# Installer internals

EasyHub ships three installer scripts, served from `EasyHub.ai`.

| Script                             | Platform             | What it does                                                                                 |
| ---------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | Installs Node if needed, installs EasyHub via npm (default) or git, and can run onboarding. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Installs Node + EasyHub into a local prefix (`~/.easyhub`). No root required.              |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Installs Node if needed, installs EasyHub via npm (default) or git, and can run onboarding. |

## Quick commands

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install-cli.sh | bash
    ```

    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install-cli.sh | bash -s -- --help
    ```

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://EasyHub.ai/install.ps1 | iex
    ```

    ```powershell
    & ([scriptblock]::Create((iwr -useb https://EasyHub.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```

  </Tab>
</Tabs>

<Note>
If install succeeds but `EasyHub` is not found in a new terminal, see [Node.js troubleshooting](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Recommended for most interactive installs on macOS/Linux/WSL.
</Tip>

### Flow (install.sh)

<Steps>
  <Step title="Detect OS">
    Supports macOS and Linux (including WSL). If macOS is detected, installs Homebrew if missing.
  </Step>
  <Step title="Ensure Node.js 22+">
    Checks Node version and installs Node 22 if needed (Homebrew on macOS, NodeSource setup scripts on Linux apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    Installs Git if missing.
  </Step>
  <Step title="Install EasyHub">
    - `npm` method (default): global npm install
    - `git` method: clone/update repo, install deps with pnpm, build, then install wrapper at `~/.local/bin/EasyHub`
  </Step>
  <Step title="Post-install tasks">
    - Runs `EasyHub doctor --non-interactive` on upgrades and git installs (best effort)
    - Attempts onboarding when appropriate (TTY available, onboarding not disabled, and bootstrap/config checks pass)
    - Defaults `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Source checkout detection

If run inside an EasyHub checkout (`package.json` + `pnpm-workspace.yaml`), the script offers:

- use checkout (`git`), or
- use global install (`npm`)

If no TTY is available and no install method is set, it defaults to `npm` and warns.

The script exits with code `2` for invalid method selection or invalid `--install-method` values.

### Examples (install.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                            | Description                                                |
| ------------------------------- | ---------------------------------------------------------- |
| `--install-method npm\|git`     | Choose install method (default: `npm`). Alias: `--method`  |
| `--npm`                         | Shortcut for npm method                                    |
| `--git`                         | Shortcut for git method. Alias: `--github`                 |
| `--version <version\|dist-tag>` | npm version or dist-tag (default: `latest`)                |
| `--beta`                        | Use beta dist-tag if available, else fallback to `latest`  |
| `--git-dir <path>`              | Checkout directory (default: `~/EasyHub`). Alias: `--dir` |
| `--no-git-update`               | Skip `git pull` for existing checkout                      |
| `--no-prompt`                   | Disable prompts                                            |
| `--no-onboard`                  | Skip onboarding                                            |
| `--onboard`                     | Enable onboarding                                          |
| `--dry-run`                     | Print actions without applying changes                     |
| `--verbose`                     | Enable debug output (`set -x`, npm notice-level logs)      |
| `--help`                        | Show usage (`-h`)                                          |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                    | Description                                   |
| ------------------------------------------- | --------------------------------------------- |
| `EASYHUB_INSTALL_METHOD=git\|npm`          | Install method                                |
| `EASYHUB_VERSION=latest\|next\|<semver>`   | npm version or dist-tag                       |
| `EASYHUB_BETA=0\|1`                        | Use beta if available                         |
| `EASYHUB_GIT_DIR=<path>`                   | Checkout directory                            |
| `EASYHUB_GIT_UPDATE=0\|1`                  | Toggle git updates                            |
| `EASYHUB_NO_PROMPT=1`                      | Disable prompts                               |
| `EASYHUB_NO_ONBOARD=1`                     | Skip onboarding                               |
| `EASYHUB_DRY_RUN=1`                        | Dry run mode                                  |
| `EASYHUB_VERBOSE=1`                        | Debug mode                                    |
| `EASYHUB_NPM_LOGLEVEL=error\|warn\|notice` | npm log level                                 |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Control sharp/libvips behavior (default: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Designed for environments where you want everything under a local prefix (default `~/.easyhub`) and no system Node dependency.
</Info>

### Flow (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Downloads Node tarball (default `22.22.0`) to `<prefix>/tools/node-v<version>` and verifies SHA-256.
  </Step>
  <Step title="Ensure Git">
    If Git is missing, attempts install via apt/dnf/yum on Linux or Homebrew on macOS.
  </Step>
  <Step title="Install EasyHub under prefix">
    Installs with npm using `--prefix <prefix>`, then writes wrapper to `<prefix>/bin/EasyHub`.
  </Step>
</Steps>

### Examples (install-cli.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install-cli.sh | bash -s -- --prefix /opt/EasyHub --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install-cli.sh | bash -s -- --json --prefix /opt/EasyHub
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                   | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `--prefix <path>`      | Install prefix (default: `~/.easyhub`)                                         |
| `--version <ver>`      | EasyHub version or dist-tag (default: `latest`)                                |
| `--node-version <ver>` | Node version (default: `22.22.0`)                                               |
| `--json`               | Emit NDJSON events                                                              |
| `--onboard`            | Run `EasyHub onboard` after install                                            |
| `--no-onboard`         | Skip onboarding (default)                                                       |
| `--set-npm-prefix`     | On Linux, force npm prefix to `~/.npm-global` if current prefix is not writable |
| `--help`               | Show usage (`-h`)                                                               |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                    | Description                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `EASYHUB_PREFIX=<path>`                    | Install prefix                                                                    |
| `EASYHUB_VERSION=<ver>`                    | EasyHub version or dist-tag                                                      |
| `EASYHUB_NODE_VERSION=<ver>`               | Node version                                                                      |
| `EASYHUB_NO_ONBOARD=1`                     | Skip onboarding                                                                   |
| `EASYHUB_NPM_LOGLEVEL=error\|warn\|notice` | npm log level                                                                     |
| `EASYHUB_GIT_DIR=<path>`                   | Legacy cleanup lookup path (used when removing old `Peekaboo` submodule checkout) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Control sharp/libvips behavior (default: `1`)                                     |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Flow (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Requires PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    If missing, attempts install via winget, then Chocolatey, then Scoop.
  </Step>
  <Step title="Install EasyHub">
    - `npm` method (default): global npm install using selected `-Tag`
    - `git` method: clone/update repo, install/build with pnpm, and install wrapper at `%USERPROFILE%\.local\bin\EasyHub.cmd`
  </Step>
  <Step title="Post-install tasks">
    Adds needed bin directory to user PATH when possible, then runs `EasyHub doctor --non-interactive` on upgrades and git installs (best effort).
  </Step>
</Steps>

### Examples (install.ps1)

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://EasyHub.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://EasyHub.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://EasyHub.ai/install.ps1))) -InstallMethod git -GitDir "C:\EasyHub"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://EasyHub.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                      | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `-InstallMethod npm\|git` | Install method (default: `npm`)                        |
| `-Tag <tag>`              | npm dist-tag (default: `latest`)                       |
| `-GitDir <path>`          | Checkout directory (default: `%USERPROFILE%\EasyHub`) |
| `-NoOnboard`              | Skip onboarding                                        |
| `-NoGitUpdate`            | Skip `git pull`                                        |
| `-DryRun`                 | Print actions only                                     |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                           | Description        |
| ---------------------------------- | ------------------ |
| `EASYHUB_INSTALL_METHOD=git\|npm` | Install method     |
| `EASYHUB_GIT_DIR=<path>`          | Checkout directory |
| `EASYHUB_NO_ONBOARD=1`            | Skip onboarding    |
| `EASYHUB_GIT_UPDATE=0`            | Disable git pull   |
| `EASYHUB_DRY_RUN=1`               | Dry run mode       |

  </Accordion>
</AccordionGroup>

<Note>
If `-InstallMethod git` is used and Git is missing, the script exits and prints the Git for Windows link.
</Note>

---

## CI and automation

Use non-interactive flags/env vars for predictable runs.

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    EASYHUB_INSTALL_METHOD=git EASYHUB_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install-cli.sh | bash -s -- --json --prefix /opt/EasyHub
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://EasyHub.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Troubleshooting

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git is required for `git` install method. For `npm` installs, Git is still checked/installed to avoid `spawn git ENOENT` failures when dependencies use git URLs.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Some Linux setups point npm global prefix to root-owned paths. `install.sh` can switch prefix to `~/.npm-global` and append PATH exports to shell rc files (when those files exist).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    The scripts default `SHARP_IGNORE_GLOBAL_LIBVIPS=1` to avoid sharp building against system libvips. To override:

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://EasyHub.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Install Git for Windows, reopen PowerShell, rerun installer.
  </Accordion>

  <Accordion title='Windows: "EasyHub is not recognized"'>
    Run `npm config get prefix`, append `\bin`, add that directory to user PATH, then reopen PowerShell.
  </Accordion>

  <Accordion title="EasyHub not found after install">
    Usually a PATH issue. See [Node.js troubleshooting](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
