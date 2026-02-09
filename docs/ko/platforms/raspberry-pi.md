---
summary: "Raspberry Pi에서 OpenClaw 실행 (저예산 셀프 호스팅 설정)"
read_when:
  - Raspberry Pi에서 OpenClaw 설정하기
  - ARM 디바이스에서 OpenClaw 실행하기
  - 저렴한 상시 실행 개인 AI 구축하기
title: "Raspberry Pi"
---

# Raspberry Pi에서 OpenClaw 실행

## 목표

Raspberry Pi에서 **약 $35-80**의 일회성 비용(월 사용료 없음)으로 지속적으로 실행되는 항상 켜져 있는 OpenClaw Gateway(게이트웨이)를 실행합니다.

다음과 같은 용도에 적합합니다:

- 24/7 개인 AI 어시스턴트
- 홈 자동화 허브
- 저전력, 항상 사용 가능한 Telegram/WhatsApp 봇

## 하드웨어 요구 사항

| Pi 모델           | RAM     | 작동 여부  | 참고 사항          |
| --------------- | ------- | ------ | -------------- |
| **Pi 5**        | 4GB/8GB | ✅ 최고   | 가장 빠르며 권장됨     |
| **Pi 4**        | 4GB     | ✅ 좋음   | 대부분의 사용자에게 최적  |
| **Pi 4**        | 2GB     | ✅ 확인   | 작동함, 스왑 추가     |
| **Pi 4**        | 1GB     | ⚠️ 빡빡함 | 스왑으로 가능, 최소 구성 |
| **Pi 3B+**      | 1GB     | ⚠️ 느림  | 작동하지만 반응이 둔함   |
| **Pi Zero 2 W** | 512MB   | ❌      | 권장하지 않음        |

**최소 사양:** RAM 1GB, 1 코어, 디스크 500MB  
**권장 사양:** RAM 2GB 이상, 64비트 OS, 16GB 이상 SD 카드(또는 USB SSD)

## 필요한 것

- Raspberry Pi 4 또는 5 (2GB 이상 권장)
- MicroSD 카드(16GB 이상) 또는 USB SSD(더 나은 성능)
- 전원 어댑터(공식 Pi PSU 권장)
- 네트워크 연결(Ethernet 또는 WiFi)
- 약 30분

## 1. OS 플래시

헤드리스 서버에는 데스크톱이 필요 없으므로 \*\*Raspberry Pi OS Lite (64-bit)\*\*를 사용합니다.

1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/) 다운로드
2. OS 선택: **Raspberry Pi OS Lite (64-bit)**
3. 톱니바퀴 아이콘(⚙️)을 클릭하여 사전 설정:
   - 호스트명 설정: `gateway-host`
   - SSH 활성화
   - 사용자 이름/비밀번호 설정
   - WiFi 구성(Ethernet을 사용하지 않는 경우)
4. SD 카드 / USB 드라이브에 플래시
5. Pi에 삽입 후 부팅

## 2) SSH로 연결

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3. 시스템 설정

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4. Node.js 22 설치 (ARM64)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5. 스왑 추가 (2GB 이하에서는 중요)

스왑은 메모리 부족으로 인한 크래시를 방지합니다:

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize for low RAM (reduce swappiness)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6. OpenClaw 설치

### 옵션 A: 표준 설치 (권장)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 옵션 B: 해킹 가능한 설치 (튜닝용)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

해킹 가능한 설치는 로그와 코드에 직접 접근할 수 있어 ARM 전용 문제를 디버깅하는 데 유용합니다.

## 7. 온보딩 실행

```bash
openclaw onboard --install-daemon
```

마법사의 안내를 따르십시오:

1. **Gateway 모드:** Local
2. **인증:** API 키 권장(OAuth는 헤드리스 Pi에서 불안정할 수 있음)
3. **채널:** Telegram이 시작하기 가장 쉬움
4. **데몬:** 예(systemd)

## 8) 설치 확인

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9. 대시보드 접근

Pi는 헤드리스이므로 SSH 터널을 사용합니다:

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

또는 상시 접근을 위해 Tailscale을 사용합니다:

```bash
# On the Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Update config
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## 성능 최적화

### USB SSD 사용 (큰 개선)

SD 카드는 느리고 마모됩니다. USB SSD는 성능을 크게 향상시킵니다:

```bash
# Check if booting from USB
lsblk
```

설정 방법은 [Pi USB 부트 가이드](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)를 참고하십시오.

### 메모리 사용량 줄이기

```bash
# Disable GPU memory allocation (headless)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# Disable Bluetooth if not needed
sudo systemctl disable bluetooth
```

### 리소스 모니터링

```bash
# Check memory
free -h

# Check CPU temperature
vcgencmd measure_temp

# Live monitoring
htop
```

---

## ARM 전용 참고 사항

### 바이너리 호환성

대부분의 OpenClaw 기능은 ARM64에서 작동하지만, 일부 외부 바이너리는 ARM 빌드가 필요할 수 있습니다:

| 도구                                    | ARM64 상태 | 참고 사항                               |
| ------------------------------------- | -------- | ----------------------------------- |
| Node.js               | ✅        | 매우 잘 작동함                            |
| WhatsApp (Baileys) | ✅        | 순수 JS, 문제 없음                        |
| Telegram                              | ✅        | 순수 JS, 문제 없음                        |
| gog (Gmail CLI)    | ⚠️       | ARM 릴리스 여부 확인 필요                    |
| Chromium (브라우저)    | ✅        | `sudo apt install chromium-browser` |

Skill이 실패하면 해당 바이너리에 ARM 빌드가 있는지 확인하십시오. 많은 Go/Rust 도구는 지원하지만, 일부는 지원하지 않습니다.

### 32비트 vs 64비트

**항상 64비트 OS를 사용하십시오.** Node.js와 많은 최신 도구는 이를 요구합니다. 다음 명령으로 확인할 수 있습니다:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## 권장 모델 설정

Pi는 Gateway(게이트웨이) 역할만 수행하고 모델은 클라우드에서 실행되므로 API 기반 모델을 사용하십시오:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514",
        "fallbacks": ["openai/gpt-4o-mini"]
      }
    }
  }
}
```

**Pi에서 로컬 LLM을 실행하려고 하지 마십시오** — 작은 모델조차 너무 느립니다. Claude/GPT가 연산을 처리하도록 하십시오.

---

## 부팅 시 자동 시작

온보딩 마법사가 이를 설정하지만, 확인하려면 다음을 실행하십시오:

```bash
# Check service is enabled
sudo systemctl is-enabled openclaw

# Enable if not
sudo systemctl enable openclaw

# Start on boot
sudo systemctl start openclaw
```

---

## 문제 해결

### 메모리 부족(OOM)

```bash
# Check memory
free -h

# Add more swap (see Step 5)
# Or reduce services running on the Pi
```

### 성능 저하

- SD 카드 대신 USB SSD 사용
- 사용하지 않는 서비스 비활성화: `sudo systemctl disable cups bluetooth avahi-daemon`
- CPU 스로틀링 확인: `vcgencmd get_throttled` (`0x0`가 반환되어야 함)

### 서비스가 시작되지 않음

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM 바이너리 문제

Skill 실행 시 "exec format error"가 발생하면:

1. 바이너리에 ARM64 빌드가 있는지 확인
2. 소스에서 직접 빌드 시도
3. 또는 ARM을 지원하는 Docker 컨테이너 사용

### WiFi 끊김

WiFi를 사용하는 헤드리스 Pi의 경우:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## 비용 비교

| 설정                                | 일회성 비용               | 월 비용                    | 참고 사항                                           |
| --------------------------------- | -------------------- | ----------------------- | ----------------------------------------------- |
| **Pi 4 (2GB)** | ~$45 | $0                      | + 전기 (~$5/년) |
| **Pi 4 (4GB)** | ~$55 | $0                      | 권장됨                                             |
| **Pi 5 (4GB)** | ~$60 | $0                      | 최고 성능                                           |
| **Pi 5 (8GB)** | ~$80 | $0                      | 과하지만 미래 대비 가능                                   |
| DigitalOcean                      | $0                   | $6/월                    | 연 $72                                           |
| Hetzner                           | $0                   | €3.79/월 | 연 ~$50                          |

**손익분기점:** Pi는 클라우드 VPS 대비 약 6-12개월 내에 본전을 회수합니다.

---

## 참고

- [Linux 가이드](/platforms/linux) — 일반 Linux 설정
- [DigitalOcean 가이드](/platforms/digitalocean) — 클라우드 대안
- [Hetzner 가이드](/install/hetzner) — Docker 설정
- [Tailscale](/gateway/tailscale) — 원격 접근
- [Nodes](/nodes) — 노트북/휴대폰을 Pi Gateway(게이트웨이)와 페어링
