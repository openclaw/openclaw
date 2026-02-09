---
summary: "설치 스크립트(install.sh, install-cli.sh, install.ps1)의 동작 방식, 플래그, 자동화 방법"
read_when:
  - "`openclaw.ai/install.sh`를 이해하고 싶을 때"
  - 설치를 자동화하고 싶을 때(CI / 헤드리스)
  - GitHub 체크아웃에서 설치하고 싶을 때
title: "설치 프로그램 내부 동작"
---

# 설치 프로그램 내부 동작

OpenClaw 는 `openclaw.ai` 에서 제공되는 세 가지 설치 스크립트를 제공합니다.

| 스크립트                               | 플랫폼                                     | What it does                                                                                                        |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | 필요 시 Node 를 설치하고, npm (기본값) 또는 git 으로 OpenClaw 를 설치하며, 온보딩을 실행할 수 있습니다.          |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | 로컬 프리픽스(`~/.openclaw`)에 Node + OpenClaw 를 설치합니다. 루트 권한이 필요 없습니다. |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | 필요 시 Node 를 설치하고, npm (기본값) 또는 git 으로 OpenClaw 를 설치하며, 온보딩을 실행할 수 있습니다.          |

## 빠른 명령어

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
설치에 성공했지만 새 터미널에서 `openclaw` 를 찾을 수 없다면, [Node.js 문제 해결](/install/node#troubleshooting)을 참고하십시오.
</Note>

---

## install.sh

<Tip>
macOS/Linux/WSL 에서 대부분의 대화형 설치에 권장됩니다.
</Tip>

### 흐름 (install.sh)

<Steps>
  <Step title="Detect OS">
    macOS 와 Linux(WSL 포함)를 지원합니다. macOS 가 감지되면 Homebrew 가 없을 경우 설치합니다.
  </Step>
  <Step title="Ensure Node.js 22+">
    Node 버전을 확인하고 필요 시 Node 22 를 설치합니다(macOS 는 Homebrew, Linux apt/dnf/yum 은 NodeSource 설정 스크립트 사용).
  </Step>
  <Step title="Ensure Git">
    Git 이 없으면 설치합니다.
  </Step>
  <Step title="Install OpenClaw">
    - `npm` 방식(기본값): 전역 npm 설치
    - `git` 방식: 저장소를 clone/update 하고 pnpm 으로 의존성을 설치 및 빌드한 뒤, `~/.local/bin/openclaw` 에 래퍼를 설치합니다
  </Step>
  <Step title="Post-install tasks">
    - 업그레이드 및 git 설치 시 `openclaw doctor --non-interactive` 실행(최선의 노력)
    - 적절한 경우 온보딩을 시도합니다(TTY 사용 가능, 온보딩 비활성화 아님, bootstrap/구성 검사 통과)
    - 기본값은 `SHARP_IGNORE_GLOBAL_LIBVIPS=1` 입니다
  </Step>
</Steps>

### 소스 체크아웃 감지

OpenClaw 체크아웃(`package.json` + `pnpm-workspace.yaml`) 내부에서 실행되면, 스크립트는 다음을 제안합니다.

- 체크아웃 사용(`git`), 또는
- 전역 설치 사용(`npm`)

TTY 가 없고 설치 방법이 설정되지 않은 경우, 기본값으로 `npm` 를 사용하고 경고를 출력합니다.

잘못된 방법 선택 또는 잘못된 `--install-method` 값에 대해서는 종료 코드 `2` 로 종료합니다.

### 예제 (install.sh)

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

| 플래그                               | 설명                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--install-method npm\\|git`     | 설치 방법 선택(기본값: `npm`). 별칭: `--method`      |
| `--npm`                           | npm 방식의 바로 가기                                                                                                |
| `--git`                           | git 방식의 바로 가기. 별칭: `--github`                                                |
| `--version <version\\|dist-tag>` | npm 버전 또는 dist-tag (기본값: `latest`)                                        |
| `--beta`                          | 사용 가능하면 beta dist-tag 사용, 아니면 `latest` 로 폴백                                                                  |
| `--git-dir <path>`                | 체크아웃 디렉토리(기본값: `~/openclaw`). 별칭: `--dir` |
| `--no-git-update`                 | 기존 체크아웃에 대해 `git pull` 건너뛰기                                                                                  |
| `--no-prompt`                     | 프롬프트 비활성화                                                                                                    |
| `--no-onboard`                    | 온보딩 건너뛰기                                                                                                     |
| `--onboard`                       | 온보딩 활성화                                                                                                      |
| `--dry-run`                       | 변경을 적용하지 않고 작업만 출력                                                                                           |
| `--verbose`                       | 디버그 출력 활성화(`set -x`, npm notice-level 로그)                                                 |
| `--help`                          | 사용법 표시(`-h`)                                                                              |

  </Accordion>

  <Accordion title="Environment variables reference">

| 변수                                              | 설명                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | 설치 방법                                                            |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | npm 버전 또는 dist-tag                                               |
| `OPENCLAW_BETA=0\\|1`                          | 사용 가능하면 beta 사용                                                  |
| `OPENCLAW_GIT_DIR=<path>`                       | 체크아웃 디렉토리                                                        |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | git 업데이트 토글                                                      |
| `OPENCLAW_NO_PROMPT=1`                          | 프롬프트 비활성화                                                        |
| `OPENCLAW_NO_ONBOARD=1`                         | 온보딩 건너뛰기                                                         |
| `OPENCLAW_DRY_RUN=1`                            | 드라이 런 모드                                                         |
| `OPENCLAW_VERBOSE=1`                            | 디버그 모드                                                           |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm 로그 레벨                                                        |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips 동작 제어(기본값: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
모든 항목을 로컬 프리픽스(기본값 `~/.openclaw`) 아래에 두고, 시스템 Node 의존성이 필요 없는 환경을 위해 설계되었습니다.
</Info>

### 흐름 (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Node tarball(기본값 `22.22.0`)을 `<prefix>/tools/node-v<version>` 에 다운로드하고 SHA-256 을 검증합니다.
  </Step>
  <Step title="Ensure Git">
    Git 이 없으면 Linux 에서는 apt/dnf/yum, macOS 에서는 Homebrew 로 설치를 시도합니다.
  </Step>
  <Step title="Install OpenClaw under prefix">` 를 사용하여 npm 으로 설치한 뒤, `<prefix>`, then writes wrapper to `<prefix>/bin/openclaw` 에 래퍼를 작성합니다.
  </Step>
</Steps>

### 예제 (install-cli.sh)

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

| 플래그                    | 설명                                                                         |
| ---------------------- | -------------------------------------------------------------------------- |
| `--prefix <path>`      | 설치 프리픽스(기본값: `~/.openclaw`)             |
| `--version <ver>`      | OpenClaw 버전 또는 dist-tag (기본값: `latest`) |
| `--node-version <ver>` | Node 버전(기본값: `22.22.0`)                 |
| `--json`               | NDJSON 이벤트 출력                                                              |
| `--onboard`            | 설치 후 `openclaw onboard` 실행                                                 |
| `--no-onboard`         | 온보딩 건너뛰기(기본값)                                           |
| `--set-npm-prefix`     | Linux 에서 현재 프리픽스에 쓰기 권한이 없으면 npm 프리픽스를 `~/.npm-global` 로 강제                |
| `--help`               | 사용법 표시(`-h`)                                            |

  </Accordion>

  <Accordion title="Environment variables reference">

| 변수                                              | 설명                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | 설치 프리픽스                                                          |
| `OPENCLAW_VERSION=<ver>`                        | OpenClaw 버전 또는 dist-tag                                          |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Node 버전                                                          |
| `OPENCLAW_NO_ONBOARD=1`                         | 온보딩 건너뛰기                                                         |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | npm 로그 레벨                                                        |
| `OPENCLAW_GIT_DIR=<path>`                       | 레거시 정리 조회 경로(이전 `Peekaboo` 서브모듈 체크아웃 제거 시 사용) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | sharp/libvips 동작 제어(기본값: `1`) |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### 흐름 (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    PowerShell 5+ 가 필요합니다.
  </Step>
  <Step title="Ensure Node.js 22+">
    없으면 winget, 그 다음 Chocolatey, 그 다음 Scoop 순으로 설치를 시도합니다.
  </Step>
  <Step title="Install OpenClaw">
    - `npm` 방식(기본값): 선택된 `-Tag` 를 사용하여 전역 npm 설치
    - `git` 방식: 저장소를 clone/update 하고 pnpm 으로 설치/빌드한 뒤, `%USERPROFILE%\.local\bin\openclaw.cmd` 에 래퍼를 설치합니다
  </Step>
  <Step title="Post-install tasks">
    가능하면 필요한 bin 디렉토리를 사용자 PATH 에 추가한 다음, 업그레이드 및 git 설치 시 `openclaw doctor --non-interactive` 를 실행합니다(최선의 노력).
  </Step>
</Steps>

### 예제 (install.ps1)

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

| 플래그                         | 설명                                                                           |
| --------------------------- | ---------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | 설치 방법(기본값: `npm`)                         |
| `-Tag <tag>`                | npm dist-tag (기본값: `latest`)              |
| `-GitDir <path>`            | 체크아웃 디렉토리(기본값: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | 온보딩 건너뛰기                                                                     |
| `-NoGitUpdate`              | `git pull` 건너뛰기                                                              |
| `-DryRun`                   | 작업만 출력                                                                       |

  </Accordion>

  <Accordion title="Environment variables reference">

| 변수                                   | 설명            |
| ------------------------------------ | ------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | 설치 방법         |
| `OPENCLAW_GIT_DIR=<path>`            | 체크아웃 디렉토리     |
| `OPENCLAW_NO_ONBOARD=1`              | 온보딩 건너뛰기      |
| `OPENCLAW_GIT_UPDATE=0`              | git pull 비활성화 |
| `OPENCLAW_DRY_RUN=1`                 | 드라이 런 모드      |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git` 를 사용하고 Git 이 없으면, 스크립트는 종료되고 Git for Windows 링크를 출력합니다.
</Note>

---

## CI 및 자동화

예측 가능한 실행을 위해 비대화형 플래그/환경 변수를 사용하십시오.

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
    Git 은 `git` 설치 방식에 필요합니다. `npm` 설치의 경우에도, 의존성이 git URL 을 사용할 때 발생할 수 있는 `spawn git ENOENT` 실패를 피하기 위해 Git 을 확인/설치합니다.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    일부 Linux 설정에서는 npm 전역 프리픽스가 root 소유 경로를 가리킵니다. `install.sh` 는 프리픽스를 `~/.npm-global` 로 전환하고, 해당 파일이 존재할 경우 셸 rc 파일에 PATH export 를 추가할 수 있습니다.
  </Accordion>

  <Accordion title="sharp/libvips issues">
    스크립트는 기본적으로 시스템 libvips 에 대해 sharp 가 빌드되는 것을 피하기 위해 `SHARP_IGNORE_GLOBAL_LIBVIPS=1` 를 설정합니다. 재정의하려면 다음을 사용하십시오.

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Git for Windows 를 설치하고 PowerShell 을 다시 연 뒤 설치 프로그램을 다시 실행하십시오.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix` 를 실행하고 `\bin` 를 추가한 다음, 해당 디렉토리를 사용자 PATH 에 추가하고 PowerShell 을 다시 여십시오.
  </Accordion>

  <Accordion title="openclaw not found after install">
    보통 PATH 문제입니다. [Node.js 문제 해결](/install/node#troubleshooting)을 참고하십시오.
  </Accordion>
</AccordionGroup>
