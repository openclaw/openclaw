---
title: "Raspberry Pi"
summary: "상시 가동 셀프 호스팅을 위한 Raspberry Pi 에서 OpenClaw 호스팅"
read_when:
  - Raspberry Pi 에서 OpenClaw 를 설정할 때
  - ARM 장치에서 OpenClaw 를 실행할 때
  - 저렴한 상시 가동 개인 AI 를 구축할 때
x-i18n:
  source_path: docs/install/raspberry-pi.md
---

# Raspberry Pi

Raspberry Pi 에서 영속적이고 상시 가동하는 OpenClaw Gateway 를 실행합니다. Pi 는 Gateway 역할만 하고 (모델은 API 를 통해 클라우드에서 실행) 적당한 Pi 도 워크로드를 잘 처리합니다.

## 사전 요구사항

- 2 GB+ RAM 의 Raspberry Pi 4 또는 5 (4 GB 권장)
- MicroSD 카드 (16 GB+) 또는 USB SSD (더 나은 성능)
- 공식 Pi 전원 공급 장치
- 네트워크 연결 (이더넷 또는 WiFi)
- 64 비트 Raspberry Pi OS (필수 -- 32 비트를 사용하지 마세요)
- 약 30 분

## 설정

<Steps>
  <Step title="OS 플래시">
    **Raspberry Pi OS Lite (64-bit)** 를 사용합니다 -- 헤드리스 서버에는 데스크톱이 필요 없습니다.

    1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/) 를 다운로드합니다.
    2. OS 선택: **Raspberry Pi OS Lite (64-bit)**.
    3. 설정 대화상자에서 사전 구성:
       - 호스트이름: `gateway-host`
       - SSH 활성화
       - 사용자 이름과 비밀번호 설정
       - WiFi 구성 (이더넷을 사용하지 않는 경우)
    4. SD 카드 또는 USB 드라이브에 플래시하고 삽입한 후 Pi 를 부팅합니다.

  </Step>

  <Step title="SSH 로 연결">
    ```bash
    ssh user@gateway-host
    ```
  </Step>

  <Step title="시스템 업데이트">
    ```bash
    sudo apt update && sudo apt upgrade -y
    sudo apt install -y git curl build-essential

    # 시간대 설정 (cron 및 리마인더에 중요)
    sudo timedatectl set-timezone America/Chicago
    ```

  </Step>

  <Step title="Node.js 24 설치">
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt install -y nodejs
    node --version
    ```
  </Step>

  <Step title="스왑 추가 (2 GB 이하에서 중요)">
    ```bash
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

    # 저 RAM 장치에서 swappiness 줄이기
    echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
    sudo sysctl -p
    ```

  </Step>

  <Step title="OpenClaw 설치">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    ```
  </Step>

  <Step title="온보딩 실행">
    ```bash
    openclaw onboard --install-daemon
    ```

    마법사를 따릅니다. 헤드리스 장치에는 OAuth 보다 API 키를 권장합니다. Telegram 이 시작하기 가장 쉬운 채널입니다.

  </Step>

  <Step title="확인">
    ```bash
    openclaw status
    sudo systemctl status openclaw
    journalctl -u openclaw -f
    ```
  </Step>

  <Step title="Control UI 접근">
    컴퓨터에서 Pi 의 대시보드 URL 을 가져옵니다:

    ```bash
    ssh user@gateway-host 'openclaw dashboard --no-open'
    ```

    그런 다음 다른 터미널에서 SSH 터널을 생성합니다:

    ```bash
    ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
    ```

    출력된 URL 을 로컬 브라우저에서 엽니다. 상시 원격 접근을 위해서는 [Tailscale 통합](/gateway/tailscale)을 참고하세요.

  </Step>
</Steps>

## 성능 팁

**USB SSD 사용** -- SD 카드는 느리고 마모됩니다. USB SSD 가 성능을 극적으로 향상시킵니다. [Pi USB 부팅 가이드](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)를 참고하세요.

**모듈 컴파일 캐시 활성화** -- 저전력 Pi 호스트에서 반복적인 CLI 호출 속도를 높입니다:

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF' # pragma: allowlist secret
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

**메모리 사용량 줄이기** -- 헤드리스 설정에서는 GPU 메모리를 해제하고 사용하지 않는 서비스를 비활성화합니다:

```bash
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt
sudo systemctl disable bluetooth
```

## 문제 해결

**메모리 부족** -- `free -h` 로 스왑이 활성인지 확인합니다. 사용하지 않는 서비스를 비활성화합니다 (`sudo systemctl disable cups bluetooth avahi-daemon`). API 기반 모델만 사용하세요.

**느린 성능** -- SD 카드 대신 USB SSD 를 사용합니다. `vcgencmd get_throttled` 로 CPU 스로틀링을 확인합니다 (`0x0` 을 반환해야 함).

**서비스가 시작되지 않음** -- `journalctl -u openclaw --no-pager -n 100` 으로 로그를 확인하고 `openclaw doctor --non-interactive` 를 실행합니다.

**ARM 바이너리 문제** -- Skill 이 "exec format error" 로 실패하면 바이너리에 ARM64 빌드가 있는지 확인합니다. `uname -m` 으로 아키텍처를 확인합니다 (`aarch64` 를 표시해야 함).

**WiFi 끊김** -- WiFi 전원 관리를 비활성화합니다: `sudo iwconfig wlan0 power off`.

## 다음 단계

- [채널](/channels) -- Telegram, WhatsApp, Discord 등 연결
- [Gateway 구성](/gateway/configuration) -- 모든 설정 옵션
- [업데이트](/install/updating) -- OpenClaw 최신 상태 유지
