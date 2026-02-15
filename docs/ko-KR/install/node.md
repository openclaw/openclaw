---
title: "Node.js"
summary: "Install and configure Node.js for OpenClaw — version requirements, install options, and PATH troubleshooting"
read_when:
  - "You need to install Node.js before installing OpenClaw"
  - "You installed OpenClaw but `openclaw` is command not found"
  - "npm install -g fails with permissions or PATH issues"
x-i18n:
  source_hash: f848d6473a1830904f7e75bb211161cfb22ac7a4de6623835cad1444a18f0579
---

# Node.js

OpenClaw에는 **노드 22 이상**이 필요합니다. [설치 프로그램 스크립트](/install#install-methods)는 Node를 자동으로 감지하고 설치합니다. 이 페이지는 Node를 직접 설정하고 모든 것이 올바르게 연결되었는지 확인하려는 경우에 사용됩니다(버전, PATH, 전역 설치).

## 버전을 확인하세요

```bash
node -v
```

`v22.x.x` 이상이 인쇄되면 괜찮습니다. Node가 설치되지 않았거나 버전이 너무 오래된 경우 아래에서 설치 방법을 선택하세요.

## 노드 설치

<Tabs>
  <Tab title="macOS">
    **홈브루**(권장):

    ```bash
    brew install node
    ```

    또는 [nodejs.org](https://nodejs.org/)에서 macOS 설치 프로그램을 다운로드하세요.

  </Tab>
  <Tab title="Linux">
    **우분투/데비안:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **페도라/RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    또는 버전 관리자를 사용하세요(아래 참조).

  </Tab>
  <Tab title="Windows">
    **윙겟**(권장):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **초콜릿:**

    ```powershell
    choco install nodejs-lts
    ```

    또는 [nodejs.org](https://nodejs.org/)에서 Windows 설치 프로그램을 다운로드하세요.

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  버전 관리자를 사용하면 Node 버전 간을 쉽게 전환할 수 있습니다. 인기 있는 옵션:

- [**fnm**](https://github.com/Schniz/fnm) — 빠른 크로스 플랫폼
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS/Linux에서 널리 사용됨
- [**mise**](https://mise.jdx.dev/) — 다중 언어(Node, Python, Ruby 등)

fnm의 예:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  버전 관리자가 쉘 시작 파일(`~/.zshrc` 또는 `~/.bashrc`)에서 초기화되었는지 확인하세요. 그렇지 않은 경우 PATH에 노드의 bin 디렉터리가 포함되지 않기 때문에 새 터미널 세션에서 `openclaw`를 찾을 수 없습니다.
  </Warning>
</Accordion>

## 문제 해결

### `openclaw: command not found`

이는 거의 항상 npm의 전역 bin 디렉터리가 PATH에 없음을 의미합니다.

<Steps>
  <Step title="Find your global npm prefix">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Check if it's on your PATH">
    ```bash
    echo "$PATH"
    ```

    출력에서 `<npm-prefix>/bin`(macOS/Linux) 또는 `<npm-prefix>`(Windows)를 찾습니다.

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` 또는 `~/.bashrc`에 추가:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        그런 다음 새 터미널을 엽니다(또는 zsh에서 `rehash` 실행 / bash에서 `hash -r` 실행).
      </Tab>
      <Tab title="Windows">
        설정 → 시스템 → 환경 변수를 통해 시스템 PATH에 `npm prefix -g` 출력을 추가합니다.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g`에 대한 권한 오류(Linux)

`EACCES` 오류가 표시되면 npm의 전역 접두사를 사용자가 쓸 수 있는 디렉터리로 전환하세요.

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

`export PATH=...` 줄을 `~/.bashrc` 또는 `~/.zshrc`에 추가하여 영구적으로 만드세요.
