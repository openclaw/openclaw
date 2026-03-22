---
title: "Node.js"
summary: "OpenClaw 를 위한 Node.js 설치 및 구성 — 버전 요구사항, 설치 옵션 및 PATH 문제 해결"
read_when:
  - "OpenClaw 설치 전에 Node.js 를 설치해야 할 때"
  - "OpenClaw 를 설치했지만 `openclaw` 명령어를 찾을 수 없을 때"
  - "npm install -g 가 권한 또는 PATH 문제로 실패할 때"
x-i18n:
  source_path: docs/install/node.md
---

# Node.js

OpenClaw 는 **Node 22.16 이상**이 필요합니다. **Node 24 가 설치, CI 및 릴리스 워크플로우의 기본 권장 런타임**입니다. Node 22 는 활성 LTS 라인을 통해 계속 지원됩니다. [설치 스크립트](/install#alternative-install-methods)가 자동으로 Node 를 감지하고 설치합니다. 이 페이지는 Node 를 직접 설정하고 모든 것이 올바르게 연결되어 있는지 (버전, PATH, 전역 설치) 확인하고 싶을 때를 위한 것입니다.

## 버전 확인

```bash
node -v
```

`v24.x.x` 이상이 출력되면 권장 기본값을 사용하고 있는 것입니다. `v22.16.x` 이상이 출력되면 지원되는 Node 22 LTS 경로를 사용하고 있지만, 편의에 따라 Node 24 로 업그레이드하는 것을 권장합니다. Node 가 설치되지 않았거나 버전이 너무 오래된 경우 아래에서 설치 방법을 선택하세요.

## Node 설치

<Tabs>
  <Tab title="macOS">
    **Homebrew** (권장):

    ```bash
    brew install node
    ```

    또는 [nodejs.org](https://nodejs.org/) 에서 macOS 설치 프로그램을 다운로드하세요.

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    또는 버전 매니저를 사용하세요 (아래 참고).

  </Tab>
  <Tab title="Windows">
    **winget** (권장):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    또는 [nodejs.org](https://nodejs.org/) 에서 Windows 설치 프로그램을 다운로드하세요.

  </Tab>
</Tabs>

<Accordion title="버전 매니저 사용 (nvm, fnm, mise, asdf)">
  버전 매니저를 사용하면 Node 버전을 쉽게 전환할 수 있습니다. 인기 있는 옵션:

- [**fnm**](https://github.com/Schniz/fnm) — 빠르고 크로스 플랫폼
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux 에서 널리 사용
- [**mise**](https://mise.jdx.dev/) — 폴리글랏 (Node, Python, Ruby 등)

fnm 예제:

```bash
fnm install 24
fnm use 24
```

  <Warning>
  셸 시작 파일 (`~/.zshrc` 또는 `~/.bashrc`) 에서 버전 매니저가 초기화되어 있는지 확인하세요. 초기화되지 않으면 PATH 에 Node 의 bin 디렉토리가 포함되지 않아 새 터미널 세션에서 `openclaw` 을 찾을 수 없습니다.
  </Warning>
</Accordion>

## 문제 해결

### `openclaw: command not found`

이것은 거의 항상 npm 의 전역 bin 디렉토리가 PATH 에 없다는 것을 의미합니다.

<Steps>
  <Step title="전역 npm 프리픽스 찾기">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="PATH 에 있는지 확인">
    ```bash
    echo "$PATH"
    ```

    출력에서 `<npm-prefix>/bin` (macOS/Linux) 또는 `<npm-prefix>` (Windows) 를 찾아보세요.

  </Step>
  <Step title="셸 시작 파일에 추가">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` 또는 `~/.bashrc` 에 추가:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        그런 다음 새 터미널을 열거나 (zsh 에서 `rehash` / bash 에서 `hash -r` 를 실행하세요).
      </Tab>
      <Tab title="Windows">
        `npm prefix -g` 의 출력을 설정 > 시스템 > 환경 변수를 통해 시스템 PATH 에 추가하세요.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g` 권한 오류 (Linux)

`EACCES` 오류가 발생하면 npm 의 전역 프리픽스를 사용자 쓰기 가능 디렉토리로 전환하세요:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

영구적으로 적용하려면 `export PATH=...` 라인을 `~/.bashrc` 또는 `~/.zshrc` 에 추가하세요.
