---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How the installer scripts work (install.sh, install-cli.sh, install.ps1), flags, and automation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to understand `openclaw.ai/install.sh`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to automate installs (CI / headless)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to install from a GitHub checkout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Installer Internals"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Installer internals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw ships three installer scripts, served from `openclaw.ai`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Script                             | Platform             | What it does                                                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | Installs Node if needed, installs OpenClaw via npm (default) or git, and can run onboarding. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Installs Node + OpenClaw into a local prefix (`~/.openclaw`). No root required.              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Installs Node if needed, installs OpenClaw via npm (default) or git, and can run onboarding. |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="install.sh">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="install-cli.sh">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="install.ps1">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    iwr -useb https://openclaw.ai/install.ps1 | iex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If install succeeds but `openclaw` is not found in a new terminal, see [Node.js troubleshooting](/install/node#troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## install.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended for most interactive installs on macOS/Linux/WSL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tip>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Flow (install.sh)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Detect OS">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Supports macOS and Linux (including WSL). If macOS is detected, installs Homebrew if missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Ensure Node.js 22+">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Checks Node version and installs Node 22 if needed (Homebrew on macOS, NodeSource setup scripts on Linux apt/dnf/yum).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Ensure Git">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Installs Git if missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Install OpenClaw">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `npm` method (default): global npm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `git` method: clone/update repo, install deps with pnpm, build, then install wrapper at `~/.local/bin/openclaw`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Post-install tasks">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Runs `openclaw doctor --non-interactive` on upgrades and git installs (best effort)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Attempts onboarding when appropriate (TTY available, onboarding not disabled, and bootstrap/config checks pass)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Defaults `SHARP_IGNORE_GLOBAL_LIBVIPS=1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Source checkout detection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If run inside an OpenClaw checkout (`package.json` + `pnpm-workspace.yaml`), the script offers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- use checkout (`git`), or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- use global install (`npm`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no TTY is available and no install method is set, it defaults to `npm` and warns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The script exits with code `2` for invalid method selection or invalid `--install-method` values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples (install.sh)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Default">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Skip onboarding">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Git install">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Dry run">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Flags reference">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Flag                            | Description                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------- | ---------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--install-method npm\|git`     | Choose install method (default: `npm`). Alias: `--method`  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--npm`                         | Shortcut for npm method                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--git`                         | Shortcut for git method. Alias: `--github`                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--version <version\|dist-tag>` | npm version or dist-tag (default: `latest`)                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--beta`                        | Use beta dist-tag if available, else fallback to `latest`  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--git-dir <path>`              | Checkout directory (default: `~/openclaw`). Alias: `--dir` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--no-git-update`               | Skip `git pull` for existing checkout                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--no-prompt`                   | Disable prompts                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--no-onboard`                  | Skip onboarding                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--onboard`                     | Enable onboarding                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--dry-run`                     | Print actions without applying changes                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--verbose`                     | Enable debug output (`set -x`, npm notice-level logs)      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--help`                        | Show usage (`-h`)                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Environment variables reference">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Variable                                    | Description                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------------- | --------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | Install method                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | npm version or dist-tag                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_BETA=0\|1`                        | Use beta if available                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_GIT_DIR=<path>`                   | Checkout directory                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_GIT_UPDATE=0\|1`                  | Toggle git updates                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_NO_PROMPT=1`                      | Disable prompts                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_NO_ONBOARD=1`                     | Skip onboarding                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_DRY_RUN=1`                        | Dry run mode                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_VERBOSE=1`                        | Debug mode                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm log level                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Control sharp/libvips behavior (default: `1`) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## install-cli.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Info>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Designed for environments where you want everything under a local prefix (default `~/.openclaw`) and no system Node dependency.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Info>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Flow (install-cli.sh)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Install local Node runtime">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Downloads Node tarball (default `22.22.0`) to `<prefix>/tools/node-v<version>` and verifies SHA-256.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Ensure Git">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    If Git is missing, attempts install via apt/dnf/yum on Linux or Homebrew on macOS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Install OpenClaw under prefix">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Installs with npm using `--prefix <prefix>`, then writes wrapper to `<prefix>/bin/openclaw`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples (install-cli.sh)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Default">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Custom prefix + version">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Automation JSON output">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Run onboarding">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Flags reference">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Flag                   | Description                                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | ------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--prefix <path>`      | Install prefix (default: `~/.openclaw`)                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--version <ver>`      | OpenClaw version or dist-tag (default: `latest`)                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--node-version <ver>` | Node version (default: `22.22.0`)                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--json`               | Emit NDJSON events                                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--onboard`            | Run `openclaw onboard` after install                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--no-onboard`         | Skip onboarding (default)                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--set-npm-prefix`     | On Linux, force npm prefix to `~/.npm-global` if current prefix is not writable |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `--help`               | Show usage (`-h`)                                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Environment variables reference">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Variable                                    | Description                                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------------- | --------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_PREFIX=<path>`                    | Install prefix                                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw version or dist-tag                                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_NODE_VERSION=<ver>`               | Node version                                                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_NO_ONBOARD=1`                     | Skip onboarding                                                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm log level                                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_GIT_DIR=<path>`                   | Legacy cleanup lookup path (used when removing old `Peekaboo` submodule checkout) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Control sharp/libvips behavior (default: `1`)                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## install.ps1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Flow (install.ps1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Ensure PowerShell + Windows environment">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Requires PowerShell 5+.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Ensure Node.js 22+">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    If missing, attempts install via winget, then Chocolatey, then Scoop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Install OpenClaw">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `npm` method (default): global npm install using selected `-Tag`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `git` method: clone/update repo, install/build with pnpm, and install wrapper at `%USERPROFILE%\.local\bin\openclaw.cmd`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Step title="Post-install tasks">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Adds needed bin directory to user PATH when possible, then runs `openclaw doctor --non-interactive` on upgrades and git installs (best effort).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Step>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Steps>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Examples (install.ps1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Default">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    iwr -useb https://openclaw.ai/install.ps1 | iex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Git install">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Custom git directory">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="Dry run">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Flags reference">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Flag                      | Description                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------- | ------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `-InstallMethod npm\|git` | Install method (default: `npm`)                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `-Tag <tag>`              | npm dist-tag (default: `latest`)                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `-GitDir <path>`          | Checkout directory (default: `%USERPROFILE%\openclaw`) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `-NoOnboard`              | Skip onboarding                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `-NoGitUpdate`            | Skip `git pull`                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `-DryRun`                 | Print actions only                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Environment variables reference">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Variable                           | Description        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------------- | ------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_INSTALL_METHOD=git\|npm` | Install method     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_GIT_DIR=<path>`          | Checkout directory |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_NO_ONBOARD=1`            | Skip onboarding    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_GIT_UPDATE=0`            | Disable git pull   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `OPENCLAW_DRY_RUN=1`               | Dry run mode       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `-InstallMethod git` is used and Git is missing, the script exits and prints the Git for Windows link.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Note>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CI and automation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use non-interactive flags/env vars for predictable runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="install.sh (non-interactive npm)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="install.sh (non-interactive git)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="install-cli.sh (JSON)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Tab title="install.ps1 (skip onboarding)">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Tab>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</Tabs>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Why is Git required?">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Git is required for `git` install method. For `npm` installs, Git is still checked/installed to avoid `spawn git ENOENT` failures when dependencies use git URLs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Why does npm hit EACCES on Linux?">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Some Linux setups point npm global prefix to root-owned paths. `install.sh` can switch prefix to `~/.npm-global` and append PATH exports to shell rc files (when those files exist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="sharp/libvips issues">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    The scripts default `SHARP_IGNORE_GLOBAL_LIBVIPS=1` to avoid sharp building against system libvips. To override:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title='Windows: "npm error spawn git / ENOENT"'>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Install Git for Windows, reopen PowerShell, rerun installer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title='Windows: "openclaw is not recognized"'>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Run `npm config get prefix`, append `\bin`, add that directory to user PATH, then reopen PowerShell.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="openclaw not found after install">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Usually a PATH issue. See [Node.js troubleshooting](/install/node#troubleshooting).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
