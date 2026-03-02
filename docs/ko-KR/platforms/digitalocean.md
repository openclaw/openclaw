---
summary: "OpenClaw on DigitalOcean (간단한 유료 VPS 옵션)"
read_when:
  - DigitalOcean 에 OpenClaw 를 설정할 때
  - OpenClaw 용 저렴한 VPS 호스팅을 찾을 때
title: "DigitalOcean"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: platforms/digitalocean.md
  workflow: 15
---

# DigitalOcean 의 OpenClaw

## 목표

DigitalOcean 에서 지속적인 OpenClaw Gateway 를 **월 $6** (또는 예약 가격 $4/개월) 로 실행합니다.

$0/개월 옵션을 원하고 ARM + 공급자 특정 설정을 신경 쓰지 않으면 [Oracle Cloud 가이드](/ko-KR/platforms/oracle) 를 참조하세요.

## 비용 비교 (2026)

| 공급자       | 계획            | 사양                  | 가격/개월   | 참고                         |
| ------------ | --------------- | --------------------- | ----------- | ---------------------------- |
| Oracle Cloud | Always Free ARM | 최대 4 OCPU, 24GB RAM | $0          | ARM, 제한된 용량 / 가입 문제 |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM       | €3.79 (~$4) | 가장 저렴한 유료 옵션        |
| DigitalOcean | 기본            | 1 vCPU, 1GB RAM       | $6          | 쉬운 UI, 좋은 문서           |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM       | $6          | 많은 위치                    |
| Linode       | Nanode          | 1 vCPU, 1GB RAM       | $5          | 현재 Akamai 의 일부          |

**공급자 선택:**

- DigitalOcean: 가장 간단한 UX + 예측 가능한 설정 (이 가이드)
- Hetzner: 좋은 가격/성능 ([Hetzner 가이드](/install/hetzner) 참조)
- Oracle Cloud: 월 $0/개월 가능하지만 더 까다롭고 ARM 전용 ([Oracle 가이드](/ko-KR/platforms/oracle) 참조)

---

## 사전 조건

- DigitalOcean 계정 ([$200 무료 크레딧으로 가입](https://m.do.co/c/signup))
- SSH 키 쌍 (또는 암호 인증 사용 의지)
- ~20 분

## 1) Droplet 만들기

<Warning>
깨끗한 기본 이미지 (Ubuntu 24.04 LTS) 를 사용합니다. 시작 스크립트 및 방화벽 기본값을 검토하지 않으면 제3 자 Marketplace 1 클릭 이미지를 피합니다.
</Warning>

1. [DigitalOcean](https://cloud.digitalocean.com/) 로 로그인합니다.
2. **Create → Droplets** 클릭
3. 선택:
   - **Region:** 가장 가까운 (또는 사용자)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/개월** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH 키 (권장) 또는 암호
4. **Create Droplet** 클릭
5. IP 주소 참고

## 2) SSH 를 통해 연결

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) OpenClaw 설치

```bash
# 시스템 업데이트
apt update && apt upgrade -y

# Node.js 22 설치
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# OpenClaw 설치
curl -fsSL https://openclaw.ai/install.sh | bash

# 확인
openclaw --version
```

## 4) 온보딩 실행

```bash
openclaw onboard --install-daemon
```

마법사는 다음을 안내합니다:

- 모델 인증 (API 키 또는 OAuth)
- 채널 설정 (Telegram, WhatsApp, Discord 등)
- Gateway 토큰 (자동 생성)
- 데몬 설치 (systemd)

## 5) Gateway 확인

```bash
# 상태 확인
openclaw status

# 서비스 확인
systemctl --user status openclaw-gateway.service

# 로그 보기
journalctl --user -u openclaw-gateway.service -f
```

## 6) 대시보드 액세스

Gateway 는 기본적으로 로컬호스트에 바인드합니다. Control UI 에 액세스하려면:

**옵션 A: SSH 터널 (권장)**

```bash
# 로컬 머신에서
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# 그러면 열기: http://localhost:18789
```

**옵션 B: Tailscale Serve (HTTPS, 로컬호스트 전용)**

```bash
# Droplet 에서
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Gateway 를 Tailscale Serve 사용하도록 구성
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

열기: `https://<magicdns>/`

참고:

- Serve 는 Gateway 를 로컬호스트 전용으로 유지하고 Control UI/WebSocket 트래픽을 Tailscale 아이덴티티 헤더를 통해 인증합니다 (토큰 없는 인증은 신뢰할 수 있는 Gateway 호스트를 가정; HTTP API 는 여전히 토큰/암호 필요).
- 대신 토큰/암호 를 요구하려면 `gateway.auth.allowTailscale: false` 를 설정하거나 `gateway.auth.mode: "password"` 사용.

**옵션 C: Tailnet 바인드 (Serve 없음)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

열기: `http://<tailscale-ip>:18789` (토큰 필요).

## 7) 채널 연결

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# QR 코드 스캔
```

다른 공급자는 [채널](/ko-KR/channels) 참조.

---

## 1GB RAM 에 대한 최적화

$6 Droplet 은 1GB RAM 만 있습니다. 부드럽게 실행하려면:

### 스왑 추가 (권장)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 더 가벼운 모델 사용

OOM 에 도달하면 다음을 고려합니다:

- 로컬 모델 대신 API 기반 모델 (Claude, GPT) 사용
- `agents.defaults.model.primary` 를 더 작은 모델로 설정

### 메모리 모니터링

```bash
free -h
htop
```

---

## Oracle Cloud 무료 대체

Oracle Cloud 는 **Always Free** ARM 인스턴스를 제공합니다 — 월 $0 로 여기의 모든 유료 옵션보다 훨씬 더 강력합니다.

관련 문서: [Gateway 실행 가이드](/ko-KR/gateway), [구성](/ko-KR/gateway/configuration), [Tailscale](/ko-KR/gateway/tailscale).
