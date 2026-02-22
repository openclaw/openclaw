---
summary: "설치 스크립트의 작동 방식 (install.sh, install-cli.sh, install.ps1), 플래그, 및 자동화"
read_when:
  - openclaw.ai/install.sh를 이해하고자 하는 경우
  - 설치를 자동화하고자 하는 경우 (CI / 헤드리스)
  - GitHub 체크아웃에서 설치하고자 하는 경우
title: "설치프로그램 내부"
---

# 설치 프로그램 내부

OpenClaw은 `openclaw.ai`에서 제공하는 세 가지 설치 스크립트를 제공합니다.

| 스크립트                            | 플랫폼             | 수행 작업                                                                                       |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL | 필요시 Node를 설치하고, npm(기본값) 또는 git을 통해 OpenClaw를 설치하며, 온보딩을 실행할 수 있음. |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL | 로컬 접두사(`~/.openclaw`)에 Node + OpenClaw 설치. 루트 권한 필요 없음.                         |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | 필요시 Node를 설치하고, npm(기본값) 또는 git을 통해 OpenClaw를 설치하며, 온보딩을 실행할 수 있음. |

## 빠른 실행 명령어

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
설치가 성공했지만 새로운 터미널에서 `openclaw`가 인식되지 않는 경우, [Node.js 문제 해결](/ko-KR/install/node#troubleshooting)을 참조하세요.
</Note>

---

## install.sh

<Tip>
macOS/Linux/WSL에서 대부분의 상호작용 설치에 권장됩니다.
</Tip>

### 흐름 (install.sh)

<Steps>
  <Step title="운영 체제 감지">
    macOS 및 Linux(WSL 포함)를 지원합니다. macOS가 감지되면, Homebrew가 없는 경우 설치합니다.
  </Step>
  <Step title="Node.js 22+ 보장">
    Node 버전을 확인하고 필요시 Node 22를 설치합니다 (macOS에서는 Homebrew, Linux apt/dnf/yum에서는 NodeSource 설치 스크립트 사용).
  </Step>
  <Step title="Git 보장">
    Git이 없는 경우 설치합니다.
  </Step>
  <Step title="OpenClaw 설치">
    - `npm` 방법(기본값): 전역 npm 설치
    - `git` 방법: 저장소를 복제/업데이트하고, pnpm으로 종속성을 설치하고 빌드한 후 `~/.local/bin/openclaw`에 래퍼 설치
  </Step>
  <Step title="설치 후 작업">
    - 업그레이드와 git 설치 시 `openclaw doctor --non-interactive` 실행 (최대한 노력)
    - 적절한 경우 온보딩 시도 (TTY가 있으며 온보딩이 비활성화되지 않았고 부트스트랩/설정 검사 통과)
    - 기본값으로 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### 소스 체크아웃 감지

OpenClaw 체크아웃 내부에서 실행된 경우 (`package.json` + `pnpm-workspace.yaml`에 의해 감지), 스크립트는 다음을 제안합니다:

- 체크아웃 사용 (`git`), 혹은
- 글로벌 설치 사용 (`npm`)

TTY가 없고 설치 방법이 설정되지 않은 경우, 기본값으로 `npm`을 사용하고 경고를 표시합니다.

잘못된 방법 선택이나 잘못된 `--install-method` 값으로 인해 스크립트가 코드 `2`로 종료됩니다.

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
  <Tab title="드라이 런">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="플래그 참조">

| 플래그                             | 설명                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| `--install-method npm\|git`        | 설치 방법 선택 (기본값: `npm`). 별칭: `--method`         |
| `--npm`                            | npm 방법의 단축키                                         |
| `--git`                            | git 방법의 단축키. 별칭: `--github`                      |
| `--version <version\|dist-tag>`    | npm 버전 또는 배포 태그 (기본값: `latest`)               |
| `--beta`                           | 사용 가능 시 beta 배포 태그 사용, 아닐 시 `latest` 대체   |
| `--git-dir <path>`                 | 체크아웃 디렉토리 (기본값: `~/openclaw`). 별칭: `--dir`  |
| `--no-git-update`                  | 기존 체크아웃의 `git pull` 건너뛰기                      |
| `--no-prompt`                      | 프롬프트 비활성화                                        |
| `--no-onboard`                     | 온보딩 건너뛰기                                          |
| `--onboard`                        | 온보딩 활성화                                            |
| `--dry-run`                        | 변경사항 적용 없이 작업 출력                              |
| `--verbose`                        | 디버그 출력 활성화 (`set -x`, npm notice-level 로그)      |
| `--help`                           | 사용법 표시 (`-h`)                                       |

  </Accordion>

  <Accordion title="환경 변수 참조">

| 변수                                       | 설명                                  |
| ------------------------------------------- | ------------------------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm`          | 설치 방법                             |
| `OPENCLAW_VERSION=latest\|next\|<semver>`   | npm 버전 또는 배포 태그              |
| `OPENCLAW_BETA=0\|1`                        | 사용 가능 시 beta 사용               |
| `OPENCLAW_GIT_DIR=<path>`                   | 체크아웃 디렉토리                     |
| `OPENCLAW_GIT_UPDATE=0\|1`                  | git 업데이트 토글                     |
| `OPENCLAW_NO_PROMPT=1`                      | 프롬프트 비활성화                     |
| `OPENCLAW_NO_ONBOARD=1`                     | 온보딩 건너뛰기                      |
| `OPENCLAW_DRY_RUN=1`                        | 드라이 런 모드                        |
| `OPENCLAW_VERBOSE=1`                        | 디버그 모드                           |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm 로그 레벨                        |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | sharp/libvips 동작 제어 (기본값: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
로컬 접두사(기본값 `~/.openclaw`)와 시스템 Node 종속성이 없는 환경을 위해 설계되었습니다.
</Info>

### 흐름 (install-cli.sh)

<Steps>
  <Step title="로컬 Node 런타임 설치">
    Node tarball을 `<prefix>/tools/node-v<version>`에 다운로드하고 SHA-256을 확인합니다 (기본값 `22.22.0`).
  </Step>
  <Step title="Git 보장">
    Git이 없는 경우, Linux에서는 apt/dnf/yum을 통해, macOS에서는 Homebrew를 통해 설치를 시도합니다.
  </Step>
  <Step title="접두사 아래에 OpenClaw 설치">
    npm을 사용하여 `<prefix>/bin/openclaw`에 래퍼를 작성한 후 접두사에 설치합니다.
  </Step>
</Steps>

### 예제 (install-cli.sh)

<Tabs>
  <Tab title="기본">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="사용자 정의 접두사 및 버전">
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
  <Accordion title="플래그 참조">

| 플래그                   | 설명                                                                         |
| ------------------------ | --------------------------------------------------------------------------- |
| `--prefix <path>`        | 설치 접두사 (기본값: `~/.openclaw`)                                          |
| `--version <ver>`        | OpenClaw 버전 또는 배포 태그 (기본값: `latest`)                               |
| `--node-version <ver>`   | Node 버전 (기본값: `22.22.0`)                                                |
| `--json`                 | NDJSON 이벤트 출력                                                           |
| `--onboard`              | 설치 후 `openclaw onboard` 실행                                              |
| `--no-onboard`           | 온보딩 건너뛰기 (기본값)                                                     |
| `--set-npm-prefix`       | Linux에서, 현재 npm 접두사가 쓰기 불가능할 경우 `~/.npm-global`로 강제 변경   |
| `--help`                 | 사용법 표시 (`-h`)                                                           |

  </Accordion>

  <Accordion title="환경 변수 참조">

| 변수                                       | 설명                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                    | 설치 접두사                                                            |
| `OPENCLAW_VERSION=<ver>`                    | OpenClaw 버전 또는 배포 태그                                           |
| `OPENCLAW_NODE_VERSION=<ver>`               | Node 버전                                                              |
| `OPENCLAW_NO_ONBOARD=1`                     | 온보딩 건너뛰기                                                        |
| `OPENCLAW_NPM_LOGLEVEL=error\|warn\|notice` | npm 로그 레벨                                                         |
| `OPENCLAW_GIT_DIR=<path>`                   | 오래된 `Peekaboo` 서브모듈 체크아웃 삭제 경로 (유산 제거 시 사용)        |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1`          | sharp/libvips 동작 제어 (기본값: `1`)                                  |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### 흐름 (install.ps1)

<Steps>
  <Step title="PowerShell + Windows 환경 보장">
    PowerShell 5+가 필요합니다.
  </Step>
  <Step title="Node.js 22+ 보장">
    부족할 경우, winget, Chocolatey, Scoop 순으로 설치를 시도합니다.
  </Step>
  <Step title="OpenClaw 설치">
    - `npm` 방법(기본값): 선택된 `-Tag`를 사용하여 전역 npm 설치
    - `git` 방법: 저장소를 복제/업데이트하고, pnpm으로 설치/빌드하고 `%USERPROFILE%\.local\bin\openclaw.cmd`에 래퍼 설치
  </Step>
  <Step title="설치 후 작업">
    필요한 bin 디렉토리를 사용자의 PATH에 추가하고, 업그레이드 및 git 설치 시 `openclaw doctor --non-interactive`를 실행합니다 (최대한 노력).
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
  <Tab title="사용자 정의 git 디렉토리">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="드라이 런">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
  <Tab title="디버그 추적">
    ```powershell
    # install.ps1에는 아직 전용 -Verbose 플래그가 없습니다.
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="플래그 참조">

| 플래그                        | 설명                                               |
| ----------------------------- | ------------------------------------------------ |
| `-InstallMethod npm\|git`     | 설치 방법 (기본값: `npm`)                          |
| `-Tag <tag>`                  | npm 배포 태그 (기본값: `latest`)                   |
| `-GitDir <path>`              | 체크아웃 디렉토리 (기본값: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                  | 온보딩 건너뛰기                                    |
| `-NoGitUpdate`                | `git pull` 건너뛰기                                |
| `-DryRun`                     | 작업만 출력                                        |

  </Accordion>

  <Accordion title="환경 변수 참조">

| 변수                                      | 설명                        |
| ------------------------------------------ | -------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\|npm`         | 설치 방법                   |
| `OPENCLAW_GIT_DIR=<path>`                  | 체크아웃 디렉토리           |
| `OPENCLAW_NO_ONBOARD=1`                    | 온보딩 건너뛰기             |
| `OPENCLAW_GIT_UPDATE=0`                    | git pull 비활성화           |
| `OPENCLAW_DRY_RUN=1`                       | 드라이 런 모드               |

  </Accordion>
</AccordionGroup>

<Note>
`-InstallMethod git`이 사용되고 Git이 없는 경우, 스크립트가 종료되고 Git for Windows 링크를 출력합니다.
</Note>

---

## CI와 자동화

일관된 실행을 위해 비상호작용 플래그/환경 변수를 사용하세요.

<Tabs>
  <Tab title="install.sh (비상호작용 npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (비상호작용 git)">
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
  <Accordion title="왜 Git이 필요한가요?">
    Git은 `git` 설치 방법에 필요합니다. `npm` 설치의 경우, 종속성이 git URL을 사용할 때 `spawn git ENOENT` 오류를 피하기 위해 Git이 체크/설치됩니다.
  </Accordion>

  <Accordion title="Linux에서 npm이 왜 EACCES 오류를 겪나요?">
    일부 Linux 설정에서는 npm 전역 접두사가 루트 소유 경로를 가리킵니다. `install.sh`는 접미사를 `~/.npm-global`로 변경하고, 해당 파일이 존재할 경우 셸 rc 파일에 PATH를 추가합니다.
  </Accordion>

  <Accordion title="sharp/libvips 문제">
    스크립트는 기본적으로 `SHARP_IGNORE_GLOBAL_LIBVIPS=1`로 설정되어 sharp가 시스템 libvips에 빌드되지 않도록 합니다. 재설정하려면:

    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

  </Accordion>

  <Accordion title='Windows: "npm 오류 spawn git / ENOENT"'>
    Windows용 Git을 설치하고, PowerShell을 다시 연 후 설치 프로그램을 다시 실행하세요.
  </Accordion>

  <Accordion title='Windows: "openclaw을 인식할 수 없습니다"'>
    `npm config get prefix` 명령어를 실행하여 `\bin`을 추가하고, 그 디렉토리를 사용자 PATH에 추가한 후 PowerShell을 다시 여세요.
  </Accordion>

  <Accordion title="Windows: 설치 프로그램의 자세한 출력 얻는 법">
    `install.ps1`은 현재 `-Verbose` 전환기를 제공하지 않습니다.
    스크립트 수준 진단을 위한 PowerShell 추적을 사용하세요:

    ```powershell
    Set-PSDebug -Trace 1
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    Set-PSDebug -Trace 0
    ```

  </Accordion>

  <Accordion title="설치 후 openclaw이 인식되지 않음">
    대개 PATH 문제입니다. [Node.js 문제 해결](/ko-KR/install/node#troubleshooting)을 참조하세요.
  </Accordion>
</AccordionGroup>