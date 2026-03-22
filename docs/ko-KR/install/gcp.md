---
title: "GCP"
summary: "내구성 있는 상태를 갖춘 GCP Compute Engine VM (Docker) 에서 OpenClaw Gateway 를 24/7 실행"
read_when:
  - GCP 에서 OpenClaw 를 24/7 실행하고 싶을 때
  - 자체 VM 에서 프로덕션급 상시 가동 Gateway 를 원할 때
  - 영속성, 바이너리 및 재시작 동작을 완전히 제어하고 싶을 때
x-i18n:
  source_path: docs/install/gcp.md
---

# GCP Compute Engine 에서 OpenClaw (Docker, 프로덕션 VPS 가이드)

## 목표

Docker 를 사용하여 GCP Compute Engine VM 에서 영속적인 OpenClaw Gateway 를 실행합니다. 내구성 있는 상태, 내장 바이너리, 안전한 재시작 동작을 포함합니다.

"약 월 $5-12 로 OpenClaw 24/7" 를 원한다면, Google Cloud 에서 안정적인 설정입니다.
가격은 머신 유형과 리전에 따라 다릅니다. 워크로드에 맞는 가장 작은 VM 을 선택하고 OOM 이 발생하면 확장하세요.

## 수행할 작업 (간단한 설명)

- GCP 프로젝트 생성 및 결제 활성화
- Compute Engine VM 생성
- Docker 설치 (격리된 앱 런타임)
- Docker 에서 OpenClaw Gateway 시작
- 호스트에 `~/.openclaw` + `~/.openclaw/workspace` 영속 (재시작/리빌드 후 유지)
- SSH 터널을 통해 노트북에서 Control UI 접근

Gateway 는 다음을 통해 접근할 수 있습니다:

- 노트북에서의 SSH 포트 포워딩
- 방화벽과 토큰을 직접 관리하는 경우 직접 포트 노출

이 가이드는 GCP Compute Engine 의 Debian 을 사용합니다.
Ubuntu 도 작동합니다. 패키지를 적절히 매핑하세요.
일반 Docker 플로우는 [Docker](/install/docker)를 참고하세요.

---

## 빠른 경로 (경험 있는 운영자)

1. GCP 프로젝트 생성 + Compute Engine API 활성화
2. Compute Engine VM 생성 (e2-small, Debian 12, 20GB)
3. VM 에 SSH
4. Docker 설치
5. OpenClaw 저장소 복제
6. 영속 호스트 디렉토리 생성
7. `.env` 및 `docker-compose.yml` 구성
8. 필수 바이너리 내장, 빌드 및 실행

---

## 필요한 것

- GCP 계정 (무료 티어는 e2-micro 에 적용 가능)
- gcloud CLI 설치 (또는 Cloud Console 사용)
- 노트북에서의 SSH 접근
- SSH + 복사/붙여넣기에 대한 기본적인 편안함
- 약 20-30 분
- Docker 및 Docker Compose
- 모델 인증 자격 증명
- 선택적 프로바이더 자격 증명
  - WhatsApp QR
  - Telegram 봇 토큰
  - Gmail OAuth

---

<Steps>
  <Step title="gcloud CLI 설치 (또는 Console 사용)">
    **옵션 A: gcloud CLI** (자동화에 권장)

    [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) 에서 설치

    초기화 및 인증:

    ```bash
    gcloud init
    gcloud auth login
    ```

    **옵션 B: Cloud Console**

    모든 단계를 [https://console.cloud.google.com](https://console.cloud.google.com) 의 웹 UI 에서 수행할 수 있습니다

  </Step>

  <Step title="GCP 프로젝트 생성">
    **CLI:**

    ```bash
    gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
    gcloud config set project my-openclaw-project
    ```

    [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) 에서 결제를 활성화합니다 (Compute Engine 에 필요).

    Compute Engine API 를 활성화합니다:

    ```bash
    gcloud services enable compute.googleapis.com
    ```

    **Console:**

    1. IAM & Admin > Create Project 로 이동
    2. 이름을 지정하고 생성
    3. 프로젝트에 대한 결제 활성화
    4. APIs & Services > Enable APIs > "Compute Engine API" 검색 > Enable 로 이동

  </Step>

  <Step title="VM 생성">
    **머신 유형:**

    | 유형      | 사양                     | 비용               | 참고                                         |
    | --------- | ------------------------ | ------------------ | -------------------------------------------- |
    | e2-medium | 2 vCPU, 4GB RAM          | 약 월 $25          | 로컬 Docker 빌드에 가장 안정적               |
    | e2-small  | 2 vCPU, 2GB RAM          | 약 월 $12          | Docker 빌드 최소 권장                         |
    | e2-micro  | 2 vCPU (공유), 1GB RAM   | 무료 티어 적용 가능 | Docker 빌드 OOM 자주 발생 (종료 코드 137)     |

    **CLI:**

    ```bash
    gcloud compute instances create openclaw-gateway \
      --zone=us-central1-a \
      --machine-type=e2-small \
      --boot-disk-size=20GB \
      --image-family=debian-12 \
      --image-project=debian-cloud
    ```

    **Console:**

    1. Compute Engine > VM instances > Create instance 로 이동
    2. 이름: `openclaw-gateway`
    3. 리전: `us-central1`, 존: `us-central1-a`
    4. 머신 유형: `e2-small`
    5. 부팅 디스크: Debian 12, 20GB
    6. Create

  </Step>

  <Step title="VM 에 SSH">
    **CLI:**

    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a
    ```

    **Console:**

    Compute Engine 대시보드에서 VM 옆의 "SSH" 버튼을 클릭합니다.

    참고: SSH 키 전파에 VM 생성 후 1-2 분이 걸릴 수 있습니다. 연결이 거부되면 기다렸다가 다시 시도하세요.

  </Step>

  <Step title="Docker 설치 (VM 에서)">
    ```bash
    sudo apt-get update
    sudo apt-get install -y git curl ca-certificates
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    ```

    그룹 변경이 적용되려면 로그아웃 후 다시 로그인합니다:

    ```bash
    exit
    ```

    그런 다음 다시 SSH:

    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a
    ```

    확인:

    ```bash
    docker --version
    docker compose version
    ```

  </Step>

  <Step title="OpenClaw 저장소 복제">
    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    ```

    이 가이드는 바이너리 영속성을 보장하기 위해 커스텀 이미지를 빌드한다고 가정합니다.

  </Step>

  <Step title="영속 호스트 디렉토리 생성">
    Docker 컨테이너는 임시적입니다.
    모든 장기 상태는 호스트에 있어야 합니다.

    ```bash
    mkdir -p ~/.openclaw
    mkdir -p ~/.openclaw/workspace
    ```

  </Step>

  <Step title="환경 변수 구성">
    저장소 루트에 `.env` 를 생성합니다.

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

    강력한 시크릿 생성:

    ```bash
    openssl rand -hex 32
    ```

    **이 파일을 커밋하지 마세요.**

  </Step>

  <Step title="Docker Compose 구성">
    `docker-compose.yml` 을 생성하거나 업데이트합니다.

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
          # 권장: VPS 에서 Gateway 를 loopback 전용으로 유지; SSH 터널로 접근.
          # 공개적으로 노출하려면 `127.0.0.1:` 프리픽스를 제거하고 적절히 방화벽 설정.
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

    `--allow-unconfigured` 는 부트스트랩 편의를 위한 것일 뿐, 적절한 Gateway 구성을 대체하지 않습니다. 여전히 인증 (`gateway.auth.token` 또는 비밀번호) 을 설정하고 배포에 안전한 바인드 설정을 사용하세요.

  </Step>

  <Step title="공유 Docker VM 런타임 단계">
    공통 Docker 호스트 플로우에 대한 공유 런타임 가이드를 사용하세요:

    - [필수 바이너리를 이미지에 내장](/install/docker-vm-runtime#bake-required-binaries-into-the-image)
    - [빌드 및 실행](/install/docker-vm-runtime#build-and-launch)
    - [어디에 무엇이 영속되는가](/install/docker-vm-runtime#what-persists-where)
    - [업데이트](/install/docker-vm-runtime#updates)

  </Step>

  <Step title="GCP 전용 실행 참고">
    GCP 에서 `pnpm install --frozen-lockfile` 중 `Killed` 또는 `exit code 137` 로 빌드가 실패하면 VM 의 메모리가 부족한 것입니다. 최소 `e2-small` 또는 안정적인 첫 빌드를 위해 `e2-medium` 을 사용하세요.

    LAN 바인딩 (`OPENCLAW_GATEWAY_BIND=lan`) 시 계속하기 전에 신뢰할 수 있는 브라우저 오리진을 구성하세요:

    ```bash
    docker compose run --rm openclaw-cli config set gateway.controlUi.allowedOrigins '["http://127.0.0.1:18789"]' --strict-json
    ```

    Gateway 포트를 변경한 경우 `18789` 를 구성된 포트로 교체하세요.

  </Step>

  <Step title="노트북에서 접근">
    Gateway 포트를 전달하는 SSH 터널을 생성합니다:

    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
    ```

    브라우저에서 엽니다:

    `http://127.0.0.1:18789/`

    새로운 토큰화된 대시보드 링크를 가져옵니다:

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    ```

    해당 URL 에서 토큰을 붙여넣습니다.

    Control UI 에 `unauthorized` 또는 `disconnected (1008): pairing required` 가 표시되면 브라우저 장치를 승인하세요:

    ```bash
    docker compose run --rm openclaw-cli devices list
    docker compose run --rm openclaw-cli devices approve <requestId>
    ```

    공유 영속성 및 업데이트 레퍼런스가 다시 필요하면
    [Docker VM Runtime](/install/docker-vm-runtime#what-persists-where) 과 [Docker VM Runtime 업데이트](/install/docker-vm-runtime#updates)를 참고하세요.

  </Step>
</Steps>

---

## 문제 해결

**SSH 연결 거부**

VM 생성 후 SSH 키 전파에 1-2 분이 걸릴 수 있습니다. 기다렸다가 다시 시도하세요.

**OS Login 문제**

OS Login 프로필을 확인하세요:

```bash
gcloud compute os-login describe-profile
```

계정에 필요한 IAM 권한 (Compute OS Login 또는 Compute OS Admin Login) 이 있는지 확인하세요.

**메모리 부족 (OOM)**

Docker 빌드가 `Killed` 및 `exit code 137` 로 실패하면 VM 이 OOM-kill 된 것입니다. 최소 e2-small 또는 안정적인 로컬 빌드를 위해 e2-medium (권장) 으로 업그레이드하세요:

```bash
# 먼저 VM 중지
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# 머신 유형 변경
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# VM 시작
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## 서비스 계정 (보안 모범 사례)

개인 사용의 경우 기본 사용자 계정으로 충분합니다.

자동화 또는 CI/CD 파이프라인의 경우 최소 권한으로 전용 서비스 계정을 생성하세요:

1. 서비스 계정 생성:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Compute Instance Admin 역할 (또는 더 좁은 커스텀 역할) 부여:

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

자동화에 Owner 역할을 사용하지 마세요. 최소 권한 원칙을 사용하세요.

IAM 역할 세부사항은 [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles)를 참고하세요.

---

## 다음 단계

- 메시징 채널 설정: [채널](/channels)
- 로컬 장치를 노드로 페어링: [노드](/nodes)
- Gateway 구성: [Gateway 구성](/gateway/configuration)
