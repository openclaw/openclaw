---
read_when:
    - 클라우드 VPS(노트북 아님)에서 연중무휴 24시간 OpenClaw를 실행하고 싶습니다.
    - 자체 VPS에 프로덕션 등급의 상시 접속 게이트웨이가 필요합니다.
    - 지속성, 바이너리 및 재시작 동작을 완전히 제어하고 싶습니다.
    - Hetzner 또는 유사한 공급자의 Docker에서 OpenClaw를 실행 중입니다.
summary: 내구성이 뛰어난 상태와 내장 바이너리를 갖춘 저렴한 Hetzner VPS(Docker)에서 연중무휴 OpenClaw Gateway를 실행하세요.
title: 헤츠너
x-i18n:
    generated_at: "2026-02-08T16:05:22Z"
    model: gtx
    provider: google-translate
    source_hash: 84d9f24f1a803aa15faa52a05f25fe557ec3e2c2f48a00c701d49764bd3bc21a
    source_path: install/hetzner.md
    workflow: 15
---

# Hetzner의 OpenClaw(Docker, 프로덕션 VPS 가이드)

## 목표

내구성 있는 상태, 내장된 바이너리 및 안전한 다시 시작 동작을 갖춘 Docker를 사용하여 Hetzner VPS에서 영구 OpenClaw 게이트웨이를 실행하세요.

"~$5에 OpenClaw 24/7"을 원한다면 이것이 가장 간단하고 안정적인 설정입니다.
Hetzner 가격 변경; 가장 작은 Debian/Ubuntu VPS를 선택하고 OOM에 도달하면 확장하세요.

## 우리는 무엇을 하고 있나요(간단한 용어)?

- 소규모 Linux 서버 임대(Hetzner VPS)
- Docker 설치(격리된 앱 런타임)
- Docker에서 OpenClaw Gateway 시작
- 지속 `~/.openclaw` + `~/.openclaw/workspace` 호스트에서(다시 시작/재구축 후에도 유지됨)
- SSH 터널을 통해 노트북에서 Control UI에 액세스하세요.

게이트웨이는 다음을 통해 액세스할 수 있습니다.

- 노트북에서 SSH 포트 전달
- 방화벽 및 토큰을 직접 관리하는 경우 직접 포트 노출

이 가이드에서는 Hetzner의 Ubuntu 또는 Debian을 가정합니다.  
다른 Linux VPS를 사용하는 경우 이에 따라 패키지를 매핑하세요.
일반 Docker 흐름은 다음을 참조하세요. [도커](/install/docker).

---

## 빠른 경로(숙련된 운영자)

1. Hetzner VPS 프로비저닝
2. 도커 설치
3. OpenClaw 저장소 복제
4. 영구 호스트 디렉터리 생성
5. 구성 `.env` 그리고 `docker-compose.yml`
6. 필수 바이너리를 이미지에 굽습니다.
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

## 2) Docker 설치 (VPS에)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

확인하다:

```bash
docker --version
docker compose version
```

---

## 3) OpenClaw 저장소 복제

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

이 가이드에서는 바이너리 지속성을 보장하기 위해 사용자 지정 이미지를 빌드한다고 가정합니다.

---

## 4) 영구 호스트 디렉토리 생성

Docker 컨테이너는 임시적입니다.
모든 장기 상태는 호스트에 있어야 합니다.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) 환경 변수 구성

만들다 `.env` 저장소 루트에 있습니다.

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

## 6) 도커 작성 구성

생성 또는 업데이트 `docker-compose.yml`.

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
      ]
```

---

## 7) 필요한 바이너리를 이미지에 굽습니다(중요).

실행 중인 컨테이너 내부에 바이너리를 설치하는 것은 함정입니다.
런타임에 설치된 모든 항목은 다시 시작하면 손실됩니다.

기술에 필요한 모든 외부 바이너리는 이미지 빌드 시 설치되어야 합니다.

아래 예에서는 세 가지 일반적인 바이너리만 보여줍니다.

- `gog` Gmail 액세스용
- `goplaces` Google 지역 정보용
- `wacli` WhatsApp용

이는 전체 목록이 아닌 예입니다.
동일한 패턴을 사용하여 필요한 만큼 많은 바이너리를 설치할 수 있습니다.

나중에 추가 바이너리에 의존하는 새로운 기술을 추가하는 경우 다음을 수행해야 합니다.

1. Dockerfile 업데이트
2. 이미지 다시 작성
3. 컨테이너 다시 시작

**예시 Dockerfile**

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

## 8) 빌드 및 출시

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

열려 있는:

`http://127.0.0.1:18789/`

게이트웨이 토큰을 붙여넣으세요.

---

## 무엇이 어디에 지속되는지(진실의 출처)

OpenClaw는 Docker에서 실행되지만 Docker는 정보의 원천이 아닙니다.
수명이 긴 모든 상태는 다시 시작, 재구축 및 재부팅 후에도 유지되어야 합니다.

| Component           | Location                          | Persistence mechanism  | Notes                            |
| ------------------- | --------------------------------- | ---------------------- | -------------------------------- |
| Gateway config      | `/home/node/.openclaw/`           | Host volume mount      | Includes `openclaw.json`, tokens |
| Model auth profiles | `/home/node/.openclaw/`           | Host volume mount      | OAuth tokens, API keys           |
| Skill configs       | `/home/node/.openclaw/skills/`    | Host volume mount      | Skill-level state                |
| Agent workspace     | `/home/node/.openclaw/workspace/` | Host volume mount      | Code and agent artifacts         |
| WhatsApp session    | `/home/node/.openclaw/`           | Host volume mount      | Preserves QR login               |
| Gmail keyring       | `/home/node/.openclaw/`           | Host volume + password | Requires `GOG_KEYRING_PASSWORD`  |
| External binaries   | `/usr/local/bin/`                 | Docker image           | Must be baked at build time      |
| Node runtime        | Container filesystem              | Docker image           | Rebuilt every image build        |
| OS packages         | Container filesystem              | Docker image           | Do not install at runtime        |
| Docker container    | Ephemeral                         | Restartable            | Safe to destroy                  |
