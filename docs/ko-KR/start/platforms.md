---
summary: "Linux, macOS, Windows, Docker 플랫폼별 설치 가이드"
read_when:
  - 특정 플랫폼에서 설치할 때
title: "플랫폼별 설치"
---

# 플랫폼별 설치

## 요구사항 (모든 플랫폼)

| 항목              | 요구사항             |
| ----------------- | -------------------- |
| **Node.js**       | v22.12.0 이상        |
| **패키지 매니저** | npm 또는 pnpm (권장) |

Node.js 버전 확인:

```bash
node --version
# v22.12.0 이상
```

---

## macOS

### Homebrew 사용 (권장)

```bash
# Homebrew로 Node.js 설치
brew install node@22

# OpenClaw 설치
npm install -g openclaw

# 설정 마법사 실행
openclaw onboard
```

### 수동 설치

```bash
# Node.js 공식 사이트에서 설치
# https://nodejs.org

# OpenClaw 설치
npm install -g openclaw
```

### macOS 특정 기능

- **iMessage 통합**: BlueBubbles 또는 네이티브 연동
- **시스템 서비스**: launchd로 자동 시작

```bash
# 서비스로 설치
openclaw onboard --install-daemon
```

---

## Linux

### Debian/Ubuntu

```bash
# Node.js 22 설치
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# OpenClaw 설치
npm install -g openclaw

# 브라우저 의존성 (선택사항)
sudo apt install libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2
```

### Fedora/RHEL

```bash
# Node.js 22 설치
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs

# OpenClaw 설치
npm install -g openclaw
```

### Arch Linux

```bash
# Node.js 설치
sudo pacman -S nodejs npm

# OpenClaw 설치
npm install -g openclaw
```

### 시스템 서비스 (systemd)

```bash
# 서비스로 설치
openclaw onboard --install-daemon

# 또는 수동 설정
sudo tee /etc/systemd/system/openclaw.service << EOF
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=$USER
ExecStart=/usr/bin/openclaw gateway
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable openclaw
sudo systemctl start openclaw
```

---

## Windows

### 권장 방법: WSL2

WSL2(Windows Subsystem for Linux)를 사용하면 Linux 환경에서 실행할 수 있습니다.

```powershell
# WSL 설치
wsl --install

# WSL 열기
wsl

# 이후 Linux 설치 가이드 따르기
```

### 네이티브 Windows

```powershell
# Node.js 공식 사이트에서 설치
# https://nodejs.org

# 또는 winget 사용
winget install OpenJS.NodeJS.LTS

# OpenClaw 설치
npm install -g openclaw

# 설정 마법사
openclaw onboard
```

### Windows 서비스

```powershell
# NSSM 사용하여 서비스 등록
nssm install OpenClaw "C:\Program Files\nodejs\node.exe" "C:\...\openclaw" "gateway"
nssm start OpenClaw
```

---

## Docker

### Docker Compose (권장)

```yaml
# docker-compose.yml
version: "3.8"
services:
  openclaw:
    image: openclaw/openclaw:latest
    ports:
      - "18789:18789"
    volumes:
      - ./config:/root/.openclaw
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Docker 실행

```bash
# 이미지 가져오기
docker pull openclaw/openclaw:latest

# 컨테이너 실행
docker run -d \
  --name openclaw \
  -p 18789:18789 \
  -v ~/.openclaw:/root/.openclaw \
  openclaw/openclaw:latest
```

### Docker 환경변수

```bash
docker run -d \
  --name openclaw \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e TELEGRAM_BOT_TOKEN=123:abc \
  -p 18789:18789 \
  openclaw/openclaw:latest
```

---

## VPS/클라우드

### 최소 요구사항

| 항목     | 사양            |
| -------- | --------------- |
| RAM      | 1GB+            |
| CPU      | 1 코어+         |
| 저장소   | 10GB+           |
| 네트워크 | 안정적인 인터넷 |

### 권장 보안 설정

```json5
{
  gateway: {
    bind: "loopback", // Tailscale/Nginx 프록시 사용
    auth: {
      mode: "password",
      password: "strong_password",
    },
  },
}
```

### Tailscale 사용

```json5
{
  gateway: {
    tailscale: {
      mode: "serve", // 또는 funnel
    },
  },
}
```

---

## 업그레이드

```bash
# 최신 버전으로 업그레이드
openclaw update

# 특정 채널
openclaw update --channel stable  # stable | beta | dev
```

## 삭제

```bash
# 글로벌 패키지 삭제
npm uninstall -g openclaw

# 설정 파일 삭제 (선택사항)
rm -rf ~/.openclaw
```
