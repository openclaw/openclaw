---
summary: "Run OpenClaw Gateway 24/7 on a cheap Hetzner VPS (Docker) with durable state and baked-in binaries"
read_when:
  - You want OpenClaw running 24/7 on a cloud VPS (not your laptop)
  - You want a production-grade, always-on Gateway on your own VPS
  - You want full control over persistence, binaries, and restart behavior
  - You are running OpenClaw in Docker on Hetzner or a similar provider
title: "Hetzner"
x-i18n:
  source_hash: ffadc90db1bcbb22572b3ad68001a7a672daad6258da5c55d50dec5f82581cb6
---

# Hetzner의 OpenClaw (Docker, 프로덕션 VPS 가이드)

## 목표

내구성 있는 상태, 내장된 바이너리 및 안전한 다시 시작 동작을 갖춘 Docker를 사용하여 Hetzner VPS에서 영구 OpenClaw 게이트웨이를 실행하세요.

"~$5에 OpenClaw 24/7"을 원한다면 이것이 가장 간단하고 안정적인 설정입니다.
Hetzner 가격 변경; 가장 작은 Debian/Ubuntu VPS를 선택하고 OOM에 도달하면 확장하세요.

## 우리는 무엇을 하고 있나요(간단한 용어로)?

- 소규모 Linux 서버 임대(Hetzner VPS)
- Docker 설치(격리된 앱 런타임)
- Docker에서 OpenClaw Gateway 시작
- 호스트에서 `~/.openclaw` + `~/.openclaw/workspace` 지속(재시작/재구축 후에도 유지)
- SSH 터널을 통해 노트북에서 Control UI에 액세스

게이트웨이는 다음을 통해 액세스할 수 있습니다.

- 노트북에서 SSH 포트 전달
- 방화벽 및 토큰을 직접 관리하는 경우 직접 포트 노출

이 가이드에서는 Hetzner의 Ubuntu 또는 Debian을 가정합니다.  
다른 Linux VPS를 사용하는 경우 이에 따라 패키지를 매핑하세요.
일반 Docker 흐름은 [Docker](/install/docker)를 참조하세요.

---

## 빠른 경로(경험이 풍부한 운영자)

1. 헤츠너 VPS 제공
2. 도커 설치
3. OpenClaw 저장소 복제
4. 영구 호스트 디렉터리 생성
5. `.env` 및 `docker-compose.yml` 구성
6. 필요한 바이너리를 이미지에 굽습니다.
7. `docker compose up -d`
8. 지속성 및 게이트웨이 액세스 확인

---

## 필요한 것

- 루트 액세스가 가능한 Hetzner VPS
- 노트북에서 SSH 액세스
- SSH + 복사/붙여넣기를 통한 기본적인 편안함
- ~20분
- 도커와 도커 컴포즈
- 모델 인증 자격 증명
- 선택적 공급자 자격 증명
  - 왓츠앱 QR
  - 텔레그램 봇 토큰
  - 지메일 OAuth

---

## 1) VPS 프로비저닝

Hetzner에서 Ubuntu 또는 Debian VPS를 만듭니다.

루트로 연결:

```bash
ssh root@YOUR_VPS_IP
```

이 가이드에서는 VPS가 상태 저장형이라고 가정합니다.
일회용 인프라로 취급하지 마십시오.

---

## 2) Docker 설치(VPS에)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

확인:

```bash
docker --version
docker compose version
```

---

## 3) OpenClaw 저장소를 복제합니다.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

이 가이드에서는 바이너리 지속성을 보장하기 위해 사용자 지정 이미지를 빌드한다고 가정합니다.

---

## 4) 영구 호스트 디렉터리 생성

Docker 컨테이너는 임시적입니다.
모든 장기 상태는 호스트에 있어야 합니다.

```bash
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
```

---

## 5) 환경 변수 구성

저장소 루트에 `.env`을 생성합니다.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

강력한 비밀을 생성합니다:

```bash
openssl rand -hex 32
```

**이 파일을 커밋하지 마세요.**

---

## 6) Docker Compose 구성

`docker-compose.yml`을 생성하거나 업데이트하세요.

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
        "--allow-unconfigured",
      ]
```

`--allow-unconfigured`는 부트스트랩 편의를 위한 것일 뿐이며 적절한 게이트웨이 구성을 대체할 수는 없습니다. 여전히 인증(`gateway.auth.token` 또는 비밀번호)을 설정하고 배포에 안전한 바인딩 설정을 사용하세요.

---

## 7) 필요한 바이너리를 이미지에 굽습니다(중요).

실행 중인 컨테이너 내부에 바이너리를 설치하는 것은 함정입니다.
런타임에 설치된 모든 항목은 다시 시작하면 손실됩니다.

기술에 필요한 모든 외부 바이너리는 이미지 빌드 시 설치되어야 합니다.

아래 예에서는 세 가지 일반적인 바이너리만 보여줍니다.

- `gog` Gmail 액세스용
- Google 지역 정보의 경우 `goplaces`
- WhatsApp의 경우 `wacli`

이는 전체 목록이 아닌 예입니다.
동일한 패턴을 사용하여 필요한 만큼 많은 바이너리를 설치할 수 있습니다.

나중에 추가 바이너리에 의존하는 새로운 기술을 추가하는 경우 다음을 수행해야 합니다.

1. Dockerfile 업데이트
2. 이미지 재구축
3. 컨테이너 다시 시작

**도커파일 예시**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

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

---

## 8) 빌드 및 실행

```bash
docker compose build
docker compose up -d openclaw-gateway
```

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

---

## 9) 게이트웨이 확인

```bash
docker compose logs -f openclaw-gateway
```

성공:

```
[gateway] listening on ws://0.0.0.0:18789
```

노트북에서:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

열기:

`http://127.0.0.1:18789/`

게이트웨이 토큰을 붙여넣으세요.

---

## 무엇이 지속되는지(진실의 출처)

OpenClaw는 Docker에서 실행되지만 Docker는 정보의 원천이 아닙니다.
수명이 긴 모든 상태는 다시 시작, 재구축 및 재부팅 후에도 유지되어야 합니다.

| 구성요소          | 위치                              | 지속성 메커니즘        | 메모                         |
| ----------------- | --------------------------------- | ---------------------- | ---------------------------- |
| 게이트웨이 구성   | `/home/node/.openclaw/`           | 호스트 볼륨 마운트     | `openclaw.json`, 토큰 포함   |
| 모델 인증 프로필  | `/home/node/.openclaw/`           | 호스트 볼륨 마운트     | OAuth 토큰, API 키           |
| 스킬 구성         | `/home/node/.openclaw/skills/`    | 호스트 볼륨 마운트     | 스킬레벨 상태                |
| 에이전트 작업공간 | `/home/node/.openclaw/workspace/` | 호스트 볼륨 마운트     | 코드 및 에이전트 아티팩트    |
| WhatsApp 세션     | `/home/node/.openclaw/`           | 호스트 볼륨 마운트     | QR 로그인 유지               |
| Gmail 열쇠 고리   | `/home/node/.openclaw/`           | 호스트 볼륨 + 비밀번호 | `GOG_KEYRING_PASSWORD` 필요  |
| 외부 바이너리     | `/usr/local/bin/`                 | 도커 이미지            | 빌드 시 구워져야 합니다      |
| 노드 런타임       | 컨테이너 파일 시스템              | 도커 이미지            | 모든 이미지 빌드를 다시 작성 |
| OS 패키지         | 컨테이너 파일 시스템              | 도커 이미지            | 런타임에 설치하지 않음       |
| 도커 컨테이너     | 임시                              | 재시작 가능            | 파괴해도 안전함              |

---

## 코드형 인프라(Terraform)

코드형 인프라 워크플로를 선호하는 팀을 위해 커뮤니티에서 유지 관리하는 Terraform 설정은 다음을 제공합니다.

- 원격 상태 관리를 갖춘 모듈형 Terraform 구성
- cloud-init를 통한 자동 프로비저닝
- 배포 스크립트(부트스트랩, 배포, 백업/복원)
- 보안 강화(방화벽, UFW, SSH 전용 액세스)
- 게이트웨이 액세스를 위한 SSH 터널 구성

**저장소:**

- 인프라: [openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- 도커 구성: [openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

이 접근 방식은 재현 가능한 배포, 버전 제어 인프라 및 자동화된 재해 복구를 통해 위의 Docker 설정을 보완합니다.

> **참고:** 커뮤니티가 관리합니다. 문제나 기여에 대해서는 위의 저장소 링크를 참조하세요.
