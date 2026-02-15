---
summary: "Run OpenClaw Gateway 24/7 on a GCP Compute Engine VM (Docker) with durable state"
read_when:
  - You want OpenClaw running 24/7 on GCP
  - You want a production-grade, always-on Gateway on your own VM
  - You want full control over persistence, binaries, and restart behavior
title: "GCP"
x-i18n:
  source_hash: 173d89358506c73cdd5f4ecdc8eee80e17d543f3ccf6fd4d611fd96dfad1b8ab
---

# GCP Compute Engine의 OpenClaw(Docker, 프로덕션 VPS 가이드)

## 목표

내구성 상태, 기본 제공 바이너리, 안전한 다시 시작 동작을 갖춘 Docker를 사용하여 GCP Compute Engine VM에서 영구 OpenClaw 게이트웨이를 실행하세요.

'OpenClaw 24/7, ~$5-12/월'을 원하는 경우 이는 Google Cloud에서 안정적인 설정입니다.
가격은 머신 유형과 지역에 따라 다릅니다. 워크로드에 맞는 가장 작은 VM을 선택하고 OOM에 도달하면 확장하세요.

## 우리는 무엇을 하고 있나요(간단한 용어로)?

- GCP 프로젝트 생성 및 결제 활성화
- Compute Engine VM 만들기
- Docker 설치(격리된 앱 런타임)
- Docker에서 OpenClaw Gateway 시작
- 호스트에서 `~/.openclaw` + `~/.openclaw/workspace` 유지(재시작/재구축 후에도 유지)
- SSH 터널을 통해 노트북에서 Control UI에 액세스

게이트웨이는 다음을 통해 액세스할 수 있습니다.

- 노트북에서 SSH 포트 전달
- 방화벽 및 토큰을 직접 관리하는 경우 직접 포트 노출

이 가이드에서는 GCP Compute Engine에서 Debian을 사용합니다.
우분투도 작동합니다. 그에 따라 패키지를 매핑합니다.
일반 Docker 흐름은 [Docker](/install/docker)를 참조하세요.

---

## 빠른 경로(경험이 풍부한 운영자)

1. GCP 프로젝트 생성 + Compute Engine API 활성화
2. Compute Engine VM 생성(e2-small, Debian 12, 20GB)
3. VM에 SSH로 연결
4. 도커 설치
5. OpenClaw 저장소 복제
6. 영구 호스트 디렉터리 생성
7. `.env` 및 `docker-compose.yml` 구성
8. 필수 바이너리 굽기, 빌드 및 실행

---

## 필요한 것

- GCP 계정(e2-micro에 적합한 무료 등급)
- gcloud CLI 설치(또는 Cloud Console 사용)
- 노트북에서 SSH 액세스
- SSH + 복사/붙여넣기를 통한 기본적인 편안함
- ~20~30분
- 도커와 도커 컴포즈
- 모델 인증 자격 증명
- 선택적 공급자 자격 증명
  - 왓츠앱 QR
  - 텔레그램 봇 토큰
  - 지메일 OAuth

---

## 1) gcloud CLI 설치(또는 콘솔 사용)

**옵션 A: gcloud CLI**(자동화에 권장)

[https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)에서 설치하세요.

초기화 및 인증:

```bash
gcloud init
gcloud auth login
```

**옵션 B: Cloud Console**

모든 단계는 [https://console.cloud.google.com](https://console.cloud.google.com)의 웹 UI를 통해 수행할 수 있습니다.

---

## 2) GCP 프로젝트 생성

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

[https://console.cloud.google.com/billing](https://console.cloud.google.com/billing)에서 결제를 활성화합니다(Compute Engine에 필요).

Compute Engine API를 활성화합니다.

```bash
gcloud services enable compute.googleapis.com
```

**콘솔:**

1. IAM 및 관리자 > 프로젝트 생성으로 이동합니다.
2. 이름을 지정하고 생성합니다.
3. 프로젝트에 대한 결제 활성화
4. API 및 서비스 > API 활성화 > "Compute Engine API" 검색 > 활성화로 이동합니다.

---

## 3) VM 생성

**머신 유형:**

| 유형        | 사양                    | 비용                | 메모                 |
| ----------- | ----------------------- | ------------------- | -------------------- |
| e2-소형     | vCPU 2개, 2GB RAM       | ~$12/월             | 추천                 |
| e2-마이크로 | vCPU 2개(공유), 1GB RAM | 무료 등급 적용 가능 | OOM이 로드될 수 있음 |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**콘솔:**

1. Compute Engine > VM 인스턴스 > 인스턴스 만들기로 이동합니다.
2. 이름 : `openclaw-gateway`
3. 지역: `us-central1`, 구역: `us-central1-a`
4. 머신 종류 : `e2-small`
5. 부팅 디스크: Debian 12, 20GB
6. 만들기

---

## 4) VM에 SSH로 연결

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**콘솔:**

Compute Engine 대시보드에서 VM 옆에 있는 'SSH' 버튼을 클릭하세요.

참고: SSH 키 전파는 VM 생성 후 1~2분 정도 걸릴 수 있습니다. 연결이 거부되면 기다렸다가 다시 시도하세요.

---

## 5) Docker 설치(VM에)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

그룹 변경 사항을 적용하려면 로그아웃했다가 다시 로그인하세요.

```bash
exit
```

그런 다음 SSH를 다시 시작합니다.

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

확인:

```bash
docker --version
docker compose version
```

---

## 6) OpenClaw 저장소 복제

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

이 가이드에서는 바이너리 지속성을 보장하기 위해 사용자 지정 이미지를 빌드한다고 가정합니다.

---

## 7) 영구 호스트 디렉터리 생성

Docker 컨테이너는 임시적입니다.
모든 장기 상태는 호스트에 있어야 합니다.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8) 환경 변수 구성

저장소 루트에 `.env`를 생성합니다.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

강력한 비밀을 생성합니다:

```bash
openssl rand -hex 32
```

**이 파일을 커밋하지 마세요.**

---

## 9) Docker Compose 구성

`docker-compose.yml`를 생성하거나 업데이트하세요.

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
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
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

## 10) 필요한 바이너리를 이미지에 굽습니다(중요).

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

## 11) 빌드 및 실행

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

## 12) 게이트웨이 확인

```bash
docker compose logs -f openclaw-gateway
```

성공:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13) 노트북에서 액세스

게이트웨이 포트를 전달할 SSH 터널을 만듭니다.

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

브라우저에서 엽니다.

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

## 업데이트

VM에서 OpenClaw를 업데이트하려면:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## 문제 해결

**SSH 연결이 거부되었습니다**

SSH 키 전파는 VM 생성 후 1~2분 정도 걸릴 수 있습니다. 기다렸다가 다시 시도하세요.

**OS 로그인 문제**

OS 로그인 프로필을 확인하세요.

```bash
gcloud compute os-login describe-profile
```

계정에 필수 IAM 권한(Compute OS 로그인 또는 Compute OS 관리자 로그인)이 있는지 확인하세요.

**메모리 부족(OOM)**

e2-micro를 사용하고 OOM에 도달하는 경우 e2-small 또는 e2-medium으로 업그레이드하세요.

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## 서비스 계정(보안 모범 사례)

개인적인 용도로는 기본 사용자 계정이 제대로 작동합니다.

자동화 또는 CI/CD 파이프라인의 경우 최소한의 권한으로 전용 서비스 계정을 만듭니다.

1. 서비스 계정을 만듭니다.

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Compute 인스턴스 관리자 역할(또는 더 좁은 사용자 정의 역할)을 부여합니다.

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

자동화를 위해 소유자 역할을 사용하지 마십시오. 최소 권한의 원칙을 사용하십시오.

IAM 역할에 대한 자세한 내용은 [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)를 참조하세요.

---

## 다음 단계

- 메시지 채널 설정: [채널](/channels)
- 로컬 장치를 노드로 페어링: [Nodes](/nodes)
- 게이트웨이 구성: [게이트웨이 구성](/gateway/configuration)
