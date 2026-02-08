---
read_when:
    - 당신은 `openclaw.ai/install.sh`을 이해하고 싶습니다
    - 설치를 자동화하려는 경우(CI/헤드리스)
    - GitHub 결제에서 설치하고 싶습니다.
summary: 설치 프로그램 스크립트 작동 방식(install.sh, install-cli.sh, install.ps1), 플래그 및 자동화
title: 설치 프로그램 내부
x-i18n:
    generated_at: "2026-02-08T16:01:59Z"
    model: gtx
    provider: google-translate
    source_hash: 8517f9cf8e237b62f382c6e405d7ff2396d725894121e42410646775be1b0269
    source_path: install/installer.md
    workflow: 15
---

# 설치 프로그램 내부

OpenClaw는 다음에서 제공되는 세 가지 설치 프로그램 스크립트를 제공합니다. `openclaw.ai`.

| Script                             | Platform             | What it does                                                                                 |
| ---------------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | Installs Node if needed, installs OpenClaw via npm (default) or git, and can run onboarding. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Installs Node + OpenClaw into a local prefix (`~/.openclaw`). No root required.              |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Installs Node if needed, installs OpenClaw via npm (default) or git, and can run onboarding. |

## 빠른 명령

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
설치에 성공했지만 새 터미널에서 `openclaw`을 찾을 수 없는 경우 [Node.js 문제 해결](/install/node#troubleshooting)을 참조하세요.
</Note>

---

## install.sh

<Tip>
macOS/Linux/WSL에서 대부분의 대화형 설치에 권장됩니다.
</Tip>

### 흐름(install.sh)

<Steps>
  <Step title="Detect OS">
    macOS 및 Linux(WSL 포함)를 지원합니다. macOS가 감지되면 누락된 경우 Homebrew를 설치합니다.
  </Step>
  <Step title="Ensure Node.js 22+">
    Node 버전을 확인하고 필요한 경우 Node 22를 설치합니다(macOS의 Homebrew, Linux apt/dnf/yum의 NodeSource 설정 스크립트).
  </Step>
  <Step title="Ensure Git">
    누락된 경우 Git을 설치합니다.
  </Step>
  <Step title="Install OpenClaw">
    - `npm` 방법(기본값): 전역 npm 설치
    - `git` 방법: repo 복제/업데이트, pnpm으로 deps 설치, 빌드 후 `~/.local/bin/openclaw`에 래퍼 설치
  </Step>
  <Step title="Post-install tasks">
    - 업그레이드 및 git 설치 시 `openclaw doctor --non-interactive` 실행(최선의 노력)
    - 적절한 경우 온보딩 시도(TTY 사용 가능, 온보딩 비활성화되지 않음, 부트스트랩/구성 확인 통과)
    - 기본값 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### 소스 체크아웃 감지

OpenClaw 체크아웃 내에서 실행되는 경우(`package.json` + `pnpm-workspace.yaml`) 스크립트는 다음을 제공합니다.

- 결제 사용(`git`), 또는
- 전역 설치 사용(`npm`)

사용 가능한 TTY가 없고 설치 방법이 설정되지 않은 경우 기본값은 `npm` 그리고 경고합니다.

스크립트가 코드와 함께 종료됩니다. `2` 잘못된 방법 선택 또는 잘못된 경우 `--install-method` 가치.

### 예(install.sh)

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

| Flag                            | Description                                                |
| ------------------------------- | ---------------------------------------------------------- |
| `--install-method npm\|git`     | Choose install method (default: `npm`). Alias: `--method`  |
| `--npm`                         | Shortcut for npm method                                    |
| `--git`                         | Shortcut for git method. Alias: `--github`                 |
| `--version <version\|dist-tag>` | npm version or dist-tag (default: `latest`)                |
| `--beta`                        | Use beta dist-tag if available, else fallback to `latest`  |
| `--git-dir <path>`              | Checkout directory (default: `~/openclaw`). Alias: `--dir` |
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
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | Install method                                |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | npm version or dist-tag                       |
| `OPENCLAW_BETA=0\|1`                        | Use beta if available                         |
| `OPENCLAW_GIT_DIR=<path>`                   | Checkout directory                            |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | Toggle git updates                            |
| `OPENCLAW_NO_PROMPT=1`                      | Disable prompts                               |
| `OPENCLAW_NO_ONBOARD=1`                     | Skip onboarding                               |
| `OPENCLAW_DRY_RUN=1`                        | Dry run mode                                  |
| `OPENCLAW_VERBOSE=1`                        | Debug mode                                    |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm log level                                 |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Control sharp/libvips behavior (default: `1`) |

  </Accordion>
</AccordionGroup>

---

## 설치-cli.sh

<Info>
로컬 접두사(기본값 `~/.openclaw`) 아래의 모든 항목을 원하고 시스템 노드 종속성이 없는 환경을 위해 설계되었습니다.
</Info>

### 흐름(install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    노드 타르볼(기본값 `22.22.0`)을 `로 다운로드합니다.<prefix>/도구/노드-v<version>` 그리고 SHA-256을 확인합니다.
  </Step>
  <Step title="Ensure Git">
    Git이 없으면 Linux에서는 apt/dnf/yum을, macOS에서는 Homebrew를 통해 설치를 시도합니다.
  </Step>
  <Step title="Install OpenClaw under prefix">
    `--prefix를 사용하여 npm으로 설치 <prefix>`, then writes wrapper to `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### 예(install-cli.sh)

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

| Flag                   | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `--prefix <path>`      | Install prefix (default: `~/.openclaw`)                                         |
| `--version <ver>`      | OpenClaw version or dist-tag (default: `latest`)                                |
| `--node-version <ver>` | Node version (default: `22.22.0`)                                               |
| `--json`               | Emit NDJSON events                                                              |
| `--onboard`            | Run `openclaw onboard` after install                                            |
| `--no-onboard`         | Skip onboarding (default)                                                       |
| `--set-npm-prefix`     | On Linux, force npm prefix to `~/.npm-global` if current prefix is not writable |
| `--help`               | Show usage (`-h`)                                                               |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                    | Description                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | Install prefix                                                                    |
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw version or dist-tag                                                      |
| `OPENCLAW_NODE_VERSION=<ver>`               | Node version                                                                      |
| `OPENCLAW_NO_ONBOARD=1`                     | Skip onboarding                                                                   |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm log level                                                                     |
| `OPENCLAW_GIT_DIR=<path>`                   | Legacy cleanup lookup path (used when removing old `Peekaboo` submodule checkout) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Control sharp/libvips behavior (default: `1`)                                     |

  </Accordion>
</AccordionGroup>

---

## 설치.ps1

### 흐름(install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    PowerShell 5 이상이 필요합니다.
  </Step>
  <Step title="Ensure Node.js 22+">
    누락된 경우 Winget, Chocolatey, Scoop을 통해 설치를 시도합니다.
  </Step>
  <Step title="Install OpenClaw">
    - `npm` 방법(기본값): 선택한 `-Tag`을 사용하여 전역 npm 설치
    - `git` 방법: repo 복제/업데이트, pnpm으로 설치/빌드, `%USERPROFILE%\.local\bin\openclaw.cmd`에 래퍼 설치
  </Step>
  <Step title="Post-install tasks">
    가능한 경우 필요한 bin 디렉터리를 사용자 PATH에 추가한 다음 업그레이드 및 git 설치 시 `openclaw doctor --non-interactive`을 실행합니다(최선의 노력).
  </Step>
</Steps>

### 예(install.ps1)

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

| Flag                      | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `-InstallMethod npm\|git` | Install method (default: `npm`)                        |
| `-Tag <tag>`              | npm dist-tag (default: `latest`)                       |
| `-GitDir <path>`          | Checkout directory (default: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`              | Skip onboarding                                        |
| `-NoGitUpdate`            | Skip `git pull`                                        |
| `-DryRun`                 | Print actions only                                     |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                           | Description        |
| ---------------------------------- | ------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | Install method     |
| `OPENCLAW_GIT_DIR=<path>`          | Checkout directory |
| `OPENCLAW_NO_ONBOARD=1`            | Skip onboarding    |
| `OPENCLAW_GIT_UPDATE=0`            | Disable git pull   |
| `OPENCLAW_DRY_RUN=1`               | Dry run mode       |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git`이 사용되고 Git이 누락된 경우 스크립트가 종료되고 Windows용 Git 링크가 인쇄됩니다.
</Note>

---

## CI 및 자동화

예측 가능한 실행을 위해 비대화형 플래그/환경 변수를 사용하세요.

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

## 문제 해결

<AccordionGroup>
  <Accordion title="Why is Git required?">
    `git` 설치 방법에는 Git이 필요합니다. `npm` 설치의 경우 종속성이 git URL을 사용할 때 `spawn git ENOENT` 실패를 방지하기 위해 Git이 계속 확인/설치됩니다.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    일부 Linux 설정은 루트 소유 경로에 대한 npm 전역 접두사를 가리킵니다. `install.sh`은 접두사를 `~/.npm-global`로 전환하고 PATH 내보내기를 쉘 rc 파일(해당 파일이 있는 경우)에 추가할 수 있습니다.
  </Accordion>

  <Accordion title="sharp/libvips issues">
    시스템 libvips에 대한 날카로운 빌드를 피하기 위해 스크립트 기본값은 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`입니다. 재정의하려면:

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Windows용 Git을 설치하고, PowerShell을 다시 열고, 설치 프로그램을 다시 실행하세요.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix`을 실행하고 `\bin`을 추가하고 해당 디렉터리를 사용자 PATH에 추가한 다음 PowerShell을 다시 엽니다.
  </Accordion>

  <Accordion title="openclaw not found after install">
    일반적으로 PATH 문제입니다. [Node.js 문제 해결](/install/node#troubleshooting)을 참조하세요.
  </Accordion>
</AccordionGroup>
