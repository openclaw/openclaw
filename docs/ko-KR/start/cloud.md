---
summary: "VPS 및 클라우드 배포 가이드"
read_when:
  - 클라우드에 배포할 때
title: "클라우드 배포"
---

# 클라우드 배포

VPS 및 클라우드 환경에서 OpenClaw를 배포하는 가이드입니다.

## 요구사항

| 항목   | 최소         | 권장          |
| ------ | ------------ | ------------- |
| RAM    | 1GB          | 2GB+          |
| CPU    | 1 vCPU       | 2 vCPU+       |
| 저장소 | 10GB         | 20GB+         |
| OS     | Ubuntu 22.04 | Ubuntu 22.04+ |

## 빠른 배포

### 원클릭

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
```

## DigitalOcean

### Droplet 생성

1. Ubuntu 22.04 선택
2. Basic Plan (1GB RAM 이상)
3. SSH 키 추가

### 설치

```bash
# Node.js 설치
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# OpenClaw 설치
npm install -g openclaw
openclaw onboard --install-daemon
```

## AWS EC2

### 인스턴스

- AMI: Ubuntu 22.04
- 타입: t3.small 이상
- 스토리지: 20GB gp3

### 보안 그룹

| 포트  | 용도                               |
| ----- | ---------------------------------- |
| 22    | SSH                                |
| 18789 | Gateway (Tailscale 사용 시 불필요) |

### 설치

```bash
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g openclaw
```

## Oracle Cloud

### 무료 티어

Oracle Cloud 무료 티어로 운영 가능:

- ARM 인스턴스 (4 OCPU, 24GB RAM)
- 상시 무료

### 설치

```bash
# ARM용 Node.js
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g openclaw
```

## 원격 접근

### Tailscale (권장)

```bash
# Tailscale 설치
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# OpenClaw 설정
openclaw config set gateway.bind loopback
openclaw config set gateway.tailscale.mode serve
```

### 리버스 프록시 (Nginx)

```nginx
server {
    listen 443 ssl;
    server_name openclaw.example.com;

    ssl_certificate /etc/letsencrypt/live/openclaw.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/openclaw.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

## 보안

### 필수 설정

```json5
{
  gateway: {
    bind: "loopback", // 로컬만 바인딩
    auth: {
      mode: "password",
      password: "strong_random_password",
    },
  },
}
```

### 방화벽

```bash
# UFW 설정
sudo ufw allow ssh
sudo ufw enable
# 18789는 Tailscale/Nginx 사용 시 열지 않음
```

## 모니터링

### 시스템 리소스

```bash
# htop 설치
sudo apt install htop

# 모니터링
htop
```

### OpenClaw 상태

```bash
openclaw gateway status
openclaw doctor
```

## 자동 시작

### systemd

```bash
openclaw onboard --install-daemon
sudo systemctl enable openclaw
sudo systemctl start openclaw
```

### 상태 확인

```bash
sudo systemctl status openclaw
journalctl -u openclaw -f
```

## 백업

```bash
# 자동 백업 설정
0 0 * * * /usr/bin/openclaw backup create --output /backup/openclaw-$(date +\%Y\%m\%d).tar.gz
```

## 문제 해결

### 메모리 부족

1. 스왑 추가:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

2. 히스토리 제한 설정

### 연결 안 됨

1. Tailscale 상태 확인
2. 방화벽 규칙 확인
3. Gateway 상태 확인
