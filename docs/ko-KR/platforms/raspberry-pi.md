````markdown
---
summary: "Raspberry Pi (저렴한 자가 호스팅 설정)의 OpenClaw"
read_when:
  - Raspberry Pi 에 OpenClaw 설정하기
  - ARM 장치에서 OpenClaw 실행하기
  - 저렴한 상시 작동 개인 AI 구축하기
title: "Raspberry Pi"
---

# Raspberry Pi 의 OpenClaw

## 목표

**~$35-80**의 일회성 비용으로 Raspberry Pi 에 지속적이고 상시 작동하는 OpenClaw 게이트웨이를 실행합니다 (월정액 없음).

다음에 적합합니다:

- 24/7 개인 AI 비서
- 홈 자동화 허브
- 저전력 상시 가용 Telegram/WhatsApp 봇

## 하드웨어 요구사항

| Pi 모델         | RAM     | 작동 여부 | 메모                      |
| --------------- | ------- | --------- | ------------------------- |
| **Pi 5**        | 4GB/8GB | ✅ 최상   | 가장 빠르고 추천          |
| **Pi 4**        | 4GB     | ✅ 좋음   | 대부분 사용자에게 최적    |
| **Pi 4**        | 2GB     | ✅ 양호   | 작동, 스왑 추가           |
| **Pi 4**        | 1GB     | ⚠️ 빡빡   | 스왑과 최소 설정으로 가능 |
| **Pi 3B+**      | 1GB     | ⚠️ 느림   | 작동 가능하나 느림        |
| **Pi Zero 2 W** | 512MB   | ❌        | 권장되지 않음             |

**최소 사양:** 1GB RAM, 1 코어, 500MB 디스크  
**권장 사양:** 2GB+ RAM, 64비트 OS, 16GB+ SD 카드 (또는 USB SSD)

## 필요한 것들

- Raspberry Pi 4 또는 5 (2GB+ 권장)
- MicroSD 카드 (16GB+) 또는 USB SSD (성능이 더 좋음)
- 전원 공급 장치 (공식 Pi PSU 권장)
- 네트워크 연결 (이더넷 또는 WiFi)
- 약 30분

## 1) OS 플래시하기

**Raspberry Pi OS Lite (64-bit)** 사용 — 헤드리스 서버에 데스크탑 필요 없음.

1. [Raspberry Pi Imager](https://www.raspberrypi.com/software/) 다운로드
2. OS 선택: **Raspberry Pi OS Lite (64-bit)**
3. 설정 아이콘(⚙️) 클릭하여 미리 설정:
   - 호스트네임 설정: `gateway-host`
   - SSH 활성화
   - 사용자 이름/비밀번호 설정
   - WiFi 설정 (이더넷 사용하지 않을 경우)
4. SD 카드 / USB 드라이브에 플래시
5. Pi 에 삽입하고 부팅

## 2) SSH 로 연결

```bash
ssh user@gateway-host
# 또는 IP 주소 사용
ssh user@192.168.x.x
```
````

## 3) 시스템 설정

```bash
# 시스템 업데이트
sudo apt update && sudo apt upgrade -y

# 필수 패키지 설치
sudo apt install -y git curl build-essential

# 타임존 설정 (크론/알림에 중요)
sudo timedatectl set-timezone America/Chicago  # 당신의 타임존으로 변경하세요
```

## 4) Node.js 22 (ARM64) 설치

```bash
# NodeSource 를 통해 Node.js 설치
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 확인
node --version  # v22.x.x 표시되어야 함
npm --version
```

## 5) 스왑 추가 (2GB 이하에 중요)

스왑은 메모리 부족 충돌을 방지:

```bash
# 2GB 스왑 파일 생성
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# 영구화
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 저 RAM 용으로 최적화 (스와피니스 줄이기)
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 6) OpenClaw 설치

### 옵션 A: 표준 설치 (권장)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 옵션 B: 해킹 가능한 설치 (조정용)

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
npm install
npm run build
npm link
```

해킹 가능한 설치는 로그와 코드에 직접 접근 가능 — ARM 특정 문제 디버깅에 유용.

## 7) 온보딩 실행

```bash
openclaw onboard --install-daemon
```

마법사를 따릅니다:

1. **게이트웨이 모드:** 로컬
2. **인증:** API 키 추천 (OAuth 는 헤드리스 Pi 에서 까다로울 수 있음)
3. **채널:** Telegram 이 시작하기 가장 쉬움
4. **데몬:** 예 (systemd)

## 8) 설치 확인

```bash
# 상태 확인
openclaw status

# 서비스 확인
sudo systemctl status openclaw

# 로그 보기
journalctl -u openclaw -f
```

## 9) 대시보드 접근

Pi 가 헤드리스이므로 SSH 터널 사용:

```bash
# 노트북/데스크탑에서
ssh -L 18789:localhost:18789 user@gateway-host

# 그런 다음 브라우저에서 열기
open http://localhost:18789
```

또는 Tailscale 을 사용하여 상시 접근:

```bash
# Pi 에서
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 구성 업데이트
openclaw config set gateway.bind tailnet
sudo systemctl restart openclaw
```

---

## 성능 최적화

### USB SSD 사용 (큰 개선)

SD 카드는 속도가 느리고 마모됩니다. USB SSD 는 성능을 크게 향상시킵니다:

```bash
# USB 로 부팅하는지 확인
lsblk
```

설정을 위해 [Pi USB 부팅 가이드](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot)를 참조.

### 메모리 사용 줄이기

```bash
# GPU 메모리 할당 비활성화 (헤드리스)
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt

# 블루투스가 필요 없다면 비활성화
sudo systemctl disable bluetooth
```

### 리소스 모니터링

```bash
# 메모리 확인
free -h

# CPU 온도 확인
vcgencmd measure_temp

# 실시간 모니터링
htop
```

---

## ARM 구체적인 주의사항

### 바이너리 호환성

대부분의 OpenClaw 기능은 ARM64 에서 작동하지만, 일부 외부 바이너리는 ARM 빌드가 필요할 수 있습니다:

| 도구                | ARM64 상태 | 메모                                |
| ------------------- | ---------- | ----------------------------------- |
| Node.js             | ✅         | 잘 작동함                           |
| WhatsApp (Baileys)  | ✅         | 순수 JS, 문제 없음                  |
| Telegram            | ✅         | 순수 JS, 문제 없음                  |
| gog (Gmail CLI)     | ⚠️         | ARM 릴리즈 확인                     |
| Chromium (브라우저) | ✅         | `sudo apt install chromium-browser` |

스킬이 실패하면 바이너리에 ARM 빌드가 있는지 확인하세요. 많은 Go/Rust 도구가 빌드를 제공합니다; 일부는 제공하지 않습니다.

### 32비트 vs 64비트

**항상 64비트 OS 사용.** Node.js 및 많은 최신 도구가 요구합니다. 다음으로 확인하세요:

```bash
uname -m
# 'aarch64' (64-bit) 표시, 'armv7l' (32-bit) 아님
```

---

## 권장 모델 설정

Pi 는 게이트웨이일 뿐이므로 (모델은 클라우드에서 실행됨), API 기반 모델을 사용하세요:

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

**Pi 에서 로컬 LLM 실행을 시도하지 마세요** — 작은 모델도 너무 느립니다. Claude/GPT 에 무거운 작업을 맡기세요.

---

## 부팅 시 자동 시작

온보딩 마법사가 설정합니다, 하지만 확인하기 위해:

```bash
# 서비스가 활성화되었는지 확인
sudo systemctl is-enabled openclaw

# 활성화되지 않았으면
sudo systemctl enable openclaw

# 부팅 시 시작
sudo systemctl start openclaw
```

---

## 문제 해결

### 메모리 부족 (OOM)

```bash
# 메모리 확인
free -h

# 스왑 더 추가 (5단계 참조)
# 또는 Pi 에서 실행 중인 서비스를 줄이십시오
```

### 성능 느림

- SD 카드 대신 USB SSD 사용
- 사용하지 않는 서비스 비활성화: `sudo systemctl disable cups bluetooth avahi-daemon`
- CPU 스로틀링 확인: `vcgencmd get_throttled` (결과가 `0x0`이어야 함)

### 서비스가 시작되지 않음

```bash
# 로그 확인
journalctl -u openclaw --no-pager -n 100

# 일반적인 수정 방법: 재구축
cd ~/openclaw  # 해킹 가능한 설치 사용 시
npm run build
sudo systemctl restart openclaw
```

### ARM 바이너리 문제

스킬이 "exec format error" 메시지와 함께 실패할 경우:

1. 바이너리에 ARM64 빌드가 있는지 확인
2. 소스에서 빌드 시도
3. 또는 ARM 지원 Docker 컨테이너 사용

### WiFi 연결 끊김

헤드리스 Pi 와 WiFi 사용 시:

```bash
# WiFi 전원 관리 비활성화
sudo iwconfig wlan0 power off

# 영구화
echo 'wireless-power off' | sudo tee -a /etc/network/interfaces
```

---

## 비용 비교

| 설정           | 일회성 비용 | 월별 비용 | 메모                  |
| -------------- | ----------- | --------- | --------------------- |
| **Pi 4 (2GB)** | ~$45        | $0        | + 전력 (~$5/yr)       |
| **Pi 4 (4GB)** | ~$55        | $0        | 권장                  |
| **Pi 5 (4GB)** | ~$60        | $0        | 최고의 성능           |
| **Pi 5 (8GB)** | ~$80        | $0        | 오버킬이지만 미래대비 |
| DigitalOcean   | $0          | $6/mo     | $72/yr                |
| Hetzner        | $0          | €3.79/mo  | ~$50/yr               |

**손익 분기점:** Pi 는 클라우드 VPS 대비 약 6-12 개월 내에 비용을 상쇄합니다.

---

## 관련 링크

- [Linux 가이드](/platforms/linux) — 일반 Linux 설정
- [DigitalOcean 가이드](/platforms/digitalocean) — 클라우드 대안
- [Hetzner 가이드](/install/hetzner) — Docker 설정
- [Tailscale](/gateway/tailscale) — 원격 액세스
- [노드](/nodes) — Pi 게이트웨이와 노트북/폰 연결

```

```
