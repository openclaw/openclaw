---
title: "Node.js"
summary: "OpenClaw를 위한 Node.js 설치 및 구성 — 버전 요구 사항, 설치 옵션 및 PATH 문제 해결"
read_when:
  - "OpenClaw를 설치하기 전에 Node.js를 설치해야 합니다"
  - "OpenClaw를 설치했지만 `openclaw` 명령어를 찾을 수 없습니다"
  - "npm install -g 가 권한 또는 PATH 문제로 실패합니다"
---

# Node.js

OpenClaw는 **Node 22 이상**이 필요합니다. [설치 스크립트](/ko-KR/install#install-methods)는 Node를 자동으로 감지하고 설치합니다. 이 페이지는 Node를 직접 설정하고 모든 것이 올바르게 연결되어 있는지 확인하고자 할 때 유용합니다 (버전, PATH, 전역 설치).

## 버전 확인

```bash
node -v
```

이 명령이 `v22.x.x` 이상을 출력하면 됩니다. Node가 설치되지 않았거나 버전이 너무 오래되었다면 아래 설치 방법 중 하나를 선택하세요.

## Node 설치

<Tabs>
  <Tab title="macOS">
    **Homebrew** (추천):

    ```bash
    brew install node
    ```

    또는 [nodejs.org](https://nodejs.org/)에서 macOS 설치 프로그램을 다운로드하세요.

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    아니면 아래 버전 관리자를 사용하세요.

  </Tab>
  <Tab title="Windows">
    **winget** (추천):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    또는 [nodejs.org](https://nodejs.org/)에서 Windows 설치 프로그램을 다운로드하세요.

  </Tab>
</Tabs>

<Accordion title="버전 관리자 사용 (nvm, fnm, mise, asdf)">
  버전 관리자를 사용하면 Node 버전 간에 쉽게 전환할 수 있습니다. 인기 있는 옵션들:

- [**fnm**](https://github.com/Schniz/fnm) — 빠르고 교차 플랫폼 지원
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux에서 널리 사용됨
- [**mise**](https://mise.jdx.dev/) — 여러 언어 지원 (Node, Python, Ruby 등)

fnm 사용 예시:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  버전 관리자가 셸 시작 파일 (`~/.zshrc` 또는 `~/.bashrc`)에 초기화되어 있는지 확인하세요. 그렇지 않으면 새 터미널 세션에서 `openclaw`를 찾지 못할 수 있습니다. 이는 PATH에 Node의 bin 디렉토리가 포함되지 않기 때문입니다.
  </Warning>
</Accordion>

## 문제 해결

### `openclaw: command not found`

이 경우는 거의 항상 npm의 전역 bin 디렉토리가 PATH에 없기 때문입니다.

<Steps>
  <Step title="전역 npm 접두사 찾기">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="PATH에 있는지 확인">
    ```bash
    echo "$PATH"
    ```

    출력에서 `<npm-prefix>/bin` (macOS/Linux) 또는 `<npm-prefix>` (Windows)를 찾으세요.

  </Step>
  <Step title="셸 시작 파일에 추가">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` 또는 `~/.bashrc`에 추가:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        그런 다음 새로운 터미널을 열거나 (zsh에서는 `rehash`, bash에서는 `hash -r` 실행).
      </Tab>
      <Tab title="Windows">
        `npm prefix -g`의 출력을 설정 → 시스템 → 환경 변수에서 시스템 PATH에 추가하세요.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g`에서 권한 오류 (Linux)

`EACCES` 오류가 발생하면 npm의 전역 접두사를 사용자 쓰기가 가능한 디렉토리로 전환하세요:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

`export PATH=...` 행을 `~/.bashrc` 또는 `~/.zshrc`에 추가하여 영구적으로 설정하세요.