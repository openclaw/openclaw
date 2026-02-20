---
summary: "OpenClaw 설치 — 설치 스크립트, npm/pnpm, 소스에서, Docker 등 다양한 방법"
read_when:
  - 시작하기 퀵스타트 이외의 설치 방법이 필요합니다
  - 클라우드 플랫폼에 배포하려고 합니다
  - 업데이트, 마이그레이션 또는 제거가 필요합니다
title: "설치하기"
---

# Install

[시작하기](/ko-KR/start/getting-started)를 이미 완료하셨나요? 그렇다면 준비가 완료되었습니다. 이 페이지는 대체 설치 방법, 플랫폼별 지침 및 유지보수를 위한 것입니다.

## 시스템 요구 사항

- **[Node 22+](/ko-KR/install/node)** ([설치 방법](#install-methods) 스크립트에 의해 설치 가능)
- macOS, Linux 또는 Windows
- 소스에서 빌드할 경우에만 `pnpm`

<Note>
Windows에서 OpenClaw를 실행하려면 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install)를 강력히 권장합니다.
</Note>

## 설치 방법

<Tip>
**설치 스크립트**는 OpenClaw를 설치하는 데 권장되는 방법입니다. Node 감지, 설치 및 온보딩을 한 번에 처리합니다.
</Tip>

<Warning>
VPS/클라우드 호스트의 경우, 가능한 한 타사 "1-클릭" 마켓플레이스 이미지는 피하세요. 깨끗한 기본 OS 이미지(예: Ubuntu LTS)를 선호하고, 설치 스크립트로 직접 OpenClaw를 설치하세요.
</Warning>

<AccordionGroup>
  <Accordion title="설치 스크립트" icon="rocket" defaultOpen>
    CLI를 다운로드하여 npm을 통해 전역 설치하고 온보딩 마법사를 실행합니다.

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

    이것으로 완료입니다. 스크립트가 Node 감지, 설치 및 온보딩을 처리합니다.

    온보딩을 건너뛰고 이진 파일만 설치하려면:

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

    모든 플래그, 환경 변수 및 CI/자동화 옵션에 대한 자세한 내용은 [Installer internals](/ko-KR/install/installer)를 참조하세요.

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Node 22+를 이미 가지고 있고 설치를 직접 관리하려는 경우:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp 빌드 오류?">
          macOS의 Homebrew를 통해 일반적으로 libvips가 전역 설치되어 있고 `sharp` 설치에 실패하는 경우, 미리 빌드된 바이너리로 강제 설치:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          `sharp: Please add node-gyp to your dependencies` 라는 메시지가 표시되면, 빌드 도구(macOS: Xcode CLT + `npm install -g node-gyp`)를 설치하거나 위의 환경 변수를 사용하십시오.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm은 빌드 스크립트가 있는 패키지에 대한 명확한 승인을 요구합니다. 첫 번째 설치 후 "Ignored build scripts" 경고가 표시되면 `pnpm approve-builds -g`를 실행하고 나열된 패키지를 선택하세요.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="소스에서" icon="github">
    기여자 또는 로컬 체크아웃에서 실행하려는 모든 사람을 위해.

    <Steps>
      <Step title="클론 및 빌드">
        [OpenClaw 저장소](https://github.com/openclaw/openclaw)를 클론하고 빌드합니다:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="CLI 링크">
        `openclaw` 명령어를 전역적으로 사용할 수 있도록 합니다:

        ```bash
        pnpm link --global
        ```

        또는, 링크를 건너뛰고 리포지토리 내에서 `pnpm openclaw ...`를 통해 명령어를 실행합니다.
      </Step>
      <Step title="온보딩 실행">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    더 깊은 개발 워크플로우는 [Setup](/ko-KR/start/setup)를 참조하십시오.

  </Accordion>
</AccordionGroup>

## 다른 설치 방법

<CardGroup cols={2}>
  <Card title="Docker" href="/ko-KR/install/docker" icon="container">
    컨테이너화된 배포 또는 헤드리스 배포.
  </Card>
  <Card title="Podman" href="/ko-KR/install/podman" icon="container">
    루트리스 컨테이너: `setup-podman.sh`를 한 번 실행한 후 시작 스크립트를 실행하세요.
  </Card>
  <Card title="Nix" href="/ko-KR/install/nix" icon="snowflake">
    Nix를 통한 선언적 설치.
  </Card>
  <Card title="Ansible" href="/ko-KR/install/ansible" icon="server">
    자동화된 플릿 프로비저닝.
  </Card>
  <Card title="Bun" href="/ko-KR/install/bun" icon="zap">
    Bun 런타임을 통한 CLI 전용 사용.
  </Card>
</CardGroup>

## 설치 후

모든 것이 제대로 작동하는지 확인하세요:

```bash
openclaw doctor         # 설정 문제 확인
openclaw status         # 게이트웨이 상태
openclaw dashboard      # 브라우저 UI 열기
```

사용자 지정 런타임 경로가 필요한 경우, 다음을 사용하세요:

- `OPENCLAW_HOME` 내부 경로에 대한 홈 디렉토리 기반 경로
- `OPENCLAW_STATE_DIR` 가변 상태 위치
- `OPENCLAW_CONFIG_PATH` 구성 파일 위치

우선순위 및 자세한 내용에 대해 [Environment vars](/ko-KR/help/environment)를 참조하세요.

## 문제 해결: `openclaw`를 찾을 수 없음

<Accordion title="PATH 진단 및 수정">
  빠른 진단:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

`$(npm prefix -g)/bin` (macOS/Linux) 또는 `$(npm prefix -g)` (Windows)이 `$PATH`에 **없다면**, 쉘이 전역 npm 바이너리(예: `openclaw`)를 찾을 수 없습니다.

수정 방법 — 쉘 시작 파일(`~/.zshrc` 또는 `~/.bashrc`)에 추가하세요:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows에서는 `npm prefix -g`의 출력을 PATH에 추가하세요.

그런 다음 새 터미널을 열거나 zsh에서 `rehash`, bash에서 `hash -r`을 실행하세요.
</Accordion>

## 업데이트 / 제거

<CardGroup cols={3}>
  <Card title="업데이트" href="/ko-KR/install/updating" icon="refresh-cw">
    OpenClaw를 최신 상태로 유지합니다.
  </Card>
  <Card title="마이그레이션" href="/ko-KR/install/migrating" icon="arrow-right">
    새 머신으로 이동합니다.
  </Card>
  <Card title="제거" href="/ko-KR/install/uninstall" icon="trash-2">
    OpenClaw를 완전히 제거합니다.
  </Card>
</CardGroup>
