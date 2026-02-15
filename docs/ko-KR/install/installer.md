---
summary: "How the installer scripts work (install.sh, install-cli.sh, install.ps1), flags, and automation"
read_when:
  - You want to understand `openclaw.ai/install.sh`
  - You want to automate installs (CI / headless)
  - You want to install from a GitHub checkout
title: "Installer Internals"
x-i18n:
  source_hash: 65aae56b011f7a32ec52b67632c4b3e0c1bb1462fb1d1596c3c29b516246a4fd
---

# 설치 프로그램 내부

OpenClaw는 `openclaw.ai`에서 제공되는 세 가지 설치 프로그램 스크립트를 제공합니다.

| 스크립트                           | 플랫폼           | 그것이 하는 일                                                                                           |
| ---------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS/리눅스/WSL | 필요한 경우 Node를 설치하고 npm(기본값) 또는 git을 통해 OpenClaw를 설치하고 온보딩을 실행할 수 있습니다. |
| [`install-cli.sh`](#install-clish) | macOS/리눅스/WSL | Node + OpenClaw를 로컬 접두사(`~/.openclaw`)에 설치합니다. 루트가 필요하지 않습니다.                     |
| [`install.ps1`](#installps1)       | 윈도우(파워셸)   | 필요한 경우 Node를 설치하고 npm(기본값) 또는 git을 통해 OpenClaw를 설치하고 온보딩을 실행할 수 있습니다. |

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
설치에 성공했지만 새 터미널에서 `openclaw`를 찾을 수 없는 경우 [Node.js 문제 해결](/install/node#troubleshooting)을 참조하세요.
</Note>

---

## 설치.sh

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
    - `git` 방법: 저장소 복제/업데이트, pnpm으로 deps 설치, 빌드 후 `~/.local/bin/openclaw`에 래퍼 설치
  </Step>
  <Step title="Post-install tasks">
    - 업그레이드 및 git 설치 시 `openclaw doctor --non-interactive` 실행(최선의 노력)
    - 적절한 경우 온보딩 시도(TTY 사용 가능, 온보딩 비활성화 안 됨, 부트스트랩/구성 확인 통과)
    - 기본값 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### 소스 체크아웃 감지

OpenClaw 체크아웃(`package.json` + `pnpm-workspace.yaml`) 내에서 실행하는 경우 스크립트는 다음을 제공합니다.

- 체크아웃(`git`)을 사용하거나
- 전역 설치 사용 (`npm`)

사용 가능한 TTY가 없고 설치 방법이 설정되지 않은 경우 기본값은 `npm`이며 경고합니다.

잘못된 메소드 선택 또는 잘못된 `--install-method` 값에 대해 스크립트는 `2` 코드로 종료됩니다.

### 예제(install.sh)

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

| 플래그                          | 설명                                                                |
| ------------------------------- | ------------------------------------------------------------------- |
| `--install-method npm\|git`     | 설치 방법을 선택합니다(기본값: `npm`). 별칭: `--method`             |
| `--npm`                         | npm 메소드 바로가기                                                 |
| `--git`                         | git 메소드의 단축키. 별칭: `--github`                               |
| `--version <version\|dist-tag>` | npm 버전 또는 dist-tag (기본값: `latest`)                           |
| `--beta`                        | 가능한 경우 베타 dist-tag를 사용하고, 그렇지 않으면 `latest`로 대체 |
| `--git-dir <path>`              | 체크아웃 디렉터리(기본값: `~/openclaw`). 별칭: `--dir`              |
| `--no-git-update`               | 기존 결제에 대해 `git pull` 건너뛰기                                |
| `--no-prompt`                   | 프롬프트 비활성화                                                   |
| `--no-onboard`                  | 온보딩 건너뛰기                                                     |
| `--onboard`                     | 온보딩 활성화                                                       |
| `--dry-run`                     | 변경 사항을 적용하지 않고 인쇄 작업                                 |
| `--verbose`                     | 디버그 출력 활성화(`set -x`, npm 공지 수준 로그)                    |
| `--help`                        | 사용량 표시 (`-h`)                                                  |

  </Accordion>

  <Accordion title="Environment variables reference">

| 변수                                        | 설명                                  |
| ------------------------------------------- | ------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | 설치방법                              |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | npm 버전 또는 dist-tag                |
| `OPENCLAW_BETA=0\|1`                        | 가능한 경우 베타 사용                 |
| `OPENCLAW_GIT_DIR=<path>`                   | 결제 디렉토리                         |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | Git 업데이트 전환                     |
| `OPENCLAW_NO_PROMPT=1`                      | 프롬프트 비활성화                     |
| `OPENCLAW_NO_ONBOARD=1`                     | 온보딩 건너뛰기                       |
| `OPENCLAW_DRY_RUN=1`                        | 시험 실행 모드                        |
| `OPENCLAW_VERBOSE=1`                        | 디버그 모드                           |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm 로그 수준                         |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Sharp/libvips 동작 제어 (기본값: `1`) |

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
    노드 타르볼(기본값 `22.22.0`)을 `<prefix>/tools/node-v<version>`에 다운로드하고 SHA-256을 확인합니다.
  </Step>
  <Step title="Ensure Git">
    Git이 없으면 Linux에서는 apt/dnf/yum을, macOS에서는 Homebrew를 통해 설치를 시도합니다.
  </Step>
  <Step title="Install OpenClaw under prefix">
    `--prefix <prefix>`를 사용하여 npm으로 설치한 다음 `<prefix>/bin/openclaw`에 래퍼를 씁니다.
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

| 플래그                 | 설명                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `--prefix <path>`      | 접두어 설치(기본값: `~/.openclaw`)                                                        |
| `--version <ver>`      | OpenClaw 버전 또는 dist-tag (기본값: `latest`)                                            |
| `--node-version <ver>` | 노드 버전(기본값: `22.22.0`)                                                              |
| `--json`               | NDJSON 이벤트 내보내기                                                                    |
| `--onboard`            | 설치 후 `openclaw onboard` 실행                                                           |
| `--no-onboard`         | 온보딩 건너뛰기(기본값)                                                                   |
| `--set-npm-prefix`     | Linux에서는 현재 접두어를 쓸 수 없는 경우 npm 접두어를 `~/.npm-global`로 강제 설정합니다. |
| `--help`               | 사용량 표시 (`-h`)                                                                        |

  </Accordion>

  <Accordion title="Environment variables reference">

| 변수                                        | 설명                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | 접두사 설치                                                                  |
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw 버전 또는 dist-tag                                                  |
| `OPENCLAW_NODE_VERSION=<ver>`               | 노드 버전                                                                    |
| `OPENCLAW_NO_ONBOARD=1`                     | 온보딩 건너뛰기                                                              |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm 로그 수준                                                                |
| `OPENCLAW_GIT_DIR=<path>`                   | 레거시 정리 조회 경로(이전 `Peekaboo` 하위 모듈 체크아웃을 제거할 때 사용됨) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | Sharp/libvips 동작 제어 (기본값: `1`)                                        |

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
    - `npm` 방법(기본값): 선택한 `-Tag`를 사용하여 전역 npm 설치
    - `git` 방법: 저장소 복제/업데이트, pnpm으로 설치/빌드, `%USERPROFILE%\.local\bin\openclaw.cmd`에 래퍼 설치
  </Step>
  <Step title="Post-install tasks">
    가능하면 사용자 PATH에 필요한 bin 디렉터리를 추가한 다음 업그레이드 및 git 설치 시 `openclaw doctor --non-interactive`를 실행합니다(최선의 노력).
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
  <Tab title="Debug trace">
    ```powershell
    # install.ps1 has no dedicated -Verbose flag yet.
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| 플래그                    | 설명                                                |
| ------------------------- | --------------------------------------------------- |
| `-InstallMethod npm\|git` | 설치방법 (기본값: `npm`)                            |
| `-Tag <tag>`              | npm dist-tag (기본값: `latest`)                     |
| `-GitDir <path>`          | 체크아웃 디렉터리(기본값: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`              | 온보딩 건너뛰기                                     |
| `-NoGitUpdate`            | 건너뛰기 `git pull`                                 |
| `-DryRun`                 | 인쇄 작업만                                         |

  </Accordion>

  <Accordion title="Environment variables reference">

| 변수                               | 설명             |
| ---------------------------------- | ---------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | 설치방법         |
| `OPENCLAW_GIT_DIR=<path>`          | 결제 디렉토리    |
| `OPENCLAW_NO_ONBOARD=1`            | 온보딩 건너뛰기  |
| `OPENCLAW_GIT_UPDATE=0`            | 자식 풀 비활성화 |
| `OPENCLAW_DRY_RUN=1`               | 시험 실행 모드   |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git`가 사용되고 Git이 누락된 경우 스크립트가 종료되고 Windows용 Git 링크가 인쇄됩니다.
</Note>

---

## CI 및 자동화

예측 가능한 실행을 위해 비대화형 플래그/환경 변수를 사용합니다.

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
    일부 Linux 설정은 루트 소유 경로에 대한 npm 전역 접두사를 가리킵니다. `install.sh`는 접두사를 `~/.npm-global`로 전환하고 PATH 내보내기를 쉘 rc 파일(해당 파일이 있는 경우)에 추가할 수 있습니다.
  </Accordion>

  <Accordion title="sharp/libvips issues">
    스크립트는 시스템 libvips에 대한 날카로운 빌드를 피하기 위해 기본적으로 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`입니다. 재정의하려면:

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Windows용 Git을 설치하고, PowerShell을 다시 열고, 설치 프로그램을 다시 실행하세요.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix`를 실행하고 `\bin`를 추가하고 해당 디렉터리를 사용자 PATH에 추가한 다음 PowerShell을 다시 엽니다.
  </Accordion>

  <Accordion title="Windows: how to get verbose installer output">
    `install.ps1`는 현재 `-Verbose` 스위치를 노출하지 않습니다.
    스크립트 수준 진단을 위해 PowerShell 추적을 사용합니다.

    ```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

  </Accordion>

  <Accordion title="openclaw not found after install">
    일반적으로 PATH 문제입니다. [Node.js 문제 해결](/install/node#troubleshooting)을 참조하세요.
  </Accordion>
</AccordionGroup>
