---
summary: "OpenClaw 를 위한 선택적 Docker 기반 설정 및 온보딩"
read_when:
  - 로컬 설치 대신 컨테이너화된 게이트웨이를 원할 때
  - Docker 플로우를 검증하고 있을 때
title: "Docker"
---

# Docker (선택 사항)

Docker 는 **선택 사항**입니다. 컨테이너화된 게이트웨이가 필요하거나 Docker 플로우를 검증하려는 경우에만 사용하십시오.

## Docker 가 나에게 맞을까요?

- **예**: 격리된 일회용 게이트웨이 환경이 필요하거나 로컬 설치 없이 호스트에서 OpenClaw 를 실행하고 싶을 때.
- **아니오**: 개인 머신에서 실행하며 가장 빠른 개발 루프만 원할 때. 대신 일반 설치 플로우를 사용하십시오.
- **샌드박스 참고**: 에이전트 샌드박스화도 Docker 를 사용하지만, 전체 Gateway(게이트웨이)를 Docker 에서 실행할 필요는 **없습니다**. [Sandboxing](/gateway/sandboxing)을 참고하십시오.

이 가이드는 다음을 다룹니다:

- 컨테이너화된 Gateway(게이트웨이) (Docker 에서 전체 OpenClaw 실행)
- 세션별 에이전트 샌드박스 (호스트 게이트웨이 + Docker 로 격리된 에이전트 도구)

샌드박스 세부 사항: [Sandboxing](/gateway/sandboxing)

## 요구 사항

- Docker Desktop (또는 Docker Engine) + Docker Compose v2
- 이미지 + 로그를 위한 충분한 디스크 공간

## 컨테이너화된 Gateway(게이트웨이) (Docker Compose)

### 빠른 시작 (권장)

리포지토리 루트에서:

```bash
./docker-setup.sh
```

이 스크립트는 다음을 수행합니다:

- 게이트웨이 이미지 빌드
- 온보딩 마법사 실행
- prints optional provider setup hints
- Docker Compose 를 통해 게이트웨이 시작
- 게이트웨이 토큰을 생성하고 `.env` 에 기록

Optional env vars:

- `OPENCLAW_DOCKER_APT_PACKAGES` — 빌드 중 추가 apt 패키지 설치
- `OPENCLAW_EXTRA_MOUNTS` — 추가 호스트 바인드 마운트 추가
- `OPENCLAW_HOME_VOLUME` — `/home/node` 를 이름 있는 볼륨에 영구 저장

완료 후:

- 브라우저에서 `http://127.0.0.1:18789/` 을 여십시오.
- Control UI (Settings → token)에 토큰을 붙여넣으십시오.
- URL 이 다시 필요하신가요? `docker compose run --rm openclaw-cli dashboard --no-open` 를 실행하십시오.

호스트에 config/workspace 를 기록합니다:

- `~/.openclaw/`
- `~/.openclaw/workspace`

VPS 에서 실행 중이신가요? [Hetzner (Docker VPS)](/install/hetzner)를 참고하십시오.

### 수동 플로우 (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

참고: 리포지토리 루트에서 `docker compose ...` 을 실행하십시오. 만약
`OPENCLAW_EXTRA_MOUNTS` 또는 `OPENCLAW_HOME_VOLUME` 를 활성화했다면, 설정 스크립트가
`docker-compose.extra.yml` 을 작성합니다. 다른 위치에서 Compose 를 실행할 때 이를 포함하십시오:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI 토큰 + 페어링 (Docker)

“unauthorized” 또는 “disconnected (1008): pairing required”가 표시되면,
새 대시보드 링크를 가져와 브라우저 디바이스를 승인하십시오:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

자세한 내용: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### 추가 마운트 (선택 사항)

추가 호스트 디렉토리를 컨테이너에 마운트하려면,
`docker-setup.sh` 를 실행하기 전에 `OPENCLAW_EXTRA_MOUNTS` 을 설정하십시오. 이는
Docker 바인드 마운트의 쉼표로 구분된 목록을 허용하며,
`openclaw-gateway` 과 `openclaw-cli` 양쪽에 적용되도록
`docker-compose.extra.yml` 을 생성합니다.

예시:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

참고 사항:

- macOS/Windows 에서는 경로가 Docker Desktop 과 공유되어야 합니다.
- `OPENCLAW_EXTRA_MOUNTS` 을 수정한 경우, `docker-setup.sh` 을 다시 실행하여
  추가 compose 파일을 재생성하십시오.
- `docker-compose.extra.yml` 은 자동 생성됩니다. 수동으로 편집하지 마십시오.

### 전체 컨테이너 홈 영구화 (선택 사항)

컨테이너 재생성 시에도 `/home/node` 를 유지하려면,
`OPENCLAW_HOME_VOLUME` 을 통해 이름 있는 볼륨을 설정하십시오. 이는 Docker 볼륨을 생성하여
`/home/node` 에 마운트하면서 표준 config/workspace 바인드 마운트는 유지합니다. 여기서는 바인드 경로가 아닌 이름 있는 볼륨을 사용하십시오. 바인드 마운트는
`OPENCLAW_EXTRA_MOUNTS` 를 사용하십시오.

예시:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

추가 마운트와 함께 사용할 수 있습니다:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

참고 사항:

- `OPENCLAW_HOME_VOLUME` 을 변경한 경우, `docker-setup.sh` 를 다시 실행하여
  추가 compose 파일을 재생성하십시오.
- 이름 있는 볼륨은 `docker volume rm <name>` 로 제거할 때까지 유지됩니다.

### 추가 apt 패키지 설치 (선택 사항)

이미지 내부에 시스템 패키지가 필요한 경우(예: 빌드 도구 또는 미디어 라이브러리),
`docker-setup.sh` 을 실행하기 전에 `OPENCLAW_DOCKER_APT_PACKAGES` 을 설정하십시오.
이 패키지들은 이미지 빌드 중 설치되므로 컨테이너를 삭제해도 유지됩니다.

예시:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

참고 사항:

- 공백으로 구분된 apt 패키지 이름 목록을 허용합니다.
- `OPENCLAW_DOCKER_APT_PACKAGES` 을 변경한 경우, `docker-setup.sh` 를 다시 실행하여
  이미지를 재빌드하십시오.

### 파워 유저 / 풀 기능 컨테이너 (옵트인)

기본 Docker 이미지는 **보안 우선**이며, 비 root 인 `node`
사용자로 실행됩니다. 이는 공격 표면을 줄이지만 다음과 같은 제약이 있습니다:

- 런타임 중 시스템 패키지 설치 불가
- 기본적으로 Homebrew 없음
- Chromium/Playwright 브라우저 번들 없음

보다 풀 기능의 컨테이너를 원한다면 다음 옵트인 옵션을 사용하십시오:

1. **`/home/node` 영구화** — 브라우저 다운로드 및 도구 캐시 유지:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **시스템 의존성을 이미지에 포함** (재현 가능 + 영구):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **`npx` 없이 Playwright 브라우저 설치** (npm override 충돌 방지):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Playwright 가 시스템 의존성을 설치해야 한다면, 런타임에서 `--with-deps` 를 사용하는 대신
`OPENCLAW_DOCKER_APT_PACKAGES` 으로 이미지를 재빌드하십시오.

4. **Playwright 브라우저 다운로드 영구화**:

- `docker-compose.yml` 에서 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` 설정.
- `OPENCLAW_HOME_VOLUME` 를 통해 `/home/node` 이 유지되도록 하거나,
  `OPENCLAW_EXTRA_MOUNTS` 를 통해 `/home/node/.cache/ms-playwright` 을 마운트하십시오.

### 권한 + EACCES

이미지는 `node` (uid 1000)로 실행됩니다. `/home/node/.openclaw` 에서
권한 오류가 발생하면, 호스트 바인드 마운트의 소유자가 uid 1000 인지 확인하십시오.

예시 (Linux 호스트):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

편의를 위해 root 로 실행하기로 선택한 경우, 보안상의 트레이드오프를 감수해야 합니다.

### 더 빠른 재빌드 (권장)

재빌드를 빠르게 하려면 Dockerfile 에서 의존성 레이어가 캐시되도록 순서를 조정하십시오.
이렇게 하면 lockfile 이 변경되지 않는 한 `pnpm install` 을 다시 실행하지 않습니다:

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

CLI 컨테이너를 사용하여 채널을 구성한 다음, 필요 시 게이트웨이를 재시작하십시오.

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

문서: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (헤드리스 Docker)

마법사에서 OpenAI Codex OAuth 를 선택하면, 브라우저 URL 을 열고
`http://127.0.0.1:1455/auth/callback` 에서 콜백을 캡처하려고 시도합니다. Docker 또는
헤드리스 환경에서는 이 콜백이 브라우저 오류로 표시될 수 있습니다. 도착한 전체 리디렉션 URL 을 복사하여 마법사에 다시 붙여넣어 인증을 완료하십시오.

### 헬스 체크

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

- 게이트웨이 바인드는 컨테이너 사용을 위해 기본적으로 `lan` 에 바인드됩니다.
- Dockerfile CMD 는 `--allow-unconfigured` 을 사용합니다. `gateway.mode` 이 아닌
  `local` 로 마운트된 설정도 여전히 시작됩니다. Override CMD to enforce the guard.
- 게이트웨이 컨테이너는 세션에 대한 단일 소스 오브 트루스입니다 (`~/.openclaw/agents/<agentId>/sessions/`).

## 에이전트 샌드박스 (호스트 게이트웨이 + Docker 도구)

심화 내용: [Sandboxing](/gateway/sandboxing)

### What it does

`agents.defaults.sandbox` 이 활성화되면, **메인 세션이 아닌 세션**은 Docker
컨테이너 내부에서 도구를 실행합니다. 게이트웨이는 호스트에 유지되지만,
도구 실행은 격리됩니다:

- 범위: 기본값 `"agent"` (에이전트당 하나의 컨테이너 + 워크스페이스)
- 범위: 세션별 격리를 위한 `"session"`
- 범위별 워크스페이스 폴더는 `/workspace` 에 마운트
- 선택적 에이전트 워크스페이스 접근 (`agents.defaults.sandbox.workspaceAccess`)
- 허용/차단 도구 정책 (차단 우선)
- 인바운드 미디어는 활성 샌드박스 워크스페이스 (`media/inbound/*`) 로 복사되어
  도구가 읽을 수 있음 (`workspaceAccess: "rw"` 사용 시 에이전트 워크스페이스에 위치)

경고: `scope: "shared"` 은 세션 간 격리를 비활성화합니다. 모든 세션이
하나의 컨테이너와 하나의 워크스페이스를 공유합니다.

### 에이전트별 샌드박스 프로파일 (멀티 에이전트)

멀티 에이전트 라우팅을 사용하는 경우, 각 에이전트는 샌드박스 + 도구 설정을
`agents.list[].sandbox` 및 `agents.list[].tools` (그리고 `agents.list[].tools.sandbox.tools`) 로 오버라이드할 수 있습니다. 이를 통해 하나의 게이트웨이에서 혼합된 접근 수준을 실행할 수 있습니다:

- 전체 접근 (개인 에이전트)
- 읽기 전용 도구 + 읽기 전용 워크스페이스 (가족/업무 에이전트)
- 파일시스템/셸 도구 없음 (공개 에이전트)

예시, 우선순위, 문제 해결은
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)를 참고하십시오.

### 기본 동작

- 이미지: `openclaw-sandbox:bookworm-slim`
- 에이전트당 하나의 컨테이너
- 에이전트 워크스페이스 접근: `workspaceAccess: "none"` (기본값) 은 `~/.openclaw/sandboxes` 사용
  - `"ro"` 는 샌드박스 워크스페이스를 `/workspace` 에 유지하고,
    에이전트 워크스페이스를 `/agent` 에 읽기 전용으로 마운트
    (`write`/`edit`/`apply_patch` 비활성화)
  - `"rw"` 는 에이전트 워크스페이스를 `/workspace` 에 읽기/쓰기 마운트
- 자동 정리: 유휴 > 24시간 또는 수명 > 7일
- 네트워크: 기본값 `none` (이그레스가 필요하면 명시적으로 옵트인)
- 기본 허용: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- 기본 차단: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### 샌드박스 활성화

`setupCommand` 에 패키지를 설치할 계획이라면 다음을 유의하십시오:

- 기본 `docker.network` 은 `"none"` (이그레스 없음)입니다.
- `readOnlyRoot: true` 는 패키지 설치를 차단합니다.
- `apt-get` 를 위해 `user` 는 root 여야 합니다
  (`user` 를 생략하거나 `user: "0:0"` 로 설정).
  OpenClaw 는 `setupCommand` (또는 docker 설정)가 변경되면 컨테이너를 자동으로 재생성하지만,
  컨테이너가 **최근에 사용된 경우**(약 5분 이내)에는 제외됩니다. 활성 컨테이너는 정확한 `openclaw sandbox recreate ...` 명령과 함께 경고를 로그로 남깁니다.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
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
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
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

강화 옵션은 `agents.defaults.sandbox.docker` 아래에 있습니다:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

멀티 에이전트: 에이전트별로 `agents.list[].sandbox.{docker,browser,prune}.*` 를 통해 `agents.defaults.sandbox.{docker,browser,prune}.*` 을 오버라이드하십시오
(`agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` 가 `"shared"` 인 경우 무시됨).

### 기본 샌드박스 이미지 빌드

```bash
scripts/sandbox-setup.sh
```

이는 `Dockerfile.sandbox` 를 사용하여 `openclaw-sandbox:bookworm-slim` 을 빌드합니다.

### 샌드박스 공통 이미지 (선택 사항)

Node, Go, Rust 등 공통 빌드 도구가 포함된 샌드박스 이미지를 원한다면,
공통 이미지를 빌드하십시오:

```bash
scripts/sandbox-common-setup.sh
```

이는 `openclaw-sandbox-common:bookworm-slim` 을 빌드합니다. 사용하려면:

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

샌드박스 내부에서 브라우저 도구를 실행하려면 브라우저 이미지를 빌드하십시오:

```bash
scripts/sandbox-browser-setup.sh
```

이는 `Dockerfile.sandbox-browser` 를 사용하여 `openclaw-sandbox-browser:bookworm-slim` 을 빌드합니다. 컨테이너는 CDP 가 활성화된 Chromium 과
선택적 noVNC 옵저버 (Xvfb 를 통한 headful)로 실행됩니다.

참고 사항:

- Headful (Xvfb) 모드는 headless 대비 봇 차단을 줄입니다.
- `agents.defaults.sandbox.browser.headless=true` 을 설정하면 headless 도 사용 가능합니다.
- 전체 데스크톱 환경 (GNOME) 은 필요하지 않으며, Xvfb 가 디스플레이를 제공합니다.

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

커스텀 브라우저 이미지:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

활성화되면 에이전트는 다음을 받습니다:

- 샌드박스 브라우저 제어 URL (`browser` 도구용)
- noVNC URL (활성화되어 있고 headless=false 인 경우)

기억하십시오: 도구 허용 목록을 사용하는 경우,
`browser` 을 추가하고 차단 목록에서 제거하지 않으면 도구가 계속 차단됩니다.
정리 규칙 (`agents.defaults.sandbox.prune`) 은 브라우저 컨테이너에도 적용됩니다.

### 커스텀 샌드박스 이미지

자체 이미지를 빌드하고 설정에서 이를 지정하십시오:

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

### 도구 정책 (허용/차단)

- `deny` 이 `allow` 보다 우선합니다.
- `allow` 이 비어 있으면: (차단을 제외한) 모든 도구를 사용할 수 있습니다.
- `allow` 이 비어 있지 않으면: `allow` 에 있는 도구만 사용 가능하며 (차단 제외).

### 정리 전략

두 가지 옵션:

- `prune.idleHours`: X 시간 동안 사용되지 않은 컨테이너 제거 (0 = 비활성화)
- `prune.maxAgeDays`: X 일보다 오래된 컨테이너 제거 (0 = 비활성화)

예시:

- 활성 세션은 유지하되 수명 제한:
  `idleHours: 24`, `maxAgeDays: 7`
- 정리 안 함:
  `idleHours: 0`, `maxAgeDays: 0`

### 보안 참고 사항

- 강력한 격리는 **도구**에만 적용됩니다 (exec/read/write/edit/apply_patch).
- 브라우저/카메라/캔버스와 같은 호스트 전용 도구는 기본적으로 차단됩니다.
- 샌드박스에서 `browser` 을 허용하면 **격리가 깨집니다** (브라우저가 호스트에서 실행).

## 문제 해결

- 이미지 누락: [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) 로 빌드하거나 `agents.defaults.sandbox.docker.image` 을 설정하십시오.
- 컨테이너가 실행되지 않음: 세션 요청 시 자동으로 생성됩니다.
- 샌드박스 권한 오류: `docker.user` 를 마운트된 워크스페이스 소유권과 일치하는 UID:GID 로 설정하십시오
  (또는 워크스페이스 폴더의 소유권을 변경).
- 커스텀 도구를 찾을 수 없음: OpenClaw 는 `sh -lc` (로그인 셸)로 명령을 실행하며,
  이는 `/etc/profile` 을 소스하고 PATH 를 재설정할 수 있습니다. `docker.env.PATH` 를 설정하여 커스텀 도구 경로(예: `/custom/bin:/usr/local/share/npm-global/bin`)를
  앞에 추가하거나, Dockerfile 에서 `/etc/profile.d/` 아래에 스크립트를 추가하십시오.
