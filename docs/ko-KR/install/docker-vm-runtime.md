---
title: "Docker VM Runtime"
summary: "장기 운영 OpenClaw Gateway 호스트를 위한 공유 Docker VM 런타임 단계"
read_when:
  - Docker 로 클라우드 VM 에 OpenClaw 를 배포할 때
  - 공유 바이너리 내장, 영속성 및 업데이트 플로우가 필요할 때
x-i18n:
  source_path: docs/install/docker-vm-runtime.md
---

# Docker VM Runtime

GCP, Hetzner 및 유사한 VPS 프로바이더와 같은 VM 기반 Docker 설치를 위한 공유 런타임 단계입니다.

## 필수 바이너리를 이미지에 내장

실행 중인 컨테이너 내부에 바이너리를 설치하는 것은 함정입니다.
런타임에 설치된 것은 재시작 시 손실됩니다.

Skills 에서 요구하는 모든 외부 바이너리는 이미지 빌드 시에 설치해야 합니다.

아래 예제는 세 가지 일반적인 바이너리만 보여줍니다:

- Gmail 접근을 위한 `gog`
- Google Places 를 위한 `goplaces`
- WhatsApp 를 위한 `wacli`

이것들은 예제이며 전체 목록이 아닙니다.
동일한 패턴을 사용하여 필요한 만큼의 바이너리를 설치할 수 있습니다.

나중에 추가 바이너리에 의존하는 새 Skills 를 추가하면 반드시:

1. Dockerfile 을 업데이트하고
2. 이미지를 리빌드하고
3. 컨테이너를 재시작해야 합니다

**예제 Dockerfile**

```dockerfile
FROM node:24-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# 예제 바이너리 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# 예제 바이너리 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# 예제 바이너리 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# 동일한 패턴을 사용하여 아래에 더 많은 바이너리 추가

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

<Note>
위의 다운로드 URL 은 x86_64 (amd64) 용입니다. ARM 기반 VM (예: Hetzner ARM, GCP Tau T2A) 의 경우 각 도구의 릴리스 페이지에서 적절한 ARM64 변형으로 다운로드 URL 을 교체하세요.
</Note>

## 빌드 및 실행

```bash
docker compose build
docker compose up -d openclaw-gateway
```

`pnpm install --frozen-lockfile` 중 `Killed` 또는 `exit code 137` 로 빌드가 실패하면 VM 의 메모리가 부족한 것입니다.
재시도하기 전에 더 큰 머신 클래스를 사용하세요.

바이너리 확인:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

예상 출력:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

Gateway 확인:

```bash
docker compose logs -f openclaw-gateway
```

예상 출력:

```
[gateway] listening on ws://0.0.0.0:18789
```

## 어디에 무엇이 영속되는가

OpenClaw 는 Docker 에서 실행되지만 Docker 가 정보 출처는 아닙니다.
모든 장기 상태는 재시작, 리빌드 및 재부팅 후에도 유지되어야 합니다.

| 구성요소           | 위치                              | 영속성 메커니즘        | 참고                        |
| ------------------ | --------------------------------- | ---------------------- | --------------------------- |
| Gateway 설정       | `/home/node/.openclaw/`           | 호스트 볼륨 마운트     | `openclaw.json`, 토큰 포함  |
| 모델 인증 프로필   | `/home/node/.openclaw/`           | 호스트 볼륨 마운트     | OAuth 토큰, API 키          |
| Skill 설정         | `/home/node/.openclaw/skills/`    | 호스트 볼륨 마운트     | Skill 수준 상태             |
| 에이전트 작업 공간 | `/home/node/.openclaw/workspace/` | 호스트 볼륨 마운트     | 코드 및 에이전트 아티팩트   |
| WhatsApp 세션      | `/home/node/.openclaw/`           | 호스트 볼륨 마운트     | QR 로그인 보존              |
| Gmail 키링         | `/home/node/.openclaw/`           | 호스트 볼륨 + 비밀번호 | `GOG_KEYRING_PASSWORD` 필요 |
| 외부 바이너리      | `/usr/local/bin/`                 | Docker 이미지          | 빌드 시 내장 필수           |
| Node 런타임        | 컨테이너 파일시스템               | Docker 이미지          | 모든 이미지 빌드 시 리빌드  |
| OS 패키지          | 컨테이너 파일시스템               | Docker 이미지          | 런타임에 설치하지 마세요    |
| Docker 컨테이너    | 임시                              | 재시작 가능            | 안전하게 파기 가능          |

## 업데이트

VM 에서 OpenClaw 를 업데이트하려면:

```bash
git pull
docker compose build
docker compose up -d
```
