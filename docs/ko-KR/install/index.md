---
title: "설치"
summary: "OpenClaw 설치 — 설치 스크립트, npm/pnpm, 소스에서 빌드, Docker 등"
read_when:
  - Getting Started 빠른 시작 외의 설치 방법이 필요할 때
  - 클라우드 플랫폼에 배포하고 싶을 때
  - 업데이트, 마이그레이션 또는 제거가 필요할 때
x-i18n:
  source_path: docs/install/index.md
---

# 설치

## 권장: 설치 스크립트

가장 빠른 설치 방법입니다. OS 를 감지하고, 필요하면 Node 를 설치하고, OpenClaw 를 설치한 후 온보딩을 실행합니다.

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

온보딩 없이 설치하려면:

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

모든 플래그와 CI/자동화 옵션에 대해서는 [설치 스크립트 상세](/install/installer)를 참고하세요.

## 시스템 요구사항

- **Node 24** (권장) 또는 Node 22.16+ — 설치 스크립트가 자동으로 처리합니다
- **macOS, Linux 또는 Windows** — 네이티브 Windows 와 WSL2 모두 지원됩니다. WSL2 가 더 안정적입니다. [Windows](/platforms/windows) 를 참고하세요.
- `pnpm` 은 소스에서 빌드할 때만 필요합니다

## 대안 설치 방법

### npm 또는 pnpm

이미 Node 를 직접 관리하고 있다면:

<Tabs>
  <Tab title="npm">
    ```bash
    npm install -g openclaw@latest
    openclaw onboard --install-daemon
    ```
  </Tab>
  <Tab title="pnpm">
    ```bash
    pnpm add -g openclaw@latest
    pnpm approve-builds -g
    openclaw onboard --install-daemon
    ```

    <Note>
    pnpm 은 빌드 스크립트가 있는 패키지에 대해 명시적 승인이 필요합니다. 첫 설치 후 `pnpm approve-builds -g` 를 실행하세요.
    </Note>

  </Tab>
</Tabs>

<Accordion title="문제 해결: sharp 빌드 오류 (npm)">
  전역 설치된 libvips 로 인해 `sharp` 가 실패하는 경우:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
```

</Accordion>

### 소스에서 빌드

기여자이거나 로컬 체크아웃에서 실행하고 싶은 분을 위한 방법입니다:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install && pnpm ui:build && pnpm build
pnpm link --global
openclaw onboard --install-daemon
```

또는 link 를 건너뛰고 저장소 내부에서 `pnpm openclaw ...` 를 사용할 수 있습니다. 전체 개발 워크플로우는 [설정](/start/setup)을 참고하세요.

### GitHub main 에서 설치

```bash
npm install -g github:openclaw/openclaw#main
```

### 컨테이너 및 패키지 매니저

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    컨테이너화 또는 헤드리스 배포.
  </Card>
  <Card title="Podman" href="/install/podman" icon="container">
    Docker 의 루트리스 컨테이너 대안.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Nix flake 를 통한 선언적 설치.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    자동화된 플릿 프로비저닝.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Bun 런타임을 통한 CLI 전용 사용.
  </Card>
</CardGroup>

## 설치 확인

```bash
openclaw --version      # CLI 사용 가능 여부 확인
openclaw doctor         # 설정 문제 확인
openclaw gateway status # Gateway 실행 여부 확인
```

## 호스팅 및 배포

클라우드 서버 또는 VPS 에 OpenClaw 를 배포합니다:

<CardGroup cols={3}>
  <Card title="VPS" href="/vps">모든 Linux VPS</Card>
  <Card title="Docker VM" href="/install/docker-vm-runtime">공유 Docker 단계</Card>
  <Card title="Kubernetes" href="/install/kubernetes">K8s</Card>
  <Card title="Fly.io" href="/install/fly">Fly.io</Card>
  <Card title="Hetzner" href="/install/hetzner">Hetzner</Card>
  <Card title="GCP" href="/install/gcp">Google Cloud</Card>
  <Card title="Azure" href="/install/azure">Azure</Card>
  <Card title="Railway" href="/install/railway">Railway</Card>
  <Card title="Render" href="/install/render">Render</Card>
  <Card title="Northflank" href="/install/northflank">Northflank</Card>
</CardGroup>

## 업데이트, 마이그레이션 또는 제거

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

## 문제 해결: `openclaw` 을 찾을 수 없음

설치에 성공했지만 터미널에서 `openclaw` 을 찾을 수 없는 경우:

```bash
node -v           # Node 가 설치되어 있나요?
npm prefix -g     # 전역 패키지가 어디에 있나요?
echo "$PATH"      # 전역 bin 디렉토리가 PATH 에 있나요?
```

`$(npm prefix -g)/bin` 이 `$PATH` 에 없으면 셸 시작 파일 (`~/.zshrc` 또는 `~/.bashrc`) 에 추가하세요:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

그런 다음 새 터미널을 열어주세요. 자세한 내용은 [Node 설정](/install/node)을 참고하세요.
