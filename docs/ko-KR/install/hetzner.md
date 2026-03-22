---
title: "Hetzner"
summary: "내구성 있는 상태와 내장 바이너리를 갖춘 저렴한 Hetzner VPS (Docker) 에서 OpenClaw Gateway 를 24/7 실행"
read_when:
  - 클라우드 VPS 에서 OpenClaw 를 24/7 실행하고 싶을 때 (노트북이 아닌)
  - 자체 VPS 에서 프로덕션급 상시 가동 Gateway 를 원할 때
  - 영속성, 바이너리 및 재시작 동작을 완전히 제어하고 싶을 때
  - Hetzner 또는 유사한 프로바이더에서 Docker 로 OpenClaw 를 실행할 때
x-i18n:
  source_path: docs/install/hetzner.md
---

# Hetzner 에서 OpenClaw (Docker, 프로덕션 VPS 가이드)

## 목표

Docker 를 사용하여 Hetzner VPS 에서 영속적인 OpenClaw Gateway 를 실행합니다. 내구성 있는 상태, 내장 바이너리, 안전한 재시작 동작을 포함합니다.

"약 $5 로 OpenClaw 24/7" 를 원한다면, 가장 간단하고 안정적인 설정입니다.
Hetzner 가격은 변경됩니다. 가장 작은 Debian/Ubuntu VPS 를 선택하고 OOM 이 발생하면 확장하세요.

보안 모델 참고:

- 모든 사용자가 동일한 신뢰 경계에 있고 런타임이 업무 전용인 경우 회사 공유 에이전트가 적합합니다.
- 엄격한 분리를 유지하세요: 전용 VPS/런타임 + 전용 계정; 해당 호스트에 개인 Apple/Google/브라우저/비밀번호 관리자 프로필을 사용하지 마세요.
- 사용자가 서로 적대적이면 Gateway/호스트/OS 사용자별로 분리하세요.

[보안](/gateway/security) 및 [VPS 호스팅](/vps)을 참고하세요.

## 수행할 작업 (간단한 설명)

- 작은 Linux 서버 임대 (Hetzner VPS)
- Docker 설치 (격리된 앱 런타임)
- Docker 에서 OpenClaw Gateway 시작
- 호스트에 `~/.openclaw` + `~/.openclaw/workspace` 영속 (재시작/리빌드 후 유지)
- SSH 터널을 통해 노트북에서 Control UI 접근

Gateway 는 다음을 통해 접근할 수 있습니다:

- 노트북에서의 SSH 포트 포워딩
- 방화벽과 토큰을 직접 관리하는 경우 직접 포트 노출

이 가이드는 Hetzner 의 Ubuntu 또는 Debian 을 가정합니다.
다른 Linux VPS 를 사용하는 경우 패키지를 적절히 매핑하세요.
일반 Docker 플로우는 [Docker](/install/docker)를 참고하세요.

---

## 빠른 경로 (경험 있는 운영자)

1. Hetzner VPS 프로비저닝
2. Docker 설치
3. OpenClaw 저장소 복제
4. 영속 호스트 디렉토리 생성
5. `.env` 및 `docker-compose.yml` 구성
6. 필수 바이너리를 이미지에 내장
7. `docker compose up -d`
8. 영속성 및 Gateway 접근 확인

---

## 필요한 것

- root 접근이 가능한 Hetzner VPS
- 노트북에서의 SSH 접근
- SSH + 복사/붙여넣기에 대한 기본적인 편안함
- 약 20 분
- Docker 및 Docker Compose
- 모델 인증 자격 증명
- 선택적 프로바이더 자격 증명
  - WhatsApp QR
  - Telegram 봇 토큰
  - Gmail OAuth

---

<Steps>
  <Step title="VPS 프로비저닝">
    Hetzner 에서 Ubuntu 또는 Debian VPS 를 생성합니다.

    root 로 연결:

    ```bash
    ssh root@YOUR_VPS_IP
    ```

    이 가이드는 VPS 가 상태 유지라고 가정합니다.
    일회용 인프라로 취급하지 마세요.

  </Step>

  <Step title="Docker 설치 (VPS 에서)">
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
    mkdir -p /root/.openclaw/workspace

    # 컨테이너 사용자 (uid 1000) 로 소유권 설정:
    chown -R 1000:1000 /root/.openclaw
    ```

  </Step>

  <Step title="환경 변수 구성">
    저장소 루트에 `.env` 를 생성합니다.

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

  <Step title="Hetzner 전용 접근">
    공유 빌드 및 실행 단계 후 노트북에서 터널링:

    ```bash
    ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
    ```

    열기:

    `http://127.0.0.1:18789/`

    Gateway 토큰을 붙여넣습니다.

  </Step>
</Steps>

공유 영속성 맵은 [Docker VM Runtime](/install/docker-vm-runtime#what-persists-where)에 있습니다.

## Infrastructure as Code (Terraform)

Infrastructure as Code 워크플로우를 선호하는 팀을 위해 커뮤니티에서 관리하는 Terraform 설정이 제공합니다:

- 원격 상태 관리가 포함된 모듈식 Terraform 구성
- cloud-init 을 통한 자동 프로비저닝
- 배포 스크립트 (부트스트랩, 배포, 백업/복원)
- 보안 강화 (방화벽, UFW, SSH 전용 접근)
- Gateway 접근을 위한 SSH 터널 구성

**저장소:**

- 인프라: [openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- Docker 설정: [openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

이 접근 방식은 위의 Docker 설정을 재현 가능한 배포, 버전 관리된 인프라 및 자동화된 재해 복구로 보완합니다.

> **참고:** 커뮤니티에서 관리합니다. 문제나 기여에 대해서는 위의 저장소 링크를 참고하세요.

## 다음 단계

- 메시징 채널 설정: [채널](/channels)
- Gateway 구성: [Gateway 구성](/gateway/configuration)
- OpenClaw 최신 상태 유지: [업데이트](/install/updating)
