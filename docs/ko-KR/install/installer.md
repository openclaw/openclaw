---
title: "설치 스크립트 상세"
summary: "설치 스크립트 (install.sh, install-cli.sh, install.ps1) 의 작동 방식, 플래그 및 자동화"
read_when:
  - "`openclaw.ai/install.sh` 를 이해하고 싶을 때"
  - "설치를 자동화 (CI / 헤드리스) 하고 싶을 때"
  - "GitHub 체크아웃에서 설치하고 싶을 때"
x-i18n:
  source_path: docs/install/installer.md
---

# 설치 스크립트 상세

OpenClaw 는 `openclaw.ai` 에서 제공되는 세 가지 설치 스크립트를 제공합니다.

| 스크립트                           | 플랫폼               | 역할                                                                                                 |
| ---------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL  | 필요시 Node 를 설치하고, npm (기본) 또는 git 으로 OpenClaw 를 설치하며, 온보딩을 실행할 수 있습니다. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL  | Node + OpenClaw 를 로컬 프리픽스 (`~/.openclaw`) 에 설치합니다. 루트 권한이 필요하지 않습니다.       |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | 필요시 Node 를 설치하고, npm (기본) 또는 git 으로 OpenClaw 를 설치하며, 온보딩을 실행할 수 있습니다. |

## 빠른 명령어

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
설치에 성공했지만 새 터미널에서 `openclaw` 을 찾을 수 없는 경우, [Node.js 문제 해결](/install/node#troubleshooting)을 참고하세요.
</Note>

---

## install.sh

<Tip>
macOS/Linux/WSL 에서 대부분의 대화형 설치에 권장됩니다.
</Tip>

### 흐름 (install.sh)

<Steps>
  <Step title="OS 감지">
    macOS 와 Linux (WSL 포함) 를 지원합니다. macOS 가 감지되면 Homebrew 가 없는 경우 설치합니다.
  </Step>
  <Step title="기본적으로 Node.js 24 확인">
    Node 버전을 확인하고 필요시 Node 24 를 설치합니다 (macOS 에서는 Homebrew, Linux apt/dnf/yum 에서는 NodeSource 설정 스크립트). OpenClaw 는 호환성을 위해 현재 `22.16+` 인 Node 22 LTS 도 지원합니다.
  </Step>
  <Step title="Git 확인">
    Git 이 없으면 설치합니다.
  </Step>
  <Step title="OpenClaw 설치">
    - `npm` 방식 (기본): 전역 npm 설치
    - `git` 방식: 저장소 클론/업데이트, pnpm 으로 의존성 설치, 빌드, 그런 다음 `~/.local/bin/openclaw` 에 래퍼 설치
  </Step>
  <Step title="설치 후 작업">
    - 업그레이드 및 git 설치 시 `openclaw doctor --non-interactive` 를 실행합니다 (최선 노력)
    - 적절한 경우 온보딩을 시도합니다 (TTY 사용 가능, 온보딩 비활성화되지 않음, 부트스트랩/설정 검사 통과)
    - `SHARP_IGNORE_GLOBAL_LIBVIPS=1` 을 기본값으로 설정합니다
  </Step>
</Steps>

### 소스 체크아웃 감지

OpenClaw 체크아웃 (`package.json` + `pnpm-workspace.yaml`) 내에서 실행하면 스크립트가 다음을 제안합니다:

- 체크아웃 사용 (`git`), 또는
- 전역 설치 사용 (`npm`)

TTY 가 없고 설치 방법이 설정되지 않은 경우, `npm` 으로 기본 설정하고 경고합니다.

유효하지 않은 방법 선택 또는 유효하지 않은 `--install-method` 값의 경우 스크립트는 종료 코드 `2` 로 종료됩니다.

### 예제 (install.sh)

<Tabs>
  <Tab title="기본">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="온보딩 건너뛰기">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git 설치">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="npm 으로 GitHub main">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --version main
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="플래그 레퍼런스">

| 플래그                                | 설명                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| `--install-method npm\|git`           | 설치 방법 선택 (기본: `npm`). 별칭: `--method`        |
| `--npm`                               | npm 방식 단축키                                       |
| `--git`                               | git 방식 단축키. 별칭: `--github`                     |
| `--version <version\|dist-tag\|spec>` | npm 버전, dist-tag 또는 패키지 사양 (기본: `latest`)  |
| `--beta`                              | 가능하면 beta dist-tag 사용, 없으면 `latest` 로 대체  |
| `--git-dir <path>`                    | 체크아웃 디렉토리 (기본: `~/openclaw`). 별칭: `--dir` |
| `--no-git-update`                     | 기존 체크아웃에서 `git pull` 건너뛰기                 |
| `--no-prompt`                         | 프롬프트 비활성화                                     |
| `--no-onboard`                        | 온보딩 건너뛰기                                       |
| `--onboard`                           | 온보딩 활성화                                         |
| `--dry-run`                           | 변경 사항을 적용하지 않고 작업 출력                   |
| `--verbose`                           | 디버그 출력 활성화 (`set -x`, npm notice-level 로그)  |
| `--help`                              | 사용법 표시 (`-h`)                                    |

  </Accordion>

  <Accordion title="환경 변수 레퍼런스">

| 변수                                                    | 설명                                |
| ------------------------------------------------------- | ----------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`                      | 설치 방법                           |
| `OPENCLAW_VERSION=latest\|next\|main\|<semver>\|<spec>` | npm 버전, dist-tag 또는 패키지 사양 |
| `OPENCLAW_BETA=0\|1`                                    | 가능하면 beta 사용                  |
| `OPENCLAW_GIT_DIR=<path>`                               | 체크아웃 디렉토리                   |
| `OPENCLAW_GIT_UPDATE=0\|1`                              | git 업데이트 전환                   |
| `OPENCLAW_NO_PROMPT=1`                                  | 프롬프트 비활성화                   |
| `OPENCLAW_NO_ONBOARD=1`                                 | 온보딩 건너뛰기                     |
| `OPENCLAW_DRY_RUN=1`                                    | Dry run 모드                        |
| `OPENCLAW_VERBOSE=1`                                    | 디버그 모드                         |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice`             | npm 로그 레벨                       |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`                      | sharp/libvips 동작 제어 (기본: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
모든 것을 로컬 프리픽스 (기본 `~/.openclaw`) 아래에 두고 시스템 Node 의존성이 필요 없는 환경을 위해 설계되었습니다.
</Info>

### 흐름 (install-cli.sh)

<Steps>
  <Step title="로컬 Node 런타임 설치">
    고정된 지원 Node LTS tarball (버전은 스크립트에 포함되어 있으며 독립적으로 업데이트됨) 을 `<prefix>/tools/node-v<version>` 에 다운로드하고 SHA-256 을 검증합니다.
  </Step>
  <Step title="Git 확인">
    Git 이 없으면 Linux 에서는 apt/dnf/yum, macOS 에서는 Homebrew 를 통해 설치를 시도합니다.
  </Step>
  <Step title="프리픽스 아래에 OpenClaw 설치">
    `--prefix <prefix>` 를 사용하여 npm 으로 설치한 다음 `<prefix>/bin/openclaw` 에 래퍼를 작성합니다.
  </Step>
</Steps>

### 예제 (install-cli.sh)

<Tabs>
  <Tab title="기본">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="커스텀 프리픽스 + 버전">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="자동화 JSON 출력">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="온보딩 실행">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="플래그 레퍼런스">

| 플래그                 | 설명                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `--prefix <path>`      | 설치 프리픽스 (기본: `~/.openclaw`)                                                  |
| `--version <ver>`      | OpenClaw 버전 또는 dist-tag (기본: `latest`)                                         |
| `--node-version <ver>` | Node 버전 (기본: `22.22.0`)                                                          |
| `--json`               | NDJSON 이벤트 출력                                                                   |
| `--onboard`            | 설치 후 `openclaw onboard` 실행                                                      |
| `--no-onboard`         | 온보딩 건너뛰기 (기본)                                                               |
| `--set-npm-prefix`     | Linux 에서 현재 프리픽스에 쓰기 권한이 없으면 npm 프리픽스를 `~/.npm-global` 로 강제 |
| `--help`               | 사용법 표시 (`-h`)                                                                   |

  </Accordion>

  <Accordion title="환경 변수 레퍼런스">

| 변수                                        | 설명                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | 설치 프리픽스                                                          |
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw 버전 또는 dist-tag                                            |
| `OPENCLAW_NODE_VERSION=<ver>`               | Node 버전                                                              |
| `OPENCLAW_NO_ONBOARD=1`                     | 온보딩 건너뛰기                                                        |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm 로그 레벨                                                          |
| `OPENCLAW_GIT_DIR=<path>`                   | 레거시 정리 조회 경로 (이전 `Peekaboo` 서브모듈 체크아웃 제거 시 사용) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | sharp/libvips 동작 제어 (기본: `1`)                                    |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### 흐름 (install.ps1)

<Steps>
  <Step title="PowerShell + Windows 환경 확인">
    PowerShell 5+ 가 필요합니다.
  </Step>
  <Step title="기본적으로 Node.js 24 확인">
    없으면 winget, 그다음 Chocolatey, 그다음 Scoop 을 통해 설치를 시도합니다. 호환성을 위해 현재 `22.16+` 인 Node 22 LTS 도 지원됩니다.
  </Step>
  <Step title="OpenClaw 설치">
    - `npm` 방식 (기본): 선택된 `-Tag` 를 사용한 전역 npm 설치
    - `git` 방식: 저장소 클론/업데이트, pnpm 으로 설치/빌드, `%USERPROFILE%\.local\bin\openclaw.cmd` 에 래퍼 설치
  </Step>
  <Step title="설치 후 작업">
    가능한 경우 필요한 bin 디렉토리를 사용자 PATH 에 추가한 다음, 업그레이드 및 git 설치 시 `openclaw doctor --non-interactive` 를 실행합니다 (최선 노력).
  </Step>
</Steps>

### 예제 (install.ps1)

<Tabs>
  <Tab title="기본">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git 설치">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="npm 으로 GitHub main">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag main
    ```
  </Tab>
  <Tab title="커스텀 git 디렉토리">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
  <Tab title="디버그 트레이스">
    ```powershell
    # install.ps1 에는 아직 전용 -Verbose 플래그가 없습니다.
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="플래그 레퍼런스">

| 플래그                      | 설명                                                 |
| --------------------------- | ---------------------------------------------------- |
| `-InstallMethod npm\|git`   | 설치 방법 (기본: `npm`)                              |
| `-Tag <tag\|version\|spec>` | npm dist-tag, 버전 또는 패키지 사양 (기본: `latest`) |
| `-GitDir <path>`            | 체크아웃 디렉토리 (기본: `%USERPROFILE%\openclaw`)   |
| `-NoOnboard`                | 온보딩 건너뛰기                                      |
| `-NoGitUpdate`              | `git pull` 건너뛰기                                  |
| `-DryRun`                   | 작업만 출력                                          |

  </Accordion>

  <Accordion title="환경 변수 레퍼런스">

| 변수                               | 설명              |
| ---------------------------------- | ----------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | 설치 방법         |
| `OPENCLAW_GIT_DIR=<path>`          | 체크아웃 디렉토리 |
| `OPENCLAW_NO_ONBOARD=1`            | 온보딩 건너뛰기   |
| `OPENCLAW_GIT_UPDATE=0`            | git pull 비활성화 |
| `OPENCLAW_DRY_RUN=1`               | Dry run 모드      |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git` 을 사용했는데 Git 이 없으면 스크립트가 종료되고 Git for Windows 링크를 출력합니다.
</Note>

---

## CI 및 자동화

예측 가능한 실행을 위해 비대화형 플래그/환경 변수를 사용하세요.

<Tabs>
  <Tab title="install.sh (비대화형 npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (비대화형 git)">
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
  <Tab title="install.ps1 (온보딩 건너뛰기)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## 문제 해결

<AccordionGroup>
  <Accordion title="Git 이 왜 필요한가요?">
    Git 은 `git` 설치 방법에 필요합니다. `npm` 설치의 경우에도 의존성이 git URL 을 사용할 때 `spawn git ENOENT` 실패를 방지하기 위해 Git 을 확인/설치합니다.
  </Accordion>

  <Accordion title="Linux 에서 npm 이 EACCES 오류를 발생시키는 이유는?">
    일부 Linux 설정은 npm 전역 프리픽스를 루트 소유 경로로 지정합니다. `install.sh` 는 프리픽스를 `~/.npm-global` 로 전환하고 셸 rc 파일에 PATH export 를 추가할 수 있습니다 (해당 파일이 있는 경우).
  </Accordion>

  <Accordion title="sharp/libvips 문제">
    스크립트는 sharp 가 시스템 libvips 에 대해 빌드하는 것을 방지하기 위해 기본적으로 `SHARP_IGNORE_GLOBAL_LIBVIPS=1` 을 설정합니다. 재정의하려면:

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Git for Windows 를 설치하고 PowerShell 을 다시 열고 설치 프로그램을 다시 실행하세요.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    `npm config get prefix` 를 실행하고 해당 디렉토리를 사용자 PATH 에 추가하세요 (Windows 에서는 `\bin` 접미사 불필요). 그런 다음 PowerShell 을 다시 여세요.
  </Accordion>

  <Accordion title="Windows: 상세한 설치 프로그램 출력을 얻는 방법">
    `install.ps1` 은 현재 `-Verbose` 스위치를 제공하지 않습니다.
    스크립트 수준 진단을 위해 PowerShell 트레이싱을 사용하세요:

    ```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

  </Accordion>

  <Accordion title="설치 후 openclaw 을 찾을 수 없음">
    보통 PATH 문제입니다. [Node.js 문제 해결](/install/node#troubleshooting)을 참고하세요.
  </Accordion>
</AccordionGroup>
