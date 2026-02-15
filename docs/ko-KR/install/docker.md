---
summary: "Optional Docker-based setup and onboarding for OpenClaw"
read_when:
  - You want a containerized gateway instead of local installs
  - You are validating the Docker flow
title: "Docker"
x-i18n:
  source_hash: 628eaf700d8ce6e9f4734e2bbbf8faa9a973b565e497bb8721a332a658c0dc49
---

# 도커(선택사항)

Docker는 **선택사항**입니다. 컨테이너화된 게이트웨이를 원하거나 Docker 흐름을 검증하려는 경우에만 사용하세요.

## Docker가 나에게 적합합니까?

- **예**: 격리된 일회용 게이트웨이 환경을 원하거나 로컬 설치 없이 호스트에서 OpenClaw를 실행하고 싶습니다.
- **아니요**: 자신의 컴퓨터에서 실행 중이며 가장 빠른 개발 루프를 원합니다. 대신 일반 설치 흐름을 사용하세요.
- **샌드박싱 참고**: 에이전트 샌드박싱은 Docker도 사용하지만 Docker에서 실행하기 위해 전체 게이트웨이가 필요하지 **않습니다**. [샌드박싱](/gateway/sandboxing)을 참조하세요.

이 가이드에서는 다음 내용을 다룹니다.

- 컨테이너화된 게이트웨이(Docker의 전체 OpenClaw)
- 세션별 에이전트 샌드박스(호스트 게이트웨이 + Docker 격리 에이전트 도구)

샌드박싱 세부정보: [샌드박싱](/gateway/sandboxing)

## 요구사항

- Docker Desktop(또는 Docker Engine) + Docker Compose v2
- 이미지 + 로그를 위한 충분한 디스크

## 컨테이너화된 게이트웨이(Docker Compose)

### 빠른 시작(권장)

저장소 루트에서:

```bash
./docker-setup.sh
```

이 스크립트는 다음과 같습니다.

- 게이트웨이 이미지를 빌드합니다.
- 온보딩 마법사를 실행합니다.
- 선택적 공급자 설정 힌트를 인쇄합니다.
- Docker Compose를 통해 게이트웨이를 시작합니다.
- 게이트웨이 토큰을 생성하여 `.env`에 씁니다.

선택적 환경 변수:

- `OPENCLAW_DOCKER_APT_PACKAGES` — 빌드 중에 추가 apt 패키지를 설치합니다.
- `OPENCLAW_EXTRA_MOUNTS` — 추가 호스트 바인드 마운트 추가
- `OPENCLAW_HOME_VOLUME` — 명명된 볼륨에 `/home/node`를 유지합니다.

완료 후:

- 브라우저에서 `http://127.0.0.1:18789/`를 엽니다.
- 컨트롤 UI(설정 → 토큰)에 토큰을 붙여넣습니다.
- URL이 다시 필요합니까? `docker compose run --rm openclaw-cli dashboard --no-open`를 실행하세요.

호스트에 구성/작업 공간을 씁니다.

- `~/.openclaw/`
- `~/.openclaw/workspace`

VPS에서 실행 중이신가요? [Hetzner(Docker VPS)](/install/hetzner)를 참조하세요.

### 쉘 도우미(선택 사항)

일상적인 Docker 관리를 더 쉽게 하려면 `ClawDock`를 설치하세요.

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
```

**쉘 구성(zsh)에 추가:**

```bash
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

그런 다음 `clawdock-start`, `clawdock-stop`, `clawdock-dashboard` 등을 사용합니다. 모든 명령에 대해 `clawdock-help`를 실행합니다.

자세한 내용은 [`ClawDock` 도우미 README](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md)를 참조하세요.

### 수동 흐름(작성)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

참고: repo 루트에서 `docker compose ...`를 실행하세요. 활성화한 경우
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

자세한 내용: [대시보드](/web/dashboard), [장치](/cli/devices).

### 추가 마운트(선택 사항)

추가 호스트 디렉토리를 컨테이너에 마운트하려면 다음을 설정하십시오.
`OPENCLAW_EXTRA_MOUNTS` `docker-setup.sh`를 실행하기 전에. 이는 다음을 허용합니다.
Docker 바인드 마운트의 쉼표로 구분된 목록을 생성하고 두 마운트 모두에 적용합니다.
`openclaw-gateway` 및 `openclaw-cli`를 생성하여 `docker-compose.extra.yml`를 생성합니다.

예:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

참고:

- 경로는 macOS/Windows의 Docker Desktop과 공유되어야 합니다.
- `OPENCLAW_EXTRA_MOUNTS`를 편집한 경우 `docker-setup.sh`를 다시 실행하여
  추가 작성 파일.
- `docker-compose.extra.yml`이 생성됩니다. 직접 편집하지 마세요.

### 전체 컨테이너 홈 유지(선택 사항)

컨테이너 재생성 시에도 `/home/node`가 지속되도록 하려면 명명된
`OPENCLAW_HOME_VOLUME`을 통한 볼륨. 그러면 Docker 볼륨이 생성되어 다음 위치에 마운트됩니다.
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

- `OPENCLAW_HOME_VOLUME`를 변경한 경우 `docker-setup.sh`를 다시 실행하여
  추가 작성 파일.
- 명명된 볼륨은 `docker volume rm <name>`로 제거될 때까지 유지됩니다.

### 추가 적절한 패키지 설치(선택사항)

이미지 내부에 시스템 패키지가 필요한 경우(예: 빌드 도구 또는 미디어)
라이브러리), `docker-setup.sh`를 실행하기 전에 `OPENCLAW_DOCKER_APT_PACKAGES`를 설정하세요.
이렇게 하면 이미지 빌드 중에 패키지가 설치되므로
컨테이너가 삭제되었습니다.

예:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

참고:

- 공백으로 구분된 적절한 패키지 이름 목록을 허용합니다.
- `OPENCLAW_DOCKER_APT_PACKAGES`을 변경한 경우 `docker-setup.sh`를 다시 실행하여 다시 빌드하세요.
  이미지.

### 고급 사용자/모든 기능을 갖춘 컨테이너(선택)

기본 Docker 이미지는 **보안 우선**이며 루트가 아닌 `node`로 실행됩니다.
사용자. 이는 공격 표면을 작게 유지하지만 다음을 의미합니다.

- 런타임 시 시스템 패키지가 설치되지 않습니다.
- 기본적으로 홈브루가 없습니다.
- 번들로 제공되는 Chromium/Playwright 브라우저 없음

더 많은 기능을 갖춘 컨테이너를 원한다면 다음 옵션 노브를 사용하세요.

1. **지속 `/home/node`**하여 브라우저 다운로드 및 도구 캐시가 유지됩니다.

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **시스템 깊이를 이미지에 굽습니다**(반복 가능 + 지속성):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **`npx` 없이 Playwright 브라우저를 설치합니다**(npm 재정의 충돌 방지):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

시스템 deps를 설치하기 위해 Playwright가 필요한 경우 다음을 사용하여 이미지를 다시 빌드하세요.
런타임에 `--with-deps`를 사용하는 대신 `OPENCLAW_DOCKER_APT_PACKAGES`.

4. **극작가 브라우저 다운로드 유지**:

- `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`를 설정하세요.
  `docker-compose.yml`.
- `/home/node`가 `OPENCLAW_HOME_VOLUME`를 통해 지속되는지 확인하거나 마운트
  `/home/node/.cache/ms-playwright` `OPENCLAW_EXTRA_MOUNTS`를 통해.

### 권한 + EACCES

이미지는 `node` (uid 1000)로 실행됩니다. 권한 오류가 표시되는 경우
`/home/node/.openclaw`, 호스트 바인드 마운트가 uid 1000에 의해 소유되었는지 확인하세요.

예(Linux 호스트):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

편의를 위해 루트로 실행하기로 선택한 경우 보안 절충안을 수락합니다.

### 더 빠른 재구축(권장)

재구축 속도를 높이려면 종속성 레이어가 캐시되도록 Dockerfile을 주문하세요.
이렇게 하면 잠금 파일이 변경되지 않는 한 `pnpm install`가 다시 실행되는 것을 방지할 수 있습니다.

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

문서: [WhatsApp](/channels/whatsapp), [텔레그램](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth(헤드리스 Docker)

마법사에서 OpenAI Codex OAuth를 선택하면 브라우저 URL이 열리고 다음을 시도합니다.
`http://127.0.0.1:1455/auth/callback`에서 콜백을 캡처합니다. 도커에서 또는
콜백이 브라우저 오류를 표시할 수 있는 헤드리스 설정입니다. 전체 리디렉션 복사
방문하는 URL을 마법사에 다시 붙여넣어 인증을 완료합니다.

### 건강검진

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E 스모크 테스트(Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR 가져오기 연기 테스트(Docker)

```bash
pnpm test:docker:qr
```

### 메모

- 컨테이너 사용 시 게이트웨이 바인딩은 기본적으로 `lan`로 설정됩니다.
- Dockerfile CMD는 `--allow-unconfigured`를 사용합니다. `local`가 아닌 `gateway.mode`로 마운트된 구성은 여전히 ​​시작됩니다. 가드를 시행하려면 CMD를 재정의하세요.
- 게이트웨이 컨테이너는 세션(`~/.openclaw/agents/<agentId>/sessions/`)의 정보 소스입니다.

## 에이전트 샌드박스(호스트 게이트웨이 + Docker 도구)

심층 분석: [샌드박싱](/gateway/sandboxing)

### 기능

`agents.defaults.sandbox`가 활성화되면 **기본이 아닌 세션**은 Docker 내부에서 도구를 실행합니다.
컨테이너. 게이트웨이는 호스트에 유지되지만 도구 실행은 격리됩니다.

- 범위: 기본적으로 `"agent"`(에이전트당 하나의 컨테이너 + 작업공간)
- 범위: `"session"` 세션별 격리
- `/workspace`에 마운트된 범위별 작업 공간 폴더
- 선택적 에이전트 작업공간 액세스(`agents.defaults.sandbox.workspaceAccess`)
- 도구 정책 허용/거부(거부 승리)
- 인바운드 미디어는 활성 샌드박스 작업 영역(`media/inbound/*`)에 복사되므로 도구에서 읽을 수 있습니다(`workspaceAccess: "rw"`를 사용하면 에이전트 작업 영역에 있음).

경고: `scope: "shared"`는 세션 간 격리를 비활성화합니다. 모든 세션 공유
하나의 컨테이너와 하나의 작업공간.

### 에이전트별 샌드박스 프로필(다중 에이전트)

다중 에이전트 라우팅을 사용하는 경우 각 에이전트는 샌드박스 + 도구 설정을 재정의할 수 있습니다.
`agents.list[].sandbox` 및 `agents.list[].tools` (+ `agents.list[].tools.sandbox.tools`). 이렇게 하면 실행할 수 있습니다.
하나의 게이트웨이에 혼합 액세스 수준:

- 전체 액세스(개인 에이전트)
- 읽기 전용 도구 + 읽기 전용 작업 공간(가족/직장 에이전트)
- 파일 시스템/셸 도구 없음(공공 에이전트)

예시는 [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools)를 참조하세요.
우선 순위 및 문제 해결.

### 기본 동작

- 이미지 : `openclaw-sandbox:bookworm-slim`
- 에이전트당 하나의 컨테이너
- 에이전트 작업공간 액세스: `workspaceAccess: "none"`(기본값)은 `~/.openclaw/sandboxes`를 사용합니다.
  - `"ro"`는 샌드박스 작업 영역을 `/workspace`에 유지하고 에이전트 작업 영역을 `/agent`에 읽기 전용으로 마운트합니다(`write`/`edit`/`apply_patch` 비활성화).
  - `"rw"`는 `/workspace`에 에이전트 작업공간 읽기/쓰기를 마운트합니다.
- 자동 정리: 유휴 > 24시간 또는 기간 > 7일
- 네트워크: 기본적으로 `none`(송신이 필요한 경우 명시적으로 선택)
- 기본 허용: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- 기본 거부: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### 샌드박싱 활성화

`setupCommand`에 패키지를 설치하려는 경우 다음을 참고하세요.

- 기본값 `docker.network`은 `"none"`(송신 없음)입니다.
- `readOnlyRoot: true`는 패키지 설치를 차단합니다.
- `user`는 `apt-get`의 루트여야 합니다(`user` 생략 또는 `user: "0:0"` 설정).
  OpenClaw는 `setupCommand`(또는 docker config)가 변경되면 컨테이너를 자동으로 다시 생성합니다.
  컨테이너가 **최근에 사용**되지 않은 경우(~5분 이내). 뜨거운 용기
  정확한 `openclaw sandbox recreate ...` 명령으로 경고를 기록하세요.

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

경화 손잡이는 `agents.defaults.sandbox.docker` 아래에 있습니다.
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

다중 에이전트: `agents.list[].sandbox.{docker,browser,prune}.*`를 통해 에이전트별로 `agents.defaults.sandbox.{docker,browser,prune}.*`를 재정의합니다.
(`agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope`가 `"shared"`인 경우 무시됨).

### 기본 샌드박스 이미지 빌드

```bash
scripts/sandbox-setup.sh
```

`Dockerfile.sandbox`를 사용하여 `openclaw-sandbox:bookworm-slim`를 빌드합니다.

### 샌드박스 공통 이미지(선택사항)

공통 빌드 도구(Node, Go, Rust 등)가 포함된 샌드박스 이미지를 원하는 경우 공통 이미지를 빌드하세요.

```bash
scripts/sandbox-common-setup.sh
```

그러면 `openclaw-sandbox-common:bookworm-slim`가 빌드됩니다. 그것을 사용하려면:

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

이것은 다음을 사용하여 `openclaw-sandbox-browser:bookworm-slim`를 빌드합니다.
`Dockerfile.sandbox-browser`. 컨테이너는 CDP가 활성화된 Chromium을 실행하고
선택적 noVNC 관찰자(Xvfb를 통한 헤드풀).

참고:

- 헤드풀(Xvfb)은 헤드리스에 비해 봇 차단을 줄입니다.
- `agents.defaults.sandbox.browser.headless=true` 설정을 통해 헤드리스를 계속 사용할 수 있습니다.
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

- 샌드박스 브라우저 제어 URL(`browser` 도구용)
- noVNC URL(활성화되어 있고 headless=false인 경우)

기억하세요: 도구에 대한 허용 목록을 사용하는 경우 `browser`를 추가하고 다음에서 제거하세요.
거부) 또는 도구가 차단된 상태로 유지됩니다.
정리 규칙(`agents.defaults.sandbox.prune`)은 브라우저 컨테이너에도 적용됩니다.

### 사용자 정의 샌드박스 이미지

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

- `deny`가 `allow`를 이겼습니다.
- `allow`가 비어 있는 경우: 모든 도구(거부 제외)를 사용할 수 있습니다.
- `allow`가 비어 있지 않은 경우: `allow`에 있는 도구만 사용할 수 있습니다(거부 제외).

### 가지치기 전략

손잡이 2개:

- `prune.idleHours`: X시간 동안 사용되지 않은 컨테이너 제거(0 = 비활성화)
- `prune.maxAgeDays`: X일보다 오래된 컨테이너 제거(0 = 비활성화)

예:

- 바쁜 세션을 유지하되 수명을 제한하세요.
  `idleHours: 24`, `maxAgeDays: 7`
- 가지치기를 하지 마세요:
  `idleHours: 0`, `maxAgeDays: 0`

### 보안 참고 사항

- 하드월은 **도구**(exec/read/write/edit/apply_patch)에만 적용됩니다.
- 브라우저/카메라/캔버스 등 호스트 전용 도구는 기본적으로 차단됩니다.
- 샌드박스에서 `browser`를 허용하면 **격리가 중단됩니다**(브라우저는 호스트에서 실행됩니다).

## 문제 해결

- 이미지 누락: [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh)로 빌드하거나 `agents.defaults.sandbox.docker.image`를 설정합니다.
- 컨테이너가 실행되지 않음: 요청 시 세션별로 자동 생성됩니다.
- 샌드박스의 권한 오류: `docker.user`를 귀하의 UID:GID와 일치하도록 설정하세요.
  마운트된 작업 공간 소유권(또는 작업 공간 폴더를 chown).
- 사용자 정의 도구를 찾을 수 없음: OpenClaw는 `sh -lc`(로그인 셸)로 명령을 실행합니다.
  `/etc/profile`를 소스로 하고 PATH를 재설정할 수 있습니다. `docker.env.PATH`를 앞에 추가하도록 설정하세요.
  사용자 정의 도구 경로(예: `/custom/bin:/usr/local/share/npm-global/bin`) 또는 추가
  Dockerfile의 `/etc/profile.d/` 아래에 있는 스크립트입니다.
