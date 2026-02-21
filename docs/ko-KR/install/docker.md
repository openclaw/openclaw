---
summary: "Optional Docker-based setup and onboarding for OpenClaw"
read_when:
  - 컨테이너화된 게이트웨이를 원하거나 로컬 설치 대신에 사용하는 경우
  - Docker 흐름을 검증하려는 경우
title: "도커"
---

# Docker (optional)

Docker는 **옵션**입니다. 컨테이너화된 게이트웨이를 원하거나 Docker 흐름을 검증하려는 경우에만 사용하세요.

## Docker가 나에게 적합한가요?

- **예**: 분리되고 일회용 게이트웨이 환경을 원하거나 로컬 설치 없이 호스트에서 OpenClaw를 실행하려는 경우.
- **아니오**: 개인 기기에서 실행 중이며, 가장 빠른 개발 루프를 원한다면. 대신 일반 설치 흐름을 사용하세요.
- **샌드박스 주의사항**: 에이전트 샌드박스 격리 또한 Docker를 사용하지만, 전체 게이트웨이를 Docker에서 실행할 필요는 **없습니다**. [샌드박스 격리](/ko-KR/gateway/sandboxing)를 참조하세요.

이 가이드는 다음을 다룹니다:

- 컨테이너화된 게이트웨이 (Docker에서의 전체 OpenClaw)
- 세션별 에이전트 샌드박스 (호스트 게이트웨이 + Docker로 격리된 에이전트 도구)

샌드박스 격리 세부사항: [샌드박스 격리](/ko-KR/gateway/sandboxing)

## 요구사항

- Docker Desktop (또는 Docker Engine) + Docker Compose v2
- 이미지 및 로그를 위한 충분한 디스크 공간

## 컨테이너화된 게이트웨이 (Docker Compose)

### 빠른 시작 (권장)

저장소 루트에서:

```bash
./docker-setup.sh
```

이 스크립트는 다음을 수행합니다:

- 게이트웨이 이미지를 빌드
- 온보딩 마법사 실행
- 선택적 프로바이더 설정 힌트 출력
- Docker Compose를 통해 게이트웨이 시작
- 게이트웨이 토큰을 생성하고 `.env`에 기록

선택적 환경 변수:

- `OPENCLAW_DOCKER_APT_PACKAGES` — 빌드 중 추가 apt 패키지 설치
- `OPENCLAW_EXTRA_MOUNTS` — 추가 호스트 바인드 마운트 추가
- `OPENCLAW_HOME_VOLUME` — 명명된 볼륨에서 `/home/node` 유지

완료 후:

- 브라우저에서 `http://127.0.0.1:18789/`를 엽니다.
- 토큰을 컨트롤 UI (설정 → 토큰)에 붙여넣습니다.
- URL이 필요하신가요? `docker compose run --rm openclaw-cli dashboard --no-open`을 실행하세요.

호스트에 config/workspace를 작성합니다:

- `~/.openclaw/`
- `~/.openclaw/workspace`

VPS에서 실행 중이신가요? [Hetzner (Docker VPS)](/ko-KR/install/hetzner)를 참고하세요.

### 쉘 헬퍼 (선택 사항)

보다 쉬운 Docker 관리를 위해, `ClawDock`을 설치하세요:

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
```

**쉘 구성에 추가 (zsh):**

```bash
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

이제 `clawdock-start`, `clawdock-stop`, `clawdock-dashboard` 등을 사용할 수 있습니다. 모든 명령어는 `clawdock-help`를 실행해 확인하세요.

자세한 내용은 [`ClawDock` Helper README](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md)를 확인하세요.

### 수동 흐름 (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

참고: `docker compose ...`를 저장소 루트에서 실행하세요. `OPENCLAW_EXTRA_MOUNTS` 또는 `OPENCLAW_HOME_VOLUME`을 활성화한 경우, 설정 스크립트는 `docker-compose.extra.yml`을 작성합니다. 이를 다른 곳에서 Compose를 실행할 때 포함시키세요:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### 컨트롤 UI 토큰 + 페어링 (Docker)

"unauthorized" 또는 "disconnected (1008): pairing required" 메시지가 보이는 경우, 새 대시보드 링크를 가져와 브라우저 장치를 승인하세요:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

자세한 내용: [Dashboard](/ko-KR/web/dashboard), [Devices](/ko-KR/cli/devices).

### 추가 마운트 (선택 사항)

추가로 호스트 디렉토리를 컨테이너에 마운트하려면, `docker-setup.sh`를 실행하기 전에 `OPENCLAW_EXTRA_MOUNTS`를 설정하세요. 이것은 Docker 바인드 마운트를 쉼표로 구분한 목록을 수락하며, 이것을 통해 `openclaw-gateway`와 `openclaw-cli`에 적용됩니다. `docker-compose.extra.yml` 파일을 생성합니다.

예시:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

참고:

- 경로는 macOS/Windows에서 Docker Desktop과 공유해야 합니다.
- 각 항목은 공백, 탭, 줄 바꿈 없이 `source:target[:options]` 형식이어야 합니다.
- `OPENCLAW_EXTRA_MOUNTS`를 수정한 경우, `docker-setup.sh`를 다시 실행해 추가-compose 파일을 재생성하세요.
- `docker-compose.extra.yml` 파일은 자동 생성됩니다. 직접 편집하지 마세요.

### 전체 컨테이너 홈 유지하기 (선택 사항)

컨테이너를 다시 생성할 때 `/home/node`를 유지하려면 명명된 볼륨을 `OPENCLAW_HOME_VOLUME` 통해 설정하세요. 이는 Docker 볼륨을 생성하고 `/home/node`에 마운트하며, 표준 설정/workspace 바인드 마운트를 유지합니다. 여기에서는 명명된 볼륨을 사용하고, 바인드 경로를 사용하려면 `OPENCLAW_EXTRA_MOUNTS`를 사용하세요.

예시:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

이를 추가 마운트와 결합할 수 있습니다:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

참고:

- 명명된 볼륨 이름은 `^[A-Za-z0-9][A-Za-z0-9_.-]*$` 패턴과 일치해야 합니다.
- `OPENCLAW_HOME_VOLUME`를 변경한 경우, `docker-setup.sh`를 다시 실행해 추가 compose 파일을 재생성하세요.
- 명명된 볼륨은 `docker volume rm <name>` 명령어로 제거될 때까지 유지됩니다.

### 추가 apt 패키지 설치 (선택 사항)

이미지 내에 시스템 패키지가 필요하다면 (예: 빌드 도구나 미디어 라이브러리), `docker-setup.sh`를 실행하기 전에 `OPENCLAW_DOCKER_APT_PACKAGES`를 설정하세요. 이 변수는 이미지를 빌드하는 동안 패키지를 설치하여, 컨테이너가 삭제되더라도 유지됩니다.

예시:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

참고:

- 이 변수는 apt 패키지 이름의 공백으로 구분된 목록을 수락합니다.
- 'OPENCLAW_DOCKER_APT_PACKAGES`가 변경된 경우, 이미지를 재구축하기 위해 `docker-setup.sh`를 다시 실행하세요.

### 고급 사용자 / 전체 기능적 컨테이너 (선택 사항)

기본 Docker 이미지는 **보안을 우선**으로 하며 비루트 `node` 사용자로 실행됩니다. 이는 공격 표면을 줄이지만, 다음을 의미합니다:

- 런타임에 시스템 패키지를 설치하지 않습니다.
- 기본적으로 Homebrew가 없습니다.
- Chromium/Playwright 브라우저가 번들되지 않습니다.

보다 기능이 풍부한 컨테이너가 필요한 경우, 다음의 선택적 설정을 사용하세요:

1. **`/home/node` 유지**: 브라우저 다운로드와 도구 캐시가 유지됩니다.

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **이미지 내에 시스템 종속성 베이킹** (반복 가능 + 지속 가능):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **`npx` 없이 Playwright 브라우저 설치** (npm 오버라이드 충돌 회피):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Playwright가 시스템 종속성을 설치해야 하는 경우, 런타임에 `--with-deps` 대신 `OPENCLAW_DOCKER_APT_PACKAGES`로 이미지를 재구성하세요.

4. **Playwright 브라우저 다운로드 유지**:

- `docker-compose.yml`에 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` 설정.
- `/home/node`는 `OPENCLAW_HOME_VOLUME`을 통해 지속되거나, `/home/node/.cache/ms-playwright`는 `OPENCLAW_EXTRA_MOUNTS`를 통해 마운트됩니다.

### 권한 + EACCES

이미지는 `node` (uid 1000)으로 실행됩니다. `/home/node/.openclaw`에서 권한 오류가 발생하면, 호스트 바인드 마운트가 uid 1000의 소유인지 확인하세요.

예시 (Linux 호스트):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

편의상 루트로 실행하기로 선택한 경우, 보안 상의 위험을 감수하는 것입니다.

### 더 빠른 재구축 (권장)

재구축 속도를 높이려면 Dockerfile을 의존성 계층이 캐시되도록 정렬하세요. 이는 lockfiles가 변경되지 않는 한 `pnpm install`을 재실행하지 않습니다:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### 채널 설정 (선택 사항)

CLI 컨테이너를 사용하여 채널을 구성한 다음 필요 시 게이트웨이를 다시 시작하세요.

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (봇 토큰):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (봇 토큰):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

문서: [WhatsApp](/ko-KR/channels/whatsapp), [Telegram](/ko-KR/channels/telegram), [Discord](/ko-KR/channels/discord)

### OpenAI Codex OAuth (headless Docker)

마법사에서 OpenAI Codex OAuth를 선택하면 브라우저 URL을 열고 `http://127.0.0.1:1455/auth/callback`에서 콜백을 캡처하려고 시도합니다. Docker 또는 헤드리스 설정에서는 해당 콜백이 브라우저 오류를 표시할 수 있습니다. 잘못된 리디렉션 URL을 복사하여 마법사에 붙여 넣어 인증을 완료하세요.

### 건강 확인

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E 스모크 테스트 (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR 가져오기 스모크 테스트 (Docker)

```bash
pnpm test:docker:qr
```

### 참고 사항

- 게이트웨이 바인드는 컨테이너 사용을 위해 기본적으로 `lan`입니다.
- Dockerfile CMD는 `--allow-unconfigured`를 사용합니다; `gateway.mode`가 `local`이 아닌 설치 구성은 여전히 시작됩니다. CMD를 무시하여 보호를 강화합니다.
- 게이트웨이 컨테이너는 세션 (`~/.openclaw/agents/<agentId>/sessions/`)의 진실 소스입니다.

## 에이전트 샌드박스 (호스트 게이트웨이 + Docker 도구)

깊이 있는 안내: [샌드박스 격리](/ko-KR/gateway/sandboxing)

### 그 작동 방식

`agents.defaults.sandbox`가 활성화되면, **비주요 세션**은 Docker 컨테이너 내에서 도구를 실행합니다. 게이트웨이는 호스트에 남아 있지만, 도구 실행은 격리됩니다:

- 범위: 기본으로 `"agent"` (에이전트별 한 개의 컨테이너 + 작업 공간)
- 범위: `"session"`은 세션별 격리
- 각 범위의 작업 공간 폴더가 `/workspace`에 마운트됩니다
- 선택적 에이전트 작업 공간 접근 (`agents.defaults.sandbox.workspaceAccess`)
- 도구 정책 허용/거부 (거부가 우선)
- 수신 미디어는 활성 샌드박스 작업 공간 (`media/inbound/*`)으로 복사되어 도구가 읽을 수 있도록 합니다 (`workspaceAccess: "rw"`인 경우, 에이전트 작업 공간에 위치)

경고: `scope: "shared"`는 세션 간의 격리를 해제합니다. 모든 세션은 하나의 컨테이너와 하나의 작업 공간을 공유합니다.

### 에이전트별 샌드박스 프로필 (다중 에이전트)

다중 에이전트 라우팅을 사용하는 경우, 각 에이전트는 샌드박스 + 도구 설정을 재정의할 수 있습니다: `agents.list[].sandbox`와 `agents.list[].tools` (또한 `agents.list[].tools.sandbox.tools`). 이는 한 게이트웨이 내에서 다양한 접근 수준을 실행할 수 있게 합니다:

- 전체 접근 (개인용 에이전트)
- 읽기 전용 도구 + 읽기 전용 작업 공간 (가정/직장용 에이전트)
- 파일 시스템/셸 도구 없음 (공용 에이전트)

예시, 우선순위 및 문제 해결에 대한 자세한 내용은 [Multi-Agent Sandbox & Tools](/ko-KR/tools/multi-agent-sandbox-tools)를 참조하세요.

### 기본 동작

- 이미지: `openclaw-sandbox:bookworm-slim`
- 에이전트별 하나의 컨테이너
- 에이전트 작업 공간 접근: `workspaceAccess: "none"` (기본값) 사용 `~/.openclaw/sandboxes`
  - `"ro"`는 샌드박스 작업 공간을 `/workspace`에 유지하고 에이전트 작업 공간을 읽기 전용으로 `/agent`에 마운트 ( `write`/`edit`/`apply_patch` 비활성화)
  - `"rw"`는 에이전트 작업 공간을 읽기/쓰기 `/workspace`에 마운트
- 자동 정리: 대기 > 24시간 또는 나이 > 7일
- 네트워크: 기본 값 `none` (출구가 필요한 경우 명시적 선택 필요)
- 기본 허용: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- 기본 거부: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### 샌드박스 격리 활성화

`setupCommand`에서 패키지를 설치할 계획이라면, 다음을 유의하세요:

- 기본 `docker.network`는 `"none"` (출구 없음).
- `readOnlyRoot: true`는 패키지 설치를 차단합니다.
- `user`는 `apt-get`을 위해 루트여야 합니다 ( `user`를 생략하거나 `user: "0:0"`으로 설정).
  `setupCommand` (또는 docker 설정)가 변경되면 OpenClaw는 자동으로 컨테이너를 재생성합니다
  컨테이너가 **최근에 사용되지 않은** 경우 (약 5분 이내). 뜨거운 컨테이너는 정확한 `openclaw sandbox recreate ...` 명령어를 로그로 경고합니다.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (기본은 agent)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0은 대기 정리 비활성화
          maxAgeDays: 7, // 0은 최대 나이 정리 비활성화
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

강화 설정은 `agents.defaults.sandbox.docker`에 위치합니다:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

다중 에이전트: `agents.list[].sandbox.{docker,browser,prune}.*`를 통해 에이전트별로 `agents.defaults.sandbox.{docker,browser,prune}.*`를 재정의합니다.
( 무시되는 경우 `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` 는 `"shared"` ).

### 기본 샌드박스 이미지 만들기

```bash
scripts/sandbox-setup.sh
```

이는 `Dockerfile.sandbox`를 사용하여 `openclaw-sandbox:bookworm-slim`을 빌드합니다.

### 샌드박스 공통 이미지 (선택 사항)

공통 빌드 도구가 포함된 샌드박스 이미지를 원하신다면 (Node, Go, Rust 등), 공통 이미지를 빌드하세요:

```bash
scripts/sandbox-common-setup.sh
```

이는 `openclaw-sandbox-common:bookworm-slim`을 빌드합니다. 사용하려면:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### 샌드박스 브라우저 이미지

샌드박스 내에서 브라우저 도구를 실행하려면, 브라우저 이미지를 빌드하세요:

```bash
scripts/sandbox-browser-setup.sh
```

이는 `Dockerfile.sandbox-browser`을 사용하여 `openclaw-sandbox-browser:bookworm-slim`을 빌드합니다. 이 컨테이너는 CDP가 활성화된 Chromium과 선택적으로 noVNC 옵저버 (Xvfb를 통한 headful)를 실행합니다.

참고 사항:

- Headful (Xvfb)은 headless 대비 봇 차단을 줄입니다.
- Headless도 `agents.defaults.sandbox.browser.headless=true`로 설정하여 여전히 사용할 수 있습니다.
- 전체 데스크탑 환경 (GNOME)은 필요하지 않으며; Xvfb가 디스플레이를 제공합니다.
- 브라우저 컨테이너는 글로벌 `bridge` 대신 기본적으로 전용 Docker 네트워크 (`openclaw-sandbox-browser`)를 사용합니다.
- 선택적 `agents.defaults.sandbox.browser.cdpSourceRange`는 CIDR로 컨테이너 엣지 CDP 수신을 제한합니다 (예: `172.21.0.1/32`).
- noVNC 관찰자 접근은 기본적으로 비밀번호로 보호됩니다; OpenClaw는 URL에 원시 비밀번호를 공유하는 대신 단기 관찰자 토큰 URL을 제공합니다.

구성 사용:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

사용자 정의 브라우저 이미지:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

활성화되면, 에이전트는 다음을 수신합니다:

- 샌드박스 브라우저 제어 URL (`browser` 도구용)
- noVNC URL (사용 가능하며 headless=false인 경우)

기억하세요: 도구에 허용 목록을 사용하는 경우, `browser`를 추가하고 거부에서 제거하세요. 그렇지 않으면 도구가 계속 차단됩니다.
시점 규칙 ( `agents.defaults.sandbox.prune` )은 브라우저 컨테이너에도 적용됩니다.

### 사용자 정의 샌드박스 이미지

자체 이미지를 구축하고 구성에 지정하세요:

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### 도구 정책 (허용/거부)

- `deny`는 항상 `allow`보다 우선합니다.
- `allow`가 비어 있는 경우: 모든 도구가 (거부를 제외하고) 사용됩니다.
- `allow`가 비어 있지 않은 경우: `allow`에만 있는 도구가 사용됩니다 (거부 항목 제외).

### 프루닝 전략

두 개의 설정:

- `prune.idleHours`: X 시간 동안 사용되지 않은 컨테이너 제거 (0 = 비활성화)
- `prune.maxAgeDays`: X일이 지난 컨테이너 제거 (0 = 비활성화)

예시:

- 바쁜 세션 유지하되 수명을 제한:
  `idleHours: 24`, `maxAgeDays: 7`
- 정리하지 않음:
  `idleHours: 0`, `maxAgeDays: 0`

### 보안 주의사항

- 강제 경계는 **도구**에만 적용됩니다 (exec/read/write/edit/apply_patch).
- 호스트 전용 도구는 기본적으로 차단됩니다 (browser/camera/canvas).
- 샌드박스에서 `browser`를 허용하는 것은 **격리를 파괴**합니다 (브라우저는 호스트에서 실행).

## 문제 해결

- 이미지 없음: [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh)로 빌드하거나 `agents.defaults.sandbox.docker.image`를 설정하세요.
- 컨테이너가 실행되지 않음: 세션 수요에 따라 자동으로 생성됩니다.
- 샌드박스에서의 권한 오류: `docker.user`를 마운트된 작업 공간 소유권에 맞는 UID:GID로 설정하거나 작업 공간 폴더의 소유권을 변경하세요.
- 사용자 지정 도구를 찾을 수 없음: OpenClaw는 `sh -lc` (로그인 셸)로 명령을 실행하며, 이는 `/etc/profile`을 소스하며 PATH를 재설정할 수 있습니다. `docker.env.PATH`에 사용자 지정 도구 경로를 미리 설정하거나 Dockerfile 내 `/etc/profile.d/` 아래에 스크립트를 추가하세요.
