---
summary: "OpenClaw 게이트웨이를 저렴한 Hetzner VPS (Docker)에서 내구성 있는 상태와 기본 바이너리와 함께 24/7 실행하기"
read_when:
  - OpenClaw를 클라우드 VPS (노트북이 아닌)에서 24/7 실행하고 싶습니다.
  - 본인의 VPS에서 프로덕션 급 상시 가동 게이트웨이를 원합니다.
  - 지속성, 바이너리 및 재시작 동작에 대한 전체 제어를 원합니다.
  - Hetzner 또는 유사한 프로바이더에서 Docker로 OpenClaw를 실행하고 있습니다.
title: "Hetzner"
---

# OpenClaw on Hetzner (Docker, Production VPS Guide)

## Goal

Docker를 사용하여 내구성 있는 상태, 기본 바이너리 및 안전한 재시작 동작을 제공하는 OpenClaw 게이트웨이를 Hetzner VPS에서 실행합니다.

"OpenClaw 24/7 for ~$5"를 원한다면, 이것이 가장 간단하고 신뢰할 수 있는 설정입니다.
Hetzner 가격은 변화할 수 있으므로, 가장 작은 Debian/Ubuntu VPS를 선택하고 OOM 문제가 발생할 경우 확장하십시오.

## What are we doing (simple terms)?

- 작은 Linux 서버(Hetzner VPS) 임대
- Docker 설치 (격리된 앱 런타임)
- Docker에서 OpenClaw 게이트웨이 시작
- `~/.openclaw` + `~/.openclaw/workspace`를 호스트에 지속 (재시작/재구축 시 생존)
- SSH 터널을 통해 노트북에서 제어 UI에 접근

게이트웨이는 아래를 통해 접근할 수 있습니다:

- 노트북에서의 SSH 포트 포워딩
- 방화벽 및 토큰을 직접 관리할 경우 직접 포트 노출

이 가이드는 Hetzner에서 Ubuntu 또는 Debian을 가정합니다.  
다른 Linux VPS를 사용하는 경우, 패키지를 맞춰서 맵핑하십시오.
일반적인 Docker 흐름에 대해서는 [Docker](/ko-KR/install/docker) 를 참조하십시오.

---

## Quick path (experienced operators)

1. Hetzner VPS 프로비저닝
2. Docker 설치
3. OpenClaw 리포지토리 클론
4. 지속적인 호스트 디렉토리 생성
5. `.env`와 `docker-compose.yml` 구성
6. 필요한 바이너리를 이미지에 반영
7. `docker compose up -d`
8. 지속성 및 게이트웨이 접근 확인

---

## What you need

- Hetzner VPS의 루트 접근
- 노트북에서의 SSH 접근
- SSH + 복사/붙여넣기에 대한 기본 편안함
- 약 20분
- Docker 및 Docker Compose
- 모델 인증 자격 증명
- 선택적 프로바이더 자격 증명
  - WhatsApp QR
  - Telegram 봇 토큰
  - Gmail OAuth

---

## 1) Provision the VPS

Hetzner에서 Ubuntu 또는 Debian VPS를 생성합니다.

루트 계정으로 연결:

```bash
ssh root@YOUR_VPS_IP
```

이 가이드는 VPS가 상태를 유지하는 것으로 가정합니다.
일회용 인프라로 처리하지 마십시오.

---

## 2) Install Docker (on the VPS)

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

## 3) Clone the OpenClaw repository

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

이 가이드는 바이너리 지속성을 보장하기 위해 커스텀 이미지를 빌드할 것을 가정합니다.

---

## 4) Create persistent host directories

Docker 컨테이너는 단기적인 존재입니다.
모든 장기 지속 상태는 호스트에 존재해야 합니다.

```bash
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
```

---

## 5) Configure environment variables

리포지토리 루트에 `.env` 파일 생성.

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

강력한 비밀 생성:

```bash
openssl rand -hex 32
```

**이 파일을 커밋하지 마십시오.**

---

## 6) Docker Compose configuration

`docker-compose.yml` 생성 또는 업데이트.

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

`--allow-unconfigured`는 부트스트랩 편의성을 위한 것이며, 올바른 게이트웨이 구성을 대체하지 않습니다. 여전히 인증(예: `gateway.auth.token` 또는 비밀번호)을 설정하고 배포를 위한 안전한 바인드 설정을 사용하십시오.

---

## 7) Bake required binaries into the image (critical)

실행 중인 컨테이너에 바이너리를 설치하는 것은 함정입니다.
구동 중 설치된 것은 재시작 시 모두 사라집니다.

스킬에 필요한 모든 외부 바이너리는 이미지 빌드 시에 설치되어야 합니다.

아래 예는 세 가지 일반적인 바이너리만 보여줍니다:

- `gog` Gmail 접근용
- `goplaces` Google Places 용
- `wacli` WhatsApp 용

이것들은 예제일 뿐이며, 모든 필요한 바이너리를 같은 패턴으로 설치할 수 있습니다.

나중에 추가 바이너리가 필요한 새로운 스킬을 추가하려면:

1. Dockerfile 업데이트
2. 이미지 재구축
3. 컨테이너 재시작

**예제 Dockerfile**

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

## 8) Build and launch

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Verify binaries:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Expected output:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9) Verify Gateway

```bash
docker compose logs -f openclaw-gateway
```

Success:

```
[gateway] listening on ws://0.0.0.0:18789
```

From your laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Open:

`http://127.0.0.1:18789/`

Paste your gateway token.

---

## What persists where (source of truth)

OpenClaw는 Docker에서 실행되지만, Docker가 진실의 원천은 아닙니다.
모든 장기 지속 상태는 재시작, 재구축 및 재부팅을 견뎌야 합니다.

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

---

## Infrastructure as Code (Terraform)

인프라를 코드로 관리하기를 선호하는 팀을 위해, 커뮤니티에서 유지하는 Terraform 설정은 다음을 제공합니다:

- 원격 상태 관리가 포함된 모듈식 Terraform 구성
- cloud-init을 통한 자동 프로비저닝
- 배포 스크립트 (부트스트랩, 배포, 백업/복원)
- 보안 강화 (방화벽, UFW, SSH 전용 접근)
- 게이트웨이 접근을 위한 SSH 터널 구성

**Repositories:**

- Infrastructure: [openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- Docker config: [openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

이 접근 방식은 재현 가능한 배포, 버전 제어된 인프라 및 자동 재해 복구를 통해 위의 Docker 설정을 보완합니다.

> **Note:** 커뮤니티에서 유지관리. 문제나 기여는 위의 리포지토리 링크를 참조하십시오.