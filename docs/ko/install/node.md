---
title: "Node.js"
summary: "OpenClaw 를 위한 Node.js 설치 및 구성 — 버전 요구 사항, 설치 옵션, PATH 문제 해결"
read_when:
  - "OpenClaw 를 설치하기 전에 Node.js 를 설치해야 할 때"
  - "OpenClaw 를 설치했지만 `openclaw` 명령을 찾을 수 없을 때"
  - "npm install -g 가 권한 또는 PATH 문제로 실패할 때"
---

# Node.js

OpenClaw 는 **Node 22 이상**이 필요합니다. [설치 스크립트](/install#install-methods)는 Node 를 자동으로 감지하고 설치하지만, 이 페이지는 Node 를 직접 설정하고 모든 것이 올바르게 연결되었는지(버전, PATH, 전역 설치) 확인하고자 할 때를 위한 문서입니다.

## 버전 확인

```bash
node -v
```

이 명령이 `v22.x.x` 이상을 출력하면 문제가 없습니다. Node 가 설치되어 있지 않거나 버전이 너무 오래되었다면 아래의 설치 방법 중 하나를 선택하십시오.

## Node 설치

<Tabs>
  <Tab title="macOS">
    **Homebrew** (권장):

    ````
    ```bash
    brew install node
    ```
    
    또는 [nodejs.org](https://nodejs.org/) 에서 macOS 설치 프로그램을 다운로드하십시오.
    ````

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ````
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
    
    **Fedora / RHEL:**
    
    ```bash
    sudo dnf install nodejs
    ```
    
    또는 버전 매니저를 사용할 수 있습니다(아래 참조).
    ````

  </Tab>
  <Tab title="Windows">
    **winget** (권장):

    ````
    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```
    
    **Chocolatey:**
    
    ```powershell
    choco install nodejs-lts
    ```
    
    또는 [nodejs.org](https://nodejs.org/) 에서 Windows 설치 프로그램을 다운로드하십시오.
    ````

  </Tab>
</Tabs>

<Accordion title="Using a version manager (nvm, fnm, mise, asdf)">
  버전 매니저를 사용하면 Node 버전을 쉽게 전환할 수 있습니다. 널리 사용되는 옵션은 다음과 같습니다.

- [**fnm**](https://github.com/Schniz/fnm) — 빠르고 크로스 플랫폼
- [**nvm**](https://github.com/nvm-sh/nvm) — macOS / Linux 에서 널리 사용됨
- [**mise**](https://mise.jdx.dev/) — 다언어 지원 (Node, Python, Ruby 등)

fnm 사용 예시:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  버전 매니저가 셸 시작 파일(`~/.zshrc` 또는 `~/.bashrc`)에서 초기화되어 있는지 확인하십시오. 초기화되어 있지 않으면 PATH 에 Node 의 bin 디렉토리가 포함되지 않아 새 터미널 세션에서 `openclaw` 를 찾지 못할 수 있습니다.
  </Warning>
</Accordion>

## 문제 해결

### `openclaw: command not found`

이는 거의 항상 npm 의 전역 bin 디렉토리가 PATH 에 포함되어 있지 않다는 의미입니다.

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

    ```
    출력에서 `<npm-prefix>/bin` (macOS / Linux) 또는 `<npm-prefix>` (Windows) 를 확인하십시오.
    ```

  </Step>
  <Step title="Add it to your shell startup file">
    <Tabs>
      <Tab title="macOS / Linux">
        `~/.zshrc` 또는 `~/.bashrc` 에 추가하십시오:

        ```
            ```bash
            export PATH="$(npm prefix -g)/bin:$PATH"
            ```
        
            그런 다음 새 터미널을 열거나(zsh 에서는 `rehash`, bash 에서는 `hash -r` 실행) 변경 사항을 적용하십시오.
          </Tab>
          <Tab title="Windows">
            `npm prefix -g` 의 출력 값을 설정 → 시스템 → 환경 변수에서 시스템 PATH 에 추가하십시오.
          </Tab>
        </Tabs>
        ```

  </Step>
</Steps>

### `npm install -g` 에서의 권한 오류 (Linux)

`EACCES` 오류가 표시된다면 npm 의 전역 prefix 를 사용자 쓰기 가능한 디렉토리로 변경하십시오:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

영구적으로 적용하려면 `export PATH=...` 줄을 `~/.bashrc` 또는 `~/.zshrc` 에 추가하십시오.
