---
summary: "OpenClaw 설치 — 설치 스크립트, npm/pnpm, 소스에서 빌드, Docker 등"
read_when:
  - 시작하기 빠른 시작 외의 설치 방법이 필요할 때
  - 클라우드 플랫폼에 배포하려는 경우
  - 업데이트, 마이그레이션 또는 제거가 필요할 때
title: "설치"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:25:28Z
---

# 설치

이미 [Getting Started](/start/getting-started)를 완료하셨나요? 그렇다면 준비가 끝났습니다 — 이 페이지는 대체 설치 방법, 플랫폼별 지침, 그리고 유지 관리에 관한 내용입니다.

## 시스템 요구 사항

- **[Node 22+](/install/node)** ([설치 스크립트](#install-methods)가 누락된 경우 설치합니다)
- macOS, Linux 또는 Windows
- 소스에서 빌드하는 경우에만 `pnpm` 필요

<Note>
Windows 에서는 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)에서 OpenClaw 를 실행하는 것을 강력히 권장합니다.
</Note>

## 설치 방법

<Tip>
**설치 스크립트**는 OpenClaw 를 설치하는 권장 방법입니다. Node 감지, 설치, 온보딩을 한 단계로 처리합니다.
</Tip>

<AccordionGroup>
  <Accordion title="설치 스크립트" icon="rocket" defaultOpen>
    CLI 를 다운로드하고 npm 을 통해 전역으로 설치한 다음 온보딩 마법사를 실행합니다.

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    이상입니다 — 스크립트가 Node 감지, 설치, 온보딩을 모두 처리합니다.

    온보딩을 건너뛰고 바이너리만 설치하려면 다음을 사용하십시오.

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    모든 플래그, 환경 변수, CI/자동화 옵션에 대해서는 [Installer internals](/install/installer)를 참고하십시오.

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    이미 Node 22+ 가 설치되어 있고 설치를 직접 관리하고 싶다면 다음을 사용하십시오.

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp 빌드 오류가 발생하나요?">
          (macOS 에서 Homebrew 를 통해 설치하는 경우가 흔한) libvips 가 전역으로 설치되어 있고 `sharp` 가 실패한다면, 미리 빌드된 바이너리를 강제로 사용하십시오.

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          `sharp: Please add node-gyp to your dependencies` 가 표시된다면, 빌드 도구를 설치(macOS: Xcode CLT + `npm install -g node-gyp`)하거나 위의 환경 변수를 사용하십시오.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm 은 빌드 스크립트가 있는 패키지에 대해 명시적인 승인이 필요합니다. 첫 설치에서 "Ignored build scripts" 경고가 표시된 후, `pnpm approve-builds -g` 를 실행하고 나열된 패키지를 선택하십시오.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="소스에서" icon="github">
    기여자이거나 로컬 체크아웃에서 실행하려는 경우에 적합합니다.

    <Steps>
      <Step title="클론 및 빌드">
        [OpenClaw repo](https://github.com/openclaw/openclaw)를 클론한 후 빌드하십시오.

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="CLI 연결">
        `openclaw` 명령을 전역에서 사용할 수 있도록 합니다.

        ```bash
        pnpm link --global
        ```

        또는 링크를 건너뛰고, 리포지토리 내부에서 `pnpm openclaw ...` 를 통해 명령을 실행할 수 있습니다.
      </Step>
      <Step title="온보딩 실행">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    보다 심화된 개발 워크플로우에 대해서는 [Setup](/start/setup)을 참고하십시오.

  </Accordion>
</AccordionGroup>

## 기타 설치 방법

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    컨테이너화 또는 헤드리스 배포.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nix 를 통한 선언적 설치.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    자동화된 대규모 프로비저닝.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bun 런타임을 통한 CLI 전용 사용.
  </Card>
</CardGroup>

## 설치 후

모든 것이 정상적으로 작동하는지 확인하십시오.

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## 문제 해결: `openclaw` 을(를) 찾을 수 없음

<Accordion title="PATH 진단 및 수정">
  빠른 진단:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

`$(npm prefix -g)/bin` (macOS/Linux) 또는 `$(npm prefix -g)` (Windows) 가 `$PATH` 에 **포함되어 있지 않다면**, 셸에서 전역 npm 바이너리(`openclaw` 포함)를 찾을 수 없습니다.

해결 방법 — 셸 시작 파일(`~/.zshrc` 또는 `~/.bashrc`)에 이를 추가하십시오.

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows 에서는 `npm prefix -g` 의 출력 값을 PATH 에 추가하십시오.

그런 다음 새 터미널을 열거나(zsh 에서는 `rehash`, bash 에서는 `hash -r` 를 실행하십시오).
</Accordion>

## 업데이트 / 제거

<CardGroup cols={3}>
  <Card title="업데이트" href="/install/updating" icon="refresh-cw">
    OpenClaw 를 최신 상태로 유지합니다.
  </Card>
  <Card title="마이그레이션" href="/install/migrating" icon="arrow-right">
    새 머신으로 이동합니다.
  </Card>
  <Card title="제거" href="/install/uninstall" icon="trash-2">
    OpenClaw 를 완전히 제거합니다.
  </Card>
</CardGroup>
