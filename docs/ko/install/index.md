---
read_when:
    - 시작하기 빠른 시작 이외의 설치 방법이 필요합니다.
    - 클라우드 플랫폼에 배포하고 싶습니다.
    - 업데이트, 마이그레이션 또는 제거가 필요합니다.
summary: OpenClaw 설치 — 소스, Docker 등의 설치 프로그램 스크립트 npm/pnpm
title: 설치하다
x-i18n:
    generated_at: "2026-02-08T15:56:03Z"
    model: gtx
    provider: google-translate
    source_hash: 67c029634ba381960d4109097b5963a1225d8c84399fee40ee75464f4374d214
    source_path: install/index.md
    workflow: 15
---

# 설치하다

이미 팔로우했습니다 [시작하기](/start/getting-started)? 모든 설정이 완료되었습니다. 이 페이지에서는 대체 설치 방법, 플랫폼별 지침 및 유지 관리에 대해 설명합니다.

## 시스템 요구사항

- **[노드 22+](/install/node)** (그만큼 [설치 프로그램 스크립트](#install-methods) 누락된 경우 설치해 드립니다)
- macOS, Linux 또는 Windows
- `pnpm` 소스에서 빌드하는 경우에만

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

    That's it — the script handles Node detection, installation, and onboarding.

    To skip onboarding and just install the binary:

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

    For all flags, env vars, and CI/automation options, see [Installer internals](/install/installer).

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
          If you have libvips installed globally (common on macOS via Homebrew) and `sharp` fails, force prebuilt binaries:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          If you see `sharp: Please add node-gyp to your dependencies`, either install build tooling (macOS: Xcode CLT + `npm install -g node-gyp`) or use the env var above.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm requires explicit approval for packages with build scripts. After the first install shows the "Ignored build scripts" warning, run `pnpm approve-builds -g` and select the listed packages.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="From source" icon="github">
    기여자 또는 지역 결제에서 실행하려는 모든 사람을 위한 것입니다.

    <Steps>
      <Step title="Clone and build">
        Clone the [OpenClaw repo](https://github.com/openclaw/openclaw) and build:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Link the CLI">
        Make the `openclaw` command available globally:

        ```bash
        pnpm link --global
        ```

        Alternatively, skip the link and run commands via `pnpm openclaw ...` from inside the repo.
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    For deeper development workflows, see [Setup](/start/setup).

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

## 문제 해결: `openclaw` 찾을 수 없음

<Accordion title="PATH diagnosis and fix">
  빠른 진단:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

만약에 `$(npm prefix -g)/bin` (맥OS/리눅스) 또는 `$(npm prefix -g)` (윈도우)는 **~ 아니다** 당신의 `$PATH`, 쉘은 전역 npm 바이너리(포함)를 찾을 수 없습니다. `openclaw`).

수정 — 쉘 시작 파일(`~/.zshrc` 또는 `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows에서는 다음의 출력을 추가하세요. `npm prefix -g` 당신의 PATH에.

그런 다음 새 터미널을 엽니다(또는 `rehash` zsh에서 / `hash -r` 배쉬에서).
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
