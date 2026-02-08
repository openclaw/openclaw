---
read_when:
    - 로컬 설치 대신 컨테이너화된 게이트웨이를 원합니다.
    - Docker 흐름을 검증하고 있습니다.
summary: OpenClaw에 대한 선택적 Docker 기반 설정 및 온보딩
title: 도커
x-i18n:
    generated_at: "2026-02-08T16:01:21Z"
    model: gtx
    provider: google-translate
    source_hash: fb8c7004b18753a293d2595eebeae31ca737ae3a86903b50d79c4c43bdb9ace7
    source_path: install/docker.md
    workflow: 15
---

# 도커(선택사항)

도커는 **선택 과목**. 컨테이너화된 게이트웨이를 원하거나 Docker 흐름을 검증하려는 경우에만 사용하세요.

## Docker가 나에게 적합합니까?

- **예**: 격리된 일회용 게이트웨이 환경을 원하거나 로컬 설치 없이 호스트에서 OpenClaw를 실행하려는 경우.
- **아니요**: 당신은 자신의 컴퓨터에서 실행 중이고 가장 빠른 개발 루프를 원합니다. 대신 일반 설치 흐름을 사용하세요.
- **샌드박싱 노트**: 에이전트 샌드박싱은 Docker도 사용하지만 **~ 아니다** Docker에서 실행하려면 전체 게이트웨이가 필요합니다. 보다 [샌드박싱](/gateway/sandboxing).

이 가이드에서는 다음 내용을 다룹니다.

- 컨테이너화된 게이트웨이(Docker의 전체 OpenClaw)
- 세션별 ​​에이전트 샌드박스(호스트 게이트웨이 + Docker 격리 에이전트 도구)

샌드박싱 세부정보: [샌드박싱](/gateway/sandboxing)

## 요구사항

- Docker Desktop(또는 Docker 엔진) + Docker Compose v2
- 이미지 + 로그를 위한 충분한 디스크

## 컨테이너화된 게이트웨이(Docker Compose)

### 빠른 시작(권장)

저장소 루트에서:

```bash
./docker-setup.sh
```

이 스크립트는 다음과 같습니다.

- 게이트웨이 이미지 빌드
- 온보딩 마법사를 실행합니다
- 선택적 공급자 설정 힌트를 인쇄합니다.
- Docker Compose를 통해 게이트웨이를 시작합니다.
- 게이트웨이 토큰을 생성하고 이를 씁니다. `.env`

선택적 환경 변수:

- `OPENCLAW_DOCKER_APT_PACKAGES` — 빌드 중에 추가 적절한 패키지를 설치합니다.
- `OPENCLAW_EXTRA_MOUNTS` — 추가 호스트 바인드 마운트 추가
- `OPENCLAW_HOME_VOLUME` — 지속 `/home/node` 명명된 볼륨

완료 후:

- 열려 있는 `http://127.0.0.1:18789/` 귀하의 브라우저에서.
- 컨트롤 UI(설정 → 토큰)에 토큰을 붙여넣습니다.
- URL이 다시 필요합니까? 달리다 `docker compose run --rm openclaw-cli dashboard --no-open`.

호스트에 구성/작업 공간을 씁니다.

- `~/.openclaw/`
- `~/.openclaw/workspace`

VPS에서 실행 중이신가요? 보다 [헤츠너(Docker VPS)](/install/hetzner).

### 수동 흐름(작성)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

참고: 실행 `docker compose ...` 레포 루트에서. 활성화한 경우
`OPENCLAW_EXTRA_MOUNTS` 또는 `OPENCLAW_HOME_VOLUME`, 설정 스크립트는 다음을 작성합니다.
`docker-compose.extra.yml`; 다른 곳에서 Compose를 실행할 때 이를 포함합니다.

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### 제어 UI 토큰 + 페어링(Docker)

"승인되지 않음" 또는 "연결 끊김(1008): 페어링 필요"가 표시되면
새로운 대시보드 링크를 만들고 브라우저 장치를 승인하세요.

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

더 자세한 내용: [계기반](/web/dashboard), [장치](/cli/devices).

### 추가 마운트(옵션)

추가 호스트 디렉토리를 컨테이너에 마운트하려면 다음을 설정하십시오.
`OPENCLAW_EXTRA_MOUNTS` 달리기 전에 `docker-setup.sh`. 이는 다음을 허용합니다.
Docker 바인드 마운트의 쉼표로 구분된 목록을 생성하고 두 마운트 모두에 적용합니다.
`openclaw-gateway` 그리고 `openclaw-cli` 생성하여 `docker-compose.extra.yml`.

예:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

참고:

- 경로는 macOS/Windows의 Docker Desktop과 공유되어야 합니다.
- 편집하는 경우 `OPENCLAW_EXTRA_MOUNTS`, 재실행 `docker-setup.sh` 재생성하다
  추가 작성 파일.
- `docker-compose.extra.yml` 생성됩니다. 직접 편집하지 마세요.

### 전체 컨테이너 홈 유지(선택 사항)

원한다면 `/home/node` 컨테이너 재생성 전반에 걸쳐 지속하려면 이름이 지정된
볼륨을 통해 `OPENCLAW_HOME_VOLUME`. 그러면 Docker 볼륨이 생성되어 다음 위치에 마운트됩니다.
`/home/node`, 표준 구성/작업 공간 바인드 마운트를 유지합니다. 사용
여기에 볼륨이라는 이름을 붙였습니다(바인드 경로 아님). 바인드 마운트의 경우 다음을 사용하십시오.
`OPENCLAW_EXTRA_MOUNTS`.

예:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

이것을 추가 마운트와 결합할 수 있습니다:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

참고:

- 당신이 변경하는 경우 `OPENCLAW_HOME_VOLUME`, 재실행 `docker-setup.sh` 재생성하다
  추가 작성 파일.
- 명명된 볼륨은 제거될 때까지 유지됩니다. `docker volume rm <name>`.

### 추가 적절한 패키지 설치(선택 사항)

이미지 내부에 시스템 패키지가 필요한 경우(예: 빌드 도구 또는 미디어)
라이브러리), 설정 `OPENCLAW_DOCKER_APT_PACKAGES` 달리기 전에 `docker-setup.sh`.
이렇게 하면 이미지 빌드 중에 패키지가 설치되므로
컨테이너가 삭제되었습니다.

예:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

참고:

- 이는 공백으로 구분된 적절한 패키지 이름 목록을 허용합니다.
- 당신이 변경하는 경우 `OPENCLAW_DOCKER_APT_PACKAGES`, 재실행 `docker-setup.sh` 재건하다
  이미지.

### 고급 사용자/모든 기능을 갖춘 컨테이너(선택)

기본 Docker 이미지는 다음과 같습니다. **보안 우선** 루트가 아닌 사용자로 실행됩니다. `node`
사용자. 이는 공격 표면을 작게 유지하지만 다음을 의미합니다.

- 런타임 시 시스템 패키지가 설치되지 않음
- 기본적으로 Homebrew가 없습니다.
- 번들로 제공되는 Chromium/Playwright 브라우저 없음

더 많은 기능을 갖춘 컨테이너를 원한다면 다음 옵션 노브를 사용하세요.

1. **지속 `/home/node`** 브라우저 다운로드 및 도구 캐시가 유지됩니다.

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **시스템을 이미지에 굽습니다.** (반복 가능 + 지속성):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **다음 없이 Playwright 브라우저를 설치하세요. `npx`** (npm 재정의 충돌 방지):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

시스템 deps를 설치하기 위해 Playwright가 필요한 경우 다음을 사용하여 이미지를 다시 빌드하세요.
`OPENCLAW_DOCKER_APT_PACKAGES` 사용하는 대신 `--with-deps` 런타임에.

4. **극작가 브라우저 다운로드 유지**:

- 세트 `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` ~에
  `docker-compose.yml`.
- 보장하다 `/home/node` 을 통해 지속 `OPENCLAW_HOME_VOLUME`또는 마운트
  `/home/node/.cache/ms-playwright` ~을 통해 `OPENCLAW_EXTRA_MOUNTS`.

### 권한 + EACCES

이미지는 다음과 같이 실행됩니다. `node` (UID 1000). 권한 오류가 표시되는 경우
`/home/node/.openclaw`, 호스트 바인드 마운트가 uid 1000의 소유인지 확인하세요.

예(Linux 호스트):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

편의를 위해 루트로 실행하기로 선택한 경우 보안 절충안을 수락합니다.

### 더 빠른 재구축(권장)

재구축 속도를 높이려면 종속성 레이어가 캐시되도록 Dockerfile을 주문하세요.
이렇게 하면 재실행이 방지됩니다. `pnpm install` 잠금 파일이 변경되지 않는 한:

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

### 채널 설정(선택사항)

CLI 컨테이너를 사용하여 채널을 구성한 후 필요한 경우 게이트웨이를 다시 시작하세요.

왓츠앱(QR):

```bash
docker compose run --rm openclaw-cli channels login
```

텔레그램(봇 토큰):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord(봇 토큰):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

문서: [왓츠앱](/channels/whatsapp), [전보](/channels/telegram), [불화](/channels/discord)

### OpenAI Codex OAuth(헤드리스 Docker)

마법사에서 OpenAI Codex OAuth를 선택하면 브라우저 URL이 열리고 다음을 시도합니다.
콜백을 캡처하려면 `http://127.0.0.1:1455/auth/callback`. 도커에서 또는
콜백이 브라우저 오류를 표시할 수 있는 헤드리스 설정입니다. 전체 리디렉션 복사
방문하는 URL을 마법사에 다시 붙여넣어 인증을 완료합니다.

### 건강검진

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E 연기 테스트(Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR 가져오기 연기 테스트(Docker)

```bash
pnpm test:docker:qr
```

### 메모

- 게이트웨이 바인딩의 기본값은 다음과 같습니다. `lan` 컨테이너용.
- Dockerfile CMD는 다음을 사용합니다. `--allow-unconfigured`; 마운트된 구성 `gateway.mode`~ 아니다`local` 여전히 시작됩니다. 가드를 시행하려면 CMD를 재정의하세요.
- 게이트웨이 컨테이너는 세션의 정보 소스입니다(`~/.openclaw/agents/<agentId>/sessions/`).

## 에이전트 샌드박스(호스트 게이트웨이 + Docker 도구)

심층 분석: [샌드박싱](/gateway/sandboxing)

### 기능

언제 `agents.defaults.sandbox` 활성화되어 있으며, **비메인 세션** Docker 내부에서 도구 실행
컨테이너. 게이트웨이는 호스트에 유지되지만 도구 실행은 격리됩니다.

- 범위: `"agent"` 기본적으로(에이전트당 컨테이너 1개 + 작업공간)
- 범위: `"session"` 세션별 ​​격리를 위해
- 마운트된 범위별 작업 공간 폴더 `/workspace`
- 선택적 에이전트 작업 영역 액세스(`agents.defaults.sandbox.workspaceAccess`)
- 도구 정책 허용/거부(거부 승리)
- 인바운드 미디어는 활성 샌드박스 작업 공간(`media/inbound/*`) 도구가 이를 읽을 수 있도록( `workspaceAccess: "rw"`, 상담원 작업공간에 표시됩니다.)

경고: `scope: "shared"` 세션 간 격리를 비활성화합니다. 모든 세션 공유
하나의 컨테이너와 하나의 작업공간.

### 에이전트별 샌드박스 프로필(다중 에이전트)

다중 에이전트 라우팅을 사용하는 경우 각 에이전트는 샌드박스 + 도구 설정을 재정의할 수 있습니다.
`agents.list[].sandbox` 그리고 `agents.list[].tools` (을 더한 `agents.list[].tools.sandbox.tools`). 이렇게 하면 실행할 수 있습니다.
하나의 게이트웨이에 혼합 액세스 수준:

- 전체 액세스(개인 에이전트)
- 읽기 전용 도구 + 읽기 전용 작업 공간(가족/직장 에이전트)
- 파일 시스템/셸 도구 없음(공공 에이전트)

보다 [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools) 예를 들어,
우선 순위 및 문제 해결.

### 기본 동작

- 영상: `openclaw-sandbox:bookworm-slim`
- 에이전트당 컨테이너 1개
- 상담원 작업 영역 액세스: `workspaceAccess: "none"` (기본값) 사용 `~/.openclaw/sandboxes`
  - `"ro"` 샌드박스 작업 공간을 다음과 같이 유지합니다. `/workspace` 에이전트 작업 영역을 읽기 전용으로 마운트합니다. `/agent` (비활성화 `write`/`edit`/`apply_patch`)
  - `"rw"` 에이전트 작업 영역 읽기/쓰기 마운트 `/workspace`
- 자동 정리: 유휴 > 24시간 또는 기간 > 7일
- 회로망: `none` 기본적으로(송신이 필요한 경우 명시적으로 선택)
- 기본 허용: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- 기본 거부: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### 샌드박싱 활성화

패키지를 설치할 계획이라면 `setupCommand`, 메모:

- 기본 `docker.network` ~이다 `"none"` (출구 없음).
- `readOnlyRoot: true` 패키지 설치를 차단합니다.
- `user` 의 루트여야 합니다. `apt-get` (생략 `user` 또는 설정 `user: "0:0"`).
  OpenClaw는 다음과 같은 경우 컨테이너를 자동으로 다시 생성합니다. `setupCommand` (또는 docker 구성) 변경 사항
  컨테이너가 아니었다면 **최근에 사용한** (~5분 이내). 뜨거운 용기
  정확한 경고를 기록하세요. `openclaw sandbox recreate ...` 명령.

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

경화 손잡이가 아래에 있습니다. `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`, 
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

다중 에이전트: 재정의 `agents.defaults.sandbox.{docker,browser,prune}.*` 에이전트당 `agents.list[].sandbox.{docker,browser,prune}.*`
(무시되는 경우 `agents.defaults.sandbox.scope`/`agents.list[].sandbox.scope` ~이다 `"shared"`).

### 기본 샌드박스 이미지 빌드

```bash
scripts/sandbox-setup.sh
```

이것은 빌드 `openclaw-sandbox:bookworm-slim` 사용하여 `Dockerfile.sandbox`.

### 샌드박스 공통 이미지(선택사항)

공통 빌드 도구(Node, Go, Rust 등)가 포함된 샌드박스 이미지를 원하는 경우 공통 이미지를 빌드하세요.

```bash
scripts/sandbox-common-setup.sh
```

이것은 빌드 `openclaw-sandbox-common:bookworm-slim`. 그것을 사용하려면:

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

샌드박스 내에서 브라우저 도구를 실행하려면 브라우저 이미지를 빌드하세요.

```bash
scripts/sandbox-browser-setup.sh
```

이것은 빌드 `openclaw-sandbox-browser:bookworm-slim` 사용하여 
`Dockerfile.sandbox-browser`. 컨테이너는 CDP가 활성화된 Chromium을 실행하고
선택적 noVNC 관찰자(Xvfb를 통한 헤드풀).

참고:

- Headful(Xvfb)은 헤드리스에 비해 봇 차단을 줄입니다.
- 설정을 통해 헤드리스를 계속 사용할 수 있습니다. `agents.defaults.sandbox.browser.headless=true`.
- 전체 데스크탑 환경(GNOME)이 필요하지 않습니다. Xvfb는 디스플레이를 제공합니다.

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

맞춤 브라우저 이미지:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

활성화되면 에이전트는 다음을 수신합니다.

- 샌드박스 브라우저 제어 URL( `browser` 도구)
- noVNC URL(활성화되어 있고 headless=false인 경우)

기억하세요: 도구에 대한 허용 목록을 사용하는 경우 다음을 추가하세요. `browser` (그리고 그것을 제거하십시오
거부) 또는 도구가 차단된 상태로 유지됩니다.
정리 규칙(`agents.defaults.sandbox.prune`) 브라우저 컨테이너에도 적용됩니다.

### 커스텀 샌드박스 이미지

자신만의 이미지를 만들고 여기에 구성을 지정합니다.

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

### 도구 정책(허용/거부)

- `deny` 승리하다 `allow`.
- 만약에 `allow` 비어 있음: 모든 도구(거부 제외)를 사용할 수 있습니다.
- 만약에 `allow` 비어 있지 않음: 다음의 도구만 `allow` 사용 가능합니다(거부 제외).

### 가지치기 전략

손잡이 2개:

- `prune.idleHours`: X시간 동안 사용되지 않은 컨테이너 제거(0 = 비활성화)
- `prune.maxAgeDays`: X일보다 오래된 컨테이너 제거(0 = 비활성화)

예:

- 바쁜 세션을 유지하되 수명을 제한하세요.
  `idleHours: 24`, `maxAgeDays: 7`
- 절대 가지치기하지 마세요:
  `idleHours: 0`, `maxAgeDays: 0`

### 보안 참고 사항

- 단단한 벽은 다음에만 적용됩니다. **도구** (실행/읽기/쓰기/편집/apply_patch).
- 브라우저/카메라/캔버스와 같은 호스트 전용 도구는 기본적으로 차단됩니다.
- 허용 `browser` 샌드박스에서 **고립을 깨뜨린다** (브라우저는 호스트에서 실행됩니다).

## 문제 해결

- 이미지 누락: 다음으로 빌드 [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) 또는 설정 `agents.defaults.sandbox.docker.image`.
- 컨테이너가 실행되지 않음: 요청 시 세션별로 자동 생성됩니다.
- 샌드박스의 권한 오류: 설정 `docker.user` 귀하의 UID:GID와 일치하는
  마운트된 작업 공간 소유권(또는 작업 공간 폴더를 chown).
- 사용자 정의 도구를 찾을 수 없음: OpenClaw는 다음을 사용하여 명령을 실행합니다. `sh -lc` (로그인 셸)
  출처 `/etc/profile` PATH를 재설정할 수 있습니다. 세트 `docker.env.PATH` 당신의 앞에 추가
  사용자 정의 도구 경로(예: `/custom/bin:/usr/local/share/npm-global/bin`) 또는 추가
  아래의 스크립트 `/etc/profile.d/` Dockerfile에 있습니다.
