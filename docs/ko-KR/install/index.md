---
summary: "OpenClaw 를 설치합니다 — 설치자 스크립트, npm/pnpm, 소스에서, Docker 등"
read_when:
  - Getting Started 빠른 시작 이외의 설치 방법이 필요할 때
  - 클라우드 플랫폼에 배포하려고 할 때
  - 업데이트, 마이그레이션 또는 제거해야 할 때
title: "설치"
---

# 설치

[Getting Started](/start/getting-started) 를 이미 따랐습니까? 완료되었습니다 — 이 페이지는 대체 설치 방법, 플랫폼 특정 지침 및 유지보수입니다.

## 시스템 요구 사항

- **[Node 22+](/install/node)** ([설치자 스크립트](#설치-방법) 누락된 경우 설치합니다)
- macOS, Linux 또는 Windows
- 소스에서 빌드하는 경우에만 `pnpm`

Windows 에서는 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) 아래에서 OpenClaw 를 실행하는 것을 권장합니다.

## 설치 방법

**설치자 스크립트** 는 OpenClaw 를 설치하는 권장 방법입니다. Node 검색, 설치 및 온보딩을 한 단계로 처리합니다.

VPS/클라우드 호스트의 경우 가능하면 제3자 "1-click" 마켓플레이스 이미지를 피합니다. 깨끗한 기본 OS 이미지 (예: Ubuntu LTS) 를 선호한 다음 설치자 스크립트로 직접 OpenClaw 를 설치합니다.

### 설치자 스크립트

CLI 를 다운로드하고, npm 을 통해 전역으로 설치하며, 온보딩 마법사를 시작합니다.

**macOS / Linux / WSL2:**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

**Windows (PowerShell):**

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

스크립트가 Node 검색, 설치 및 온보딩을 처리합니다.

온보딩을 건너뛰고 바이너리만 설치하려면:

**macOS / Linux / WSL2:**

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
```

**Windows (PowerShell):**

```powershell
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
```

모든 플래그, env 변수 및 CI/자동화 옵션은 [Installer internals](/install/installer) 를 참조합니다.

### npm / pnpm

Node 22+ 가 이미 있고 설치를 직접 관리하려면:

**npm:**

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

**pnpm:**

```bash
pnpm add -g openclaw@latest
pnpm approve-builds -g        # openclaw, node-llama-cpp, sharp 등 승인
openclaw onboard --install-daemon
```

pnpm 은 빌드 스크립트가 있는 패키지에 대해 명시적 승인이 필요합니다. 첫 번째 설치에서 "Ignored build scripts" 경고를 표시한 후 `pnpm approve-builds -g` 를 실행하고 나열된 패키지를 선택합니다.

### 소스에서

기여자 또는 로컬 체크아웃에서 실행하려는 사람들을 위해:

1. **복제 및 빌드:**

[OpenClaw repo](https://github.com/openclaw/openclaw) 를 복제하고 빌드합니다:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build
pnpm build
```

2. **CLI 링크:**

`openclaw` 명령을 전역에서 사용 가능하게 합니다:

```bash
pnpm link --global
```

또는 링크를 건너뛰고 리포지토리 내에서 `pnpm openclaw ...` 를 통해 명령을 실행합니다.

3. **온보딩 실행:**

```bash
openclaw onboard --install-daemon
```

더 깊은 개발 워크플로의 경우 [Setup](/start/setup) 를 참조합니다.

## 다른 설치 방법

- Docker: 컨테이너화되거나 헤드리스 배포용입니다.
- Podman: Rootless 컨테이너입니다.
- Nix: Nix 를 통한 선언적 설치입니다.
- Ansible: 자동화된 Fleet 프로비저닝입니다.
- Bun: Bun 런타임을 통한 CLI 전용 사용입니다.

## 설치 후

모든 것이 작동하는지 확인합니다:

```bash
openclaw doctor         # 구성 문제 확인
openclaw status         # Gateway 상태
openclaw dashboard      # 브라우저 UI 열기
```

사용자 정의 런타임 경로가 필요한 경우:

- `OPENCLAW_HOME` 홈 디렉토리 기반 내부 경로용
- `OPENCLAW_STATE_DIR` 변경 가능한 상태 위치용
- `OPENCLAW_CONFIG_PATH` 구성 파일 위치용

[Environment vars](/help/environment) 를 참조하여 우선순위 및 전체 세부 정보를 확인합니다.

## 문제 해결: `openclaw` 찾을 수 없음

빠른 진단:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

`$(npm prefix -g)/bin` (macOS/Linux) 또는 `$(npm prefix -g)` (Windows) 가 **not** in your `$PATH`, 셸이 전역 npm 바이너리 (OpenClaw 포함) 를 찾을 수 없습니다.

수정 — 셸 시작 파일 (`~/.zshrc` 또는 `~/.bashrc`) 에 추가합니다:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Windows 에서 `npm prefix -g` 출력을 PATH 에 추가합니다.

그런 다음 새 터미널을 열거나 zsh 에서 `rehash` / bash 에서 `hash -r` 을 실행합니다.

## 업데이트 / 제거

- [Updating](/install/updating) — OpenClaw 를 최신 상태로 유지합니다.
- [Migrating](/install/migrating) — 새 기계로 이동합니다.
- [Uninstall](/install/uninstall) — 완전히 제거합니다.

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/install/index.md
workflow: 15
