---
read_when:
    - OpenClaw를 설치하기 전에 Node.js를 설치해야 합니다.
    - OpenClaw를 설치했지만 `openclaw` 명령을 찾을 수 없습니다.
    - npm install -g가 권한 또는 PATH 문제로 인해 실패합니다.
summary: OpenClaw용 Node.js 설치 및 구성 — 버전 요구 사항, 설치 옵션 및 PATH 문제 해결
title: Node.js
x-i18n:
    generated_at: "2026-02-08T15:57:54Z"
    model: gtx
    provider: google-translate
    source_hash: f848d6473a1830904f7e75bb211161cfb22ac7a4de6623835cad1444a18f0579
    source_path: install/node.md
    workflow: 15
---

# Node.js

OpenClaw에는 다음이 필요합니다. **노드 22 이상**. 그만큼 [설치 프로그램 스크립트](/install#install-methods) Node를 자동으로 감지하고 설치합니다. 이 페이지는 Node를 직접 설정하고 모든 것이 올바르게 연결되었는지 확인하려는 경우(버전, PATH, 전역 설치)를 위한 것입니다.

## 버전을 확인하세요

```bash
node -v
```

이것이 인쇄되면 `v22.x.x` 이상이라면 괜찮습니다. Node가 설치되지 않았거나 버전이 너무 오래된 경우 아래에서 설치 방법을 선택하세요.

## 노드 설치

<Tabs>
  <Tab title="macOS">
    **홈브루**(권장):

    ```bash
    brew install node
    ```

    Or download the macOS installer from [nodejs.org](https://nodejs.org/).

  </Tab>
  <Tab title="Linux">
    **우분투/데비안:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    Or use a version manager (see below).

  </Tab>
  <Tab title="Windows">
    **윙겟**(권장):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    Or download the Windows installer from [nodejs.org](https://nodejs.org/).

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  버전 관리자를 사용하면 Node 버전 간을 쉽게 전환할 수 있습니다. 인기 있는 옵션:

- [**fnm**](https://github.com/Schniz/fnm) — 빠른 크로스 플랫폼
- [**NVM**](https://github.com/nvm-sh/nvm) — macOS/Linux에서 널리 사용됨
- [**미스**](https://mise.jdx.dev/) — 다중 언어(노드, Python, Ruby 등)

fnm의 예:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  버전 관리자가 셸 시작 파일(`~/.zshrc` 또는 `~/.bashrc`)에서 초기화되었는지 확인하세요. 그렇지 않은 경우 PATH에 노드의 bin 디렉터리가 포함되지 않기 때문에 새 터미널 세션에서 `openclaw`을 찾지 못할 수 있습니다.
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

    Look for `<npm-prefix>/bin` (macOS/Linux) or `<npm-prefix>` (Windows) in the output.

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` 또는 `~/.bashrc`에 추가합니다.

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        Then open a new terminal (or run `rehash` in zsh / `hash -r` in bash).
      </Tab>
      <Tab title="Windows">
        Add the output of `npm prefix -g` to your system PATH via Settings → System → Environment Variables.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### 권한 오류 `npm install -g` (리눅스)

당신이 본다면 `EACCES` 오류가 발생하면 npm의 전역 접두사를 사용자가 쓸 수 있는 디렉터리로 전환하세요.

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

추가 `export PATH=...` 당신의 라인 `~/.bashrc` 또는 `~/.zshrc` 영구적으로 만들려면.
