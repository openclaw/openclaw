---
summary: "Install OpenClaw — installer script, npm/pnpm, from source, Docker, and more"
read_when:
  - You need an install method other than the Getting Started quickstart
  - You want to deploy to a cloud platform
  - You need to update, migrate, or uninstall
title: "Install"
x-i18n:
  source_hash: ff30589c4ea420399dcb323f0ed036be9f2fffdc20f43aa6707fdf7d1d50c526
---

# 설치

이미 [시작하기](/start/getting-started)를 팔로우하고 계신가요? 모든 설정이 완료되었습니다. 이 페이지에서는 대체 설치 방법, 플랫폼별 지침 및 유지 관리에 대해 설명합니다.

## 시스템 요구사항

- **[Node 22+](/install/node)** (누락된 경우 [설치 프로그램 스크립트](#install-methods)가 설치합니다)
- macOS, Linux 또는 Windows
- `pnpm` 소스에서 빌드하는 경우에만 해당

<Note>
Windows에서는 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)에서 OpenClaw를 실행하는 것이 좋습니다.
</Note>

## 설치 방법

<Tip>
**설치 프로그램 스크립트**는 OpenClaw를 설치하는 데 권장되는 방법입니다. 노드 감지, 설치, 온보딩을 한 단계로 처리합니다.
</Tip>

<AccordionGroup>
  <Accordion title="Installer script" icon="rocket" defaultOpen>
    CLI를 다운로드하고 npm을 통해 전역적으로 설치한 후 온보딩 마법사를 시작합니다.

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

    그게 전부입니다. 스크립트는 노드 감지, 설치 및 온보딩을 처리합니다.

    온보딩을 건너뛰고 바이너리만 설치하려면:

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

    모든 플래그, 환경 변수 및 CI/자동화 옵션은 [설치 프로그램 내부](/install/installer)를 참조하세요.

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    이미 Node 22+가 있고 설치를 직접 관리하려는 경우:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp build errors?">
          libvips가 전역적으로 설치되어 있고(Homebrew를 통해 macOS에서 일반적임) `sharp`가 실패하는 경우 사전 빌드된 바이너리를 강제 실행합니다.

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          `sharp: Please add node-gyp to your dependencies`가 표시되면 빌드 도구(macOS: Xcode CLT + `npm install -g node-gyp`)를 설치하거나 위의 env var를 사용하세요.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm에는 빌드 스크립트가 포함된 패키지에 대한 명시적인 승인이 필요합니다. 첫 번째 설치에서 "빌드 스크립트 무시" 경고가 표시되면 `pnpm approve-builds -g`를 실행하고 나열된 패키지를 선택합니다.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="From source" icon="github">
    기여자 또는 지역 결제에서 실행하려는 모든 사람을 위한 것입니다.

    <Steps>
      <Step title="Clone and build">
        [OpenClaw 저장소](https://github.com/openclaw/openclaw)를 복제하고 다음을 빌드합니다.

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Link the CLI">
        `openclaw` 명령을 전역적으로 사용할 수 있도록 설정합니다.

        ```bash
        pnpm link --global
        ```

        또는 링크를 건너뛰고 저장소 내부에서 `pnpm openclaw ...`를 통해 명령을 실행하세요.
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    보다 심층적인 개발 워크플로는 [설정](/start/setup)을 참조하세요.

  </Accordion>
</AccordionGroup>

## 기타 설치 방법

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    컨테이너화된 또는 헤드리스 배포.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nix를 통한 선언적 설치.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    자동화된 차량 프로비저닝.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bun 런타임을 통한 CLI 전용 사용.
  </Card>
</CardGroup>

## 설치 후

모든 것이 작동하는지 확인합니다.

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

사용자 정의 런타임 경로가 필요한 경우 다음을 사용하십시오.

- 홈 디렉토리 기반 내부 경로의 경우 `OPENCLAW_HOME`
- `OPENCLAW_STATE_DIR` 변경 가능한 상태 위치
- `OPENCLAW_CONFIG_PATH` 구성 파일 위치

우선순위와 자세한 내용은 [환경 변수](/help/environment)를 참조하세요.

## 문제 해결: `openclaw` 찾을 수 없음

<Accordion title="PATH diagnosis and fix">
  빠른 진단:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

`$(npm prefix -g)/bin` (macOS/Linux) 또는 `$(npm prefix -g)` (Windows)가 `$PATH`에 **아닌** 경우, 쉘은 전역 npm 바이너리(`openclaw` 포함)를 찾을 수 없습니다.

수정 — 쉘 시작 파일(`~/.zshrc` 또는 `~/.bashrc`)에 추가하세요.

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows에서는 `npm prefix -g` 출력을 PATH에 추가합니다.

그런 다음 새 터미널을 엽니다(또는 zsh에서는 `rehash` / bash에서는 `hash -r`).
</Accordion>

## 업데이트/제거

<CardGroup cols={3}>
  <Card title="Updating" href="/install/updating" icon="refresh-cw">
    OpenClaw를 최신 상태로 유지하세요.
  </Card>
  <Card title="Migrating" href="/install/migrating" icon="arrow-right">
    새 기계로 이동합니다.
  </Card>
  <Card title="Uninstall" href="/install/uninstall" icon="trash-2">
    OpenClaw를 완전히 제거하십시오.
  </Card>
</CardGroup>
