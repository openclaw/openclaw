---
read_when:
    - Raspberry Pi에서 OpenClaw 설정
    - ARM 장치에서 OpenClaw 실행
    - 저렴한 상시 접속형 개인 AI 구축
summary: Raspberry Pi의 OpenClaw(예산 자체 호스팅 설정)
title: 라즈베리 파이
x-i18n:
    generated_at: "2026-02-08T16:00:57Z"
    model: gtx
    provider: google-translate
    source_hash: 90b143a2877a4cea162e04902b89d3b5e0c365331c1c3d62e4ec1c0dded0cf6d
    source_path: platforms/raspberry-pi.md
    workflow: 15
---

# 라즈베리 파이의 OpenClaw

## 목표

Raspberry Pi에서 지속적이며 항상 켜져 있는 OpenClaw Gateway를 실행하세요. **~$35-80** 일회성 비용(월 수수료 없음).

완벽한 대상:

- 연중무휴 개인 AI 비서
- 홈 오토메이션 허브
- 저전력, 항상 사용 가능한 Telegram/WhatsApp 봇

## 하드웨어 요구 사항

| Pi Model        | RAM     | Works?   | Notes                              |
| --------------- | ------- | -------- | ---------------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ Best  | Fastest, recommended               |
| **Pi 4**        | 4GB     | ✅ Good  | Sweet spot for most users          |
| **Pi 4**        | 2GB     | ✅ OK    | Works, add swap                    |
| **Pi 4**        | 1GB     | ⚠️ Tight | Possible with swap, minimal config |
| **Pi 3B+**      | 1GB     | ⚠️ Slow  | Works but sluggish                 |
| **Pi Zero 2 W** | 512MB   | ❌       | Not recommended                    |

**최소 사양:** 1GB RAM, 1코어, 500MB 디스크  
**권장사항:** 2GB+ RAM, 64비트 OS, 16GB+ SD 카드(또는 USB SSD)

## 필요한 것

- Raspberry Pi 4 또는 5(2GB 이상 권장)
- MicroSD 카드(16GB+) 또는 USB SSD(더 나은 성능)
- 전원 공급 장치(공식 Pi PSU 권장)
- 네트워크 연결(이더넷 또는 WiFi)
- ~30분

## 1) OS 플래시

사용 **라즈베리 파이 OS 라이트(64비트)** — 헤드리스 서버에는 데스크탑이 필요하지 않습니다.

1. 다운로드 [라즈베리 파이 이미저](https://www.raspberrypi.com/software/)
2. OS를 선택하세요: **라즈베리 파이 OS 라이트(64비트)**
3. 사전 구성하려면 기어 아이콘(⚙️)을 클릭하세요.
   - 호스트 이름 설정: `gateway-host`
   - SSH 활성화
   - 사용자 이름/비밀번호 설정
   - WiFi 구성(이더넷을 사용하지 않는 경우)
4. SD 카드/USB 드라이브에 플래시
5. Pi를 삽입하고 부팅하세요.

## 2) SSH를 통해 연결

```bash
ssh user@gateway-host
# or use the IP address
ssh user@192.168.x.x
```

## 3) 시스템 설정

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install essential packages
sudo apt install -y git curl build-essential

# Set timezone (important for cron/reminders)
sudo timedatectl set-timezone America/Chicago  # Change to your timezone
```

## 4) Node.js 22(ARM64) 설치

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should show v22.x.x
npm --version
```

## 5) 스왑 추가 (2GB 이하일 경우 중요)

스왑은 메모리 부족 충돌을 방지합니다.

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

## 6) 오픈클로 설치

### 옵션 A: 표준 설치(권장)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 옵션 B: 해킹 가능한 설치(개조용)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

해킹 가능한 설치를 통해 로그 및 코드에 직접 액세스할 수 있으므로 ARM 관련 문제를 디버깅하는 데 유용합니다.

## 7) 온보딩 실행

```bash
openclaw onboard --install-daemon
```

마법사를 따르십시오.

1. **게이트웨이 모드:** 현지의
2. **인증:** API 키 권장(헤드리스 Pi에서는 OAuth가 까다로울 수 있음)
3. **채널:** 텔레그램으로 시작하는 것이 가장 쉽습니다.
4. **악마:** 예(시스템)

## 8) 설치 확인

```bash
# Check status
openclaw status

# Check service
sudo systemctl status openclaw

# View logs
journalctl -u openclaw -f
```

## 9) 대시보드에 액세스

Pi는 헤드리스이므로 SSH 터널을 사용합니다.

```bash
# From your laptop/desktop
ssh -L 18789:localhost:18789 user@gateway-host

# Then open in browser
open http://localhost:18789
```

또는 상시 액세스를 위해 Tailscale을 사용하세요.

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

### USB SSD 사용(대단한 개선)

SD 카드는 속도가 느리고 마모됩니다. USB SSD는 성능을 획기적으로 향상시킵니다.

```bash
# Check if booting from USB
lsblk
```

보다 [Pi USB 부팅 가이드](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot) 설정을 위해.

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

## ARM 관련 참고 사항

### 바이너리 호환성

대부분의 OpenClaw 기능은 ARM64에서 작동하지만 일부 외부 바이너리에는 ARM 빌드가 필요할 수 있습니다.

| Tool               | ARM64 Status | Notes                               |
| ------------------ | ------------ | ----------------------------------- |
| Node.js            | ✅           | Works great                         |
| WhatsApp (Baileys) | ✅           | Pure JS, no issues                  |
| Telegram           | ✅           | Pure JS, no issues                  |
| gog (Gmail CLI)    | ⚠️           | Check for ARM release               |
| Chromium (browser) | ✅           | `sudo apt install chromium-browser` |

기술이 실패하면 해당 바이너리에 ARM 빌드가 있는지 확인하세요. 많은 Go/Rust 도구가 그렇게 합니다. 일부는 그렇지 않습니다.

### 32비트와 64비트

**항상 64비트 OS를 사용하십시오.** Node.js와 많은 최신 도구에서는 이를 필요로 합니다. 다음을 통해 확인하세요:

```bash
uname -m
# Should show: aarch64 (64-bit) not armv7l (32-bit)
```

---

## 권장 모델 설정

Pi는 단지 게이트웨이(모델은 클라우드에서 실행됨)이므로 API 기반 모델을 사용하십시오.

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

**Pi에서 로컬 LLM을 실행하려고 하지 마세요.** — 작은 모델이라도 너무 느립니다. Claude/GPT가 무거운 작업을 수행하도록 하세요.

---

## 부팅 시 자동 시작

온보딩 마법사는 이를 설정하지만 확인하기 위해 다음을 수행합니다.

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

### 느린 성능

- SD 카드 대신 USB SSD를 사용하세요
- 사용하지 않는 서비스를 비활성화합니다. `sudo systemctl disable cups bluetooth avahi-daemon`
- CPU 조절을 확인합니다. `vcgencmd get_throttled` (반환해야한다 `0x0`)

### 서비스가 시작되지 않습니다

```bash
# Check logs
journalctl -u openclaw --no-pager -n 100

# Common fix: rebuild
cd ~/openclaw  # if using hackable install
npm run build
sudo systemctl restart openclaw
```

### ARM 바이너리 문제

"실행 형식 오류"로 인해 스킬이 실패하는 경우:

1. 바이너리에 ARM64 빌드가 있는지 확인하세요.
2. 소스에서 빌드해 보세요
3. 또는 ARM을 지원하는 Docker 컨테이너를 사용하세요.

### WiFi 방울

WiFi의 헤드리스 Pis의 경우:

```bash
# Disable WiFi power management
sudo iwconfig wlan0 power off

# Make permanent
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## 비용 비교

| Setup          | One-Time Cost | Monthly Cost | Notes                     |
| -------------- | ------------- | ------------ | ------------------------- |
| **Pi 4 (2GB)** | ~$45          | $0           | + power (~$5/yr)          |
| **Pi 4 (4GB)** | ~$55          | $0           | Recommended               |
| **Pi 5 (4GB)** | ~$60          | $0           | Best performance          |
| **Pi 5 (8GB)** | ~$80          | $0           | Overkill but future-proof |
| DigitalOcean   | $0            | $6/mo        | $72/year                  |
| Hetzner        | $0            | €3.79/mo     | ~$50/year                 |

**손익분기점:** Pi는 클라우드 VPS에 비해 ~6-12개월 내에 비용을 지불합니다.

---

## 참조

- [리눅스 가이드](/platforms/linux) — 일반 Linux 설정
- [디지털오션 가이드](/platforms/digitalocean) — 클라우드 대안
- [헤츠너 가이드](/install/hetzner) — 도커 설정
- [테일스케일](/gateway/tailscale) — 원격 액세스
- [노드](/nodes) — 노트북/휴대폰을 Pi 게이트웨이와 페어링하세요.
