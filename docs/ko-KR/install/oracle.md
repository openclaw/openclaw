---
title: "Oracle Cloud"
summary: "Oracle Cloud 의 Always Free ARM 티어에서 OpenClaw 호스팅"
read_when:
  - Oracle Cloud 에서 OpenClaw 를 설정할 때
  - OpenClaw 를 위한 무료 VPS 호스팅을 찾고 있을 때
  - 소형 서버에서 OpenClaw 를 24/7 실행하고 싶을 때
x-i18n:
  source_path: docs/install/oracle.md
---

# Oracle Cloud

Oracle Cloud 의 **Always Free** ARM 티어 (최대 4 OCPU, 24 GB RAM, 200 GB 스토리지) 에서 무료로 영속적인 OpenClaw Gateway 를 실행합니다.

## 사전 요구사항

- Oracle Cloud 계정 ([가입](https://www.oracle.com/cloud/free/)) -- 문제가 있으면 [커뮤니티 가입 가이드](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)를 참고하세요
- Tailscale 계정 ([tailscale.com](https://tailscale.com) 에서 무료)
- SSH 키 쌍
- 약 30 분

## 설정

<Steps>
  <Step title="OCI 인스턴스 생성">
    1. [Oracle Cloud Console](https://cloud.oracle.com/) 에 로그인합니다.
    2. **Compute > Instances > Create Instance** 로 이동합니다.
    3. 구성:
       - **이름:** `openclaw`
       - **이미지:** Ubuntu 24.04 (aarch64)
       - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
       - **OCPU:** 2 (최대 4)
       - **메모리:** 12 GB (최대 24 GB)
       - **부팅 볼륨:** 50 GB (최대 200 GB 무료)
       - **SSH 키:** 공개 키 추가
    4. **Create** 를 클릭하고 공용 IP 주소를 메모합니다.

    <Tip>
    인스턴스 생성이 "Out of capacity" 로 실패하면 다른 가용성 도메인을 시도하거나 나중에 다시 시도하세요. 무료 티어 용량은 제한되어 있습니다.
    </Tip>

  </Step>

  <Step title="연결 및 시스템 업데이트">
    ```bash
    ssh ubuntu@YOUR_PUBLIC_IP

    sudo apt update && sudo apt upgrade -y
    sudo apt install -y build-essential
    ```

    `build-essential` 은 일부 의존성의 ARM 컴파일에 필요합니다.

  </Step>

  <Step title="사용자 및 호스트이름 구성">
    ```bash
    sudo hostnamectl set-hostname openclaw
    sudo passwd ubuntu
    sudo loginctl enable-linger ubuntu
    ```

    linger 를 활성화하면 로그아웃 후에도 사용자 서비스가 계속 실행됩니다.

  </Step>

  <Step title="Tailscale 설치">
    ```bash
    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up --ssh --hostname=openclaw
    ```

    이후부터 Tailscale 로 연결합니다: `ssh ubuntu@openclaw`.

  </Step>

  <Step title="OpenClaw 설치">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    source ~/.bashrc
    ```

    "How do you want to hatch your bot?" 프롬프트가 나오면 **Do this later** 를 선택합니다.

  </Step>

  <Step title="Gateway 구성">
    안전한 원격 접근을 위해 Tailscale Serve 와 함께 토큰 인증을 사용합니다.

    ```bash
    openclaw config set gateway.bind loopback
    openclaw config set gateway.auth.mode token
    openclaw doctor --generate-gateway-token
    openclaw config set gateway.tailscale.mode serve
    openclaw config set gateway.trustedProxies '["127.0.0.1"]'

    systemctl --user restart openclaw-gateway
    ```

  </Step>

  <Step title="VCN 보안 잠금">
    네트워크 에지에서 Tailscale 을 제외한 모든 트래픽을 차단합니다:

    1. OCI Console 에서 **Networking > Virtual Cloud Networks** 로 이동합니다.
    2. VCN 을 클릭한 다음 **Security Lists > Default Security List** 를 클릭합니다.
    3. `0.0.0.0/0 UDP 41641` (Tailscale) 을 제외한 모든 수신 규칙을 **제거**합니다.
    4. 기본 송신 규칙을 유지합니다 (모든 아웃바운드 허용).

    이것은 네트워크 에지에서 포트 22 (SSH), HTTP, HTTPS 및 기타 모든 것을 차단합니다. 이 시점부터 Tailscale 을 통해서만 연결할 수 있습니다.

  </Step>

  <Step title="확인">
    ```bash
    openclaw --version
    systemctl --user status openclaw-gateway
    tailscale serve status
    curl http://localhost:18789
    ```

    tailnet 의 모든 장치에서 Control UI 에 접근:

    ```
    https://openclaw.<tailnet-name>.ts.net/
    ```

    `<tailnet-name>` 을 tailnet 이름 (`tailscale status` 에서 확인 가능) 으로 교체하세요.

  </Step>
</Steps>

## 대안: SSH 터널

Tailscale Serve 가 작동하지 않으면 로컬 머신에서 SSH 터널을 사용합니다:

```bash
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

그런 다음 `http://localhost:18789` 를 엽니다.

## 문제 해결

**인스턴스 생성 실패 ("Out of capacity")** -- 무료 티어 ARM 인스턴스는 인기가 많습니다. 다른 가용성 도메인을 시도하거나 비피크 시간에 다시 시도하세요.

**Tailscale 연결 안 됨** -- `sudo tailscale up --ssh --hostname=openclaw --reset` 으로 재인증하세요.

**Gateway 시작 안 됨** -- `openclaw doctor --non-interactive` 를 실행하고 `journalctl --user -u openclaw-gateway -n 50` 으로 로그를 확인하세요.

**ARM 바이너리 문제** -- 대부분의 npm 패키지는 ARM64 에서 작동합니다. 네이티브 바이너리의 경우 `linux-arm64` 또는 `aarch64` 릴리스를 찾으세요. `uname -m` 으로 아키텍처를 확인하세요.

## 다음 단계

- [채널](/channels) -- Telegram, WhatsApp, Discord 등 연결
- [Gateway 구성](/gateway/configuration) -- 모든 설정 옵션
- [업데이트](/install/updating) -- OpenClaw 최신 상태 유지
