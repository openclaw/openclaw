---
title: "Docker"
summary: "OpenClaw 의 선택적 Docker 기반 설정 및 온보딩"
read_when:
  - 로컬 설치 대신 컨테이너화된 Gateway 를 원할 때
  - Docker 플로우를 검증하고 있을 때
x-i18n:
  source_path: docs/install/docker.md
---

# Docker (선택 사항)

Docker 는 **선택 사항**입니다. 컨테이너화된 Gateway 를 원하거나 Docker 플로우를 검증하고 싶을 때만 사용하세요.

## Docker 가 나에게 맞는가?

- **맞음**: 격리된, 일회용 Gateway 환경을 원하거나 로컬 설치 없이 호스트에서 OpenClaw 를 실행하고 싶을 때.
- **아님**: 자신의 머신에서 실행 중이고 가장 빠른 개발 루프를 원할 때. 대신 일반 설치 플로우를 사용하세요.
- **샌드박싱 참고**: 에이전트 샌드박싱도 Docker 를 사용하지만, 전체 Gateway 를 Docker 에서 실행할 필요는 **없습니다**. [샌드박싱](/gateway/sandboxing)을 참고하세요.

## 사전 요구사항

- Docker Desktop (또는 Docker Engine) + Docker Compose v2
- 이미지 빌드를 위한 최소 2 GB RAM (`pnpm install` 이 1 GB 호스트에서 종료 코드 137 로 OOM-kill 될 수 있음)
- 이미지 및 로그를 위한 충분한 디스크 공간
- VPS/공개 호스트에서 실행하는 경우, 특히 Docker `DOCKER-USER` 방화벽 정책에 대한
  [네트워크 노출 보안 강화](/gateway/security#0-4-network-exposure-bind-port-firewall) 를 검토하세요.

## 컨테이너화된 Gateway

<Steps>
  <Step title="이미지 빌드">
    저장소 루트에서 설정 스크립트를 실행합니다:

    ```bash
    ./scripts/docker/setup.sh
    ```

    로컬 빌드 대신 사전 빌드된 이미지를 사용하려면:

    ```bash
    export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
    ./scripts/docker/setup.sh
    ```

    사전 빌드된 이미지는
    [GitHub Container Registry](https://github.com/openclaw/openclaw/pkgs/container/openclaw) 에 게시됩니다.
    일반적인 태그: `main`, `latest`, `<version>` (예: `2026.2.26`).

  </Step>

  <Step title="온보딩 완료">
    설정 스크립트가 자동으로 온보딩을 실행합니다. 다음을 수행합니다:

    - 프로바이더 API 키 입력 안내
    - Gateway 토큰 생성 및 `.env` 에 기록
    - Docker Compose 를 통해 Gateway 시작

  </Step>

  <Step title="Control UI 열기">
    브라우저에서 `http://127.0.0.1:18789/` 를 열고 설정에 토큰을 붙여넣으세요.

    URL 이 다시 필요하면:

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    ```

  </Step>

  <Step title="채널 구성 (선택 사항)">
    CLI 컨테이너를 사용하여 메시징 채널을 추가합니다:

    ```bash
    # WhatsApp (QR)
    docker compose run --rm openclaw-cli channels login

    # Telegram
    docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"

    # Discord
    docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
    ```

    문서: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

  </Step>
</Steps>

### 수동 플로우

설정 스크립트 대신 각 단계를 직접 실행하고 싶은 경우:

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

<Note>
저장소 루트에서 `docker compose` 를 실행하세요. `OPENCLAW_EXTRA_MOUNTS`
또는 `OPENCLAW_HOME_VOLUME` 을 활성화한 경우, 설정 스크립트가 `docker-compose.extra.yml` 을 작성합니다.
`-f docker-compose.yml -f docker-compose.extra.yml` 로 포함하세요.
</Note>

### 환경 변수

설정 스크립트는 다음과 같은 선택적 환경 변수를 허용합니다:

| 변수                           | 목적                                                         |
| ------------------------------ | ------------------------------------------------------------ |
| `OPENCLAW_IMAGE`               | 로컬 빌드 대신 원격 이미지 사용                              |
| `OPENCLAW_DOCKER_APT_PACKAGES` | 빌드 시 추가 apt 패키지 설치 (공백 구분)                     |
| `OPENCLAW_EXTENSIONS`          | 빌드 시 플러그인 의존성 사전 설치 (공백 구분 이름)           |
| `OPENCLAW_EXTRA_MOUNTS`        | 추가 호스트 바인드 마운트 (쉼표 구분 `source:target[:opts]`) |
| `OPENCLAW_HOME_VOLUME`         | 명명된 Docker 볼륨에 `/home/node` 영속화                     |
| `OPENCLAW_SANDBOX`             | 샌드박스 부트스트랩 옵트인 (`1`, `true`, `yes`, `on`)        |
| `OPENCLAW_DOCKER_SOCKET`       | Docker 소켓 경로 재정의                                      |

### 헬스 체크

컨테이너 프로브 엔드포인트 (인증 불필요):

```bash
curl -fsS http://127.0.0.1:18789/healthz   # liveness
curl -fsS http://127.0.0.1:18789/readyz     # readiness
```

Docker 이미지에는 `/healthz` 를 핑하는 내장 `HEALTHCHECK` 가 포함되어 있습니다.
체크가 계속 실패하면 Docker 가 컨테이너를 `unhealthy` 로 표시하고
오케스트레이션 시스템이 재시작하거나 교체할 수 있습니다.

인증된 심층 헬스 스냅샷:

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### LAN vs loopback

`scripts/docker/setup.sh` 는 Docker 포트 퍼블리싱으로 호스트에서
`http://127.0.0.1:18789` 에 접근할 수 있도록 `OPENCLAW_GATEWAY_BIND=lan` 을 기본값으로 설정합니다.

- `lan` (기본): 호스트 브라우저와 호스트 CLI 가 게시된 Gateway 포트에 접근할 수 있습니다.
- `loopback`: 컨테이너 네트워크 네임스페이스 내부의 프로세스만 Gateway 에 직접 접근할 수 있습니다.

<Note>
`gateway.bind` 에서 바인드 모드 값 (`lan` / `loopback` / `custom` /
`tailnet` / `auto`) 을 사용하세요. `0.0.0.0` 또는 `127.0.0.1` 같은 호스트 별칭이 아닙니다.
</Note>

### 스토리지 및 영속성

Docker Compose 는 `OPENCLAW_CONFIG_DIR` 을 `/home/node/.openclaw` 에,
`OPENCLAW_WORKSPACE_DIR` 을 `/home/node/.openclaw/workspace` 에 바인드 마운트하므로
해당 경로는 컨테이너 교체 후에도 유지됩니다.

VM 배포에 대한 전체 영속성 세부 사항은
[Docker VM Runtime - 어디에 무엇이 영속되는가](/install/docker-vm-runtime#what-persists-where)를 참고하세요.

**디스크 증가 핫스팟:** `media/`, 세션 JSONL 파일, `cron/runs/*.jsonl`,
그리고 `/tmp/openclaw/` 아래의 롤링 파일 로그를 주시하세요.

### 셸 헬퍼 (선택 사항)

일상적인 Docker 관리를 더 쉽게 하려면 `ClawDock` 을 설치하세요:

```bash
mkdir -p ~/.clawdock && curl -sL https://raw.githubusercontent.com/openclaw/openclaw/main/scripts/shell-helpers/clawdock-helpers.sh -o ~/.clawdock/clawdock-helpers.sh
echo 'source ~/.clawdock/clawdock-helpers.sh' >> ~/.zshrc && source ~/.zshrc
```

그런 다음 `clawdock-start`, `clawdock-stop`, `clawdock-dashboard` 등을 사용하세요.
모든 명령어는 `clawdock-help` 로 확인할 수 있습니다.
[`ClawDock` Helper README](https://github.com/openclaw/openclaw/blob/main/scripts/shell-helpers/README.md) 를 참고하세요.

<AccordionGroup>
  <Accordion title="Docker Gateway 에 에이전트 샌드박스 활성화">
    ```bash
    export OPENCLAW_SANDBOX=1
    ./scripts/docker/setup.sh
    ```

    커스텀 소켓 경로 (예: 루트리스 Docker):

    ```bash
    export OPENCLAW_SANDBOX=1
    export OPENCLAW_DOCKER_SOCKET=/run/user/1000/docker.sock
    ./scripts/docker/setup.sh
    ```

    스크립트는 샌드박스 사전 요구사항이 통과한 후에만 `docker.sock` 을 마운트합니다.
    샌드박스 설정을 완료할 수 없으면 스크립트가 `agents.defaults.sandbox.mode` 를
    `off` 로 재설정합니다.

  </Accordion>

  <Accordion title="자동화 / CI (비대화형)">
    `-T` 로 Compose 의사 TTY 할당을 비활성화합니다:

    ```bash
    docker compose run -T --rm openclaw-cli gateway probe
    docker compose run -T --rm openclaw-cli devices list --json
    ```

  </Accordion>

  <Accordion title="공유 네트워크 보안 참고">
    `openclaw-cli` 는 `network_mode: "service:openclaw-gateway"` 를 사용하므로
    CLI 명령이 `127.0.0.1` 을 통해 Gateway 에 접근할 수 있습니다. 이것을 공유
    신뢰 경계로 취급하세요. Compose 설정은 `openclaw-cli` 에서 `NET_RAW`/`NET_ADMIN` 을
    삭제하고 `no-new-privileges` 를 활성화합니다.
  </Accordion>

  <Accordion title="권한 및 EACCES">
    이미지는 `node` (uid 1000) 로 실행됩니다. `/home/node/.openclaw` 에서
    권한 오류가 발생하면 호스트 바인드 마운트가 uid 1000 소유인지 확인하세요:

    ```bash
    sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
    ```

  </Accordion>

  <Accordion title="더 빠른 리빌드">
    Dockerfile 에서 의존성 레이어가 캐시되도록 순서를 지정하세요.
    lockfile 이 변경되지 않는 한 `pnpm install` 을 다시 실행하지 않습니다:

    ```dockerfile
    FROM node:24-bookworm
    RUN curl -fsSL https://bun.sh/install | bash
    ENV PATH="/root/.bun/bin:${PATH}"
    RUN corepack enable
    WORKDIR /app
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

  </Accordion>

  <Accordion title="파워 유저 컨테이너 옵션">
    기본 이미지는 보안 우선이며 비루트 `node` 로 실행됩니다. 더 완전한 기능의 컨테이너를 위해:

    1. **`/home/node` 영속화**: `export OPENCLAW_HOME_VOLUME="openclaw_home"`
    2. **시스템 의존성 내장**: `export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"`
    3. **Playwright 브라우저 설치**:
       ```bash
       docker compose run --rm openclaw-cli \
         node /app/node_modules/playwright-core/cli.js install chromium
       ```
    4. **브라우저 다운로드 영속화**: `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` 를 설정하고
       `OPENCLAW_HOME_VOLUME` 또는 `OPENCLAW_EXTRA_MOUNTS` 를 사용하세요.

  </Accordion>

  <Accordion title="OpenAI Codex OAuth (헤드리스 Docker)">
    마법사에서 OpenAI Codex OAuth 를 선택하면 브라우저 URL 이 열립니다. Docker 또는 헤드리스 설정에서는
    도착한 전체 리디렉트 URL 을 복사하여 마법사에 다시 붙여넣어 인증을 완료하세요.
  </Accordion>

  <Accordion title="베이스 이미지 메타데이터">
    메인 Docker 이미지는 `node:24-bookworm` 을 사용하며 `org.opencontainers.image.base.name`,
    `org.opencontainers.image.source` 등의 OCI 베이스 이미지
    어노테이션을 게시합니다.
    [OCI 이미지 어노테이션](https://github.com/opencontainers/image-spec/blob/main/annotations.md) 을 참고하세요.
  </Accordion>
</AccordionGroup>

### VPS 에서 실행하시나요?

[Hetzner (Docker VPS)](/install/hetzner) 와
[Docker VM Runtime](/install/docker-vm-runtime) 에서 바이너리 내장, 영속성 및 업데이트를 포함한
공유 VM 배포 단계를 확인하세요.

## 에이전트 샌드박스

`agents.defaults.sandbox` 가 활성화되면 Gateway 는 에이전트 도구 실행
(셸, 파일 읽기/쓰기 등) 을 격리된 Docker 컨테이너 내에서 실행하고
Gateway 자체는 호스트에 유지됩니다. 이를 통해 전체 Gateway 를 컨테이너화하지 않고도
신뢰할 수 없거나 멀티 테넌트 에이전트 세션에 대한 하드 월을 제공합니다.

샌드박스 범위는 에이전트별 (기본), 세션별 또는 공유될 수 있습니다. 각 범위는
`/workspace` 에 마운트된 자체 작업 공간을 갖습니다. 허용/거부 도구 정책,
네트워크 격리, 리소스 제한 및 브라우저 컨테이너도 구성할 수 있습니다.

전체 구성, 이미지, 보안 참고 사항 및 멀티 에이전트 프로필은 다음을 참고하세요:

- [샌드박싱](/gateway/sandboxing) -- 전체 샌드박스 레퍼런스
- [OpenShell](/gateway/openshell) -- 샌드박스 컨테이너에 대한 대화형 셸 접근
- [멀티 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools) -- 에이전트별 재정의

### 빠른 활성화

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared
      },
    },
  },
}
```

기본 샌드박스 이미지 빌드:

```bash
scripts/sandbox-setup.sh
```

## 문제 해결

<AccordionGroup>
  <Accordion title="이미지가 없거나 샌드박스 컨테이너가 시작되지 않음">
    [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) 로
    샌드박스 이미지를 빌드하거나 `agents.defaults.sandbox.docker.image` 를 커스텀 이미지로 설정하세요.
    컨테이너는 세션별로 필요에 따라 자동 생성됩니다.
  </Accordion>

  <Accordion title="샌드박스에서 권한 오류">
    `docker.user` 를 마운트된 작업 공간 소유권과 일치하는 UID:GID 로 설정하거나
    작업 공간 폴더의 소유권을 변경하세요.
  </Accordion>

  <Accordion title="샌드박스에서 커스텀 도구를 찾을 수 없음">
    OpenClaw 는 `sh -lc` (로그인 셸) 로 명령을 실행하며, 이는 `/etc/profile` 을
    소스하고 PATH 를 재설정할 수 있습니다. `docker.env.PATH` 를 설정하여 커스텀 도구 경로를
    앞에 추가하거나 Dockerfile 에서 `/etc/profile.d/` 아래에 스크립트를 추가하세요.
  </Accordion>

  <Accordion title="이미지 빌드 중 OOM-kill (종료 코드 137)">
    VM 에 최소 2 GB RAM 이 필요합니다. 더 큰 머신 클래스를 사용하고 다시 시도하세요.
  </Accordion>

  <Accordion title="Control UI 에서 인증되지 않음 또는 페어링 필요">
    새 대시보드 링크를 가져오고 브라우저 장치를 승인하세요:

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    docker compose run --rm openclaw-cli devices list
    docker compose run --rm openclaw-cli devices approve <requestId>
    ```

    상세 내용: [대시보드](/web/dashboard), [장치](/cli/devices).

  </Accordion>

  <Accordion title="Gateway 대상이 ws://172.x.x.x 로 표시되거나 Docker CLI 에서 페어링 오류">
    Gateway 모드와 바인드를 재설정하세요:

    ```bash
    docker compose run --rm openclaw-cli config set gateway.mode local
    docker compose run --rm openclaw-cli config set gateway.bind lan
    docker compose run --rm openclaw-cli devices list --url ws://127.0.0.1:18789
    ```

  </Accordion>
</AccordionGroup>
