---
summary: "Raspberry Pi 설치 가이드"
read_when:
  - Raspberry Pi에서 실행할 때
title: "Raspberry Pi"
---

# Raspberry Pi

Raspberry Pi에서 OpenClaw를 실행하는 가이드입니다.

## 요구사항

| 항목   | 최소                   | 권장                   |
| ------ | ---------------------- | ---------------------- |
| 모델   | Pi 4                   | Pi 4/5                 |
| RAM    | 2GB                    | 4GB+                   |
| 저장소 | 16GB                   | 32GB+                  |
| OS     | Raspberry Pi OS 64-bit | Raspberry Pi OS 64-bit |

## 설치

### 1. Node.js 설치

```bash
# Node.js 22 설치
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. OpenClaw 설치

```bash
npm install -g openclaw
```

### 3. 온보딩

```bash
openclaw onboard
```

## 서비스 설정

### systemd 서비스

```bash
# 서비스로 설치
openclaw onboard --install-daemon
```

### 수동 설정

```bash
sudo tee /etc/systemd/system/openclaw.service << EOF
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=pi
ExecStart=/usr/bin/openclaw gateway
Restart=on-failure
WorkingDirectory=/home/pi

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable openclaw
sudo systemctl start openclaw
```

## 최적화

### 메모리 최적화

```json5
{
  agents: {
    defaults: {
      historyLimit: 25,
      compaction: {
        auto: true,
        threshold: 50000,
      },
    },
  },
}
```

### 스왑 설정

```bash
# 스왑 확대 (2GB)
sudo dphys-swapfile swapoff
sudo sed -i 's/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

## 브라우저 설정

Pi에서 브라우저 도구 사용:

### Chromium 설치

```bash
sudo apt install chromium-browser
```

### 설정

```json5
{
  browser: {
    enabled: true,
    headless: true,
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-gpu"],
  },
}
```

## 네트워크

### 로컬 접근

```
http://<pi-ip>:18789
```

### Tailscale (권장)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

```json5
{
  gateway: {
    tailscale: {
      mode: "serve",
    },
  },
}
```

## 성능 팁

1. **64-bit OS 사용**: 32-bit보다 성능 향상
2. **USB SSD 사용**: SD 카드보다 빠름
3. **오버클럭**: 선택사항, 발열 관리 필요
4. **불필요한 서비스 비활성화**

## 모니터링

### 온도 확인

```bash
vcgencmd measure_temp
```

### 리소스 모니터링

```bash
htop
```

## 문제 해결

### 메모리 부족

1. 히스토리 제한 줄이기
2. 스왑 확대
3. 불필요한 프로세스 종료

### 느린 응답

1. 가벼운 모델 사용
2. 사고 레벨 낮추기
3. 브라우저 비활성화 고려

### 과열

1. 방열판 확인
2. 팬 설치
3. 오버클럭 해제
