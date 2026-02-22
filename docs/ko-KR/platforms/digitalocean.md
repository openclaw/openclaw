````markdown
---
summary: "OpenClaw DigitalOcean (간단한 유료 VPS 옵션)"
read_when:
  - DigitalOcean 에서 OpenClaw 설정하기
  - OpenClaw 를 위한 저렴한 VPS 호스팅 찾기
title: "DigitalOcean"
---

# DigitalOcean 에서 OpenClaw 설정하기

## 목표

매월 **$6** (예약 가격으로 $4/월)로 DigitalOcean 에서 지속적인 OpenClaw 게이트웨이를 실행합니다.

월 $0 옵션이 필요하고 ARM + 프로바이더별 설정이 괜찮으신 경우, [Oracle Cloud 가이드](/platforms/oracle)를 참조하세요.

## 비용 비교 (2026)

| 프로바이더   | 플랜            | 사양                  | 월 가격     | 비고                         |
| ------------ | --------------- | --------------------- | ----------- | ---------------------------- |
| Oracle Cloud | Always Free ARM | 최대 4 OCPU, 24GB RAM | $0          | ARM, 제한된 용량 / 가입 특징 |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM       | €3.79 (~$4) | 가장 저렴한 유료 옵션        |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM       | $6          | 쉬운 UI, 좋은 문서           |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM       | $6          | 많은 지역 제공               |
| Linode       | Nanode          | 1 vCPU, 1GB RAM       | $5          | 이제 Akamai 의 일부          |

**프로바이더 선택:**

- DigitalOcean: 가장 간단한 UX + 예측 가능한 설정 (이 가이드)
- Hetzner: 좋은 가격/성능 (참조: [Hetzner 가이드](/install/hetzner))
- Oracle Cloud: 월 $0 가능하지만, 세부적이며 ARM 전용 (참조: [Oracle 가이드](/platforms/oracle))

---

## 필요 조건

- DigitalOcean 계정 ([가입하고 $200 무료 크레딧 받기](https://m.do.co/c/signup))
- SSH 키 쌍 (또는 비밀번호 인증을 사용할 의향)
- 약 20분

## 1) Droplet 생성

<Warning>
깨끗한 기본 이미지(Ubuntu 24.04 LTS)를 사용하세요. 타사 마켓플레이스 1-클릭 이미지는 시작 스크립트와 방화벽 기본값을 검토하지 않는 한 피하세요.
</Warning>

1. [DigitalOcean](https://cloud.digitalocean.com/) 로그인
2. **Create → Droplets** 클릭
3. 선택 사항:
   - **지역:** 가장 가까운 곳 (또는 사용자가 있는 지역)
   - **이미지:** Ubuntu 24.04 LTS
   - **크기:** Basic → Regular → **$6/월** (1 vCPU, 1GB RAM, 25GB SSD)
   - **인증:** SSH 키 (권장) 또는 비밀번호
4. **Create Droplet** 클릭
5. IP 주소 기록

## 2) SSH 를 통한 연결

```bash
ssh root@YOUR_DROPLET_IP
```
````

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

마법사에서는 다음을 안내합니다:

- 모델 인증 (API 키 또는 OAuth)
- 채널 설정 (Telegram, WhatsApp, Discord 등)
- 게이트웨이 토큰 (자동 생성)
- 데몬 설치 (systemd)

## 5) 게이트웨이 확인

```bash
# 상태 확인
openclaw status

# 서비스 확인
systemctl --user status openclaw-gateway.service

# 로그 보기
journalctl --user -u openclaw-gateway.service -f
```

## 6) 대시보드에 접근

게이트웨이는 기본적으로 로컬 루프백에 바인딩됩니다. 제어 UI 에 접근하려면:

**옵션 A: SSH 터널 (권장)**

```bash
# 로컬 머신에서 실행
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# 그런 다음 열기: http://localhost:18789
```

**옵션 B: Tailscale Serve (HTTPS, 로컬 루프백 전용)**

```bash
# 드롭렛에서 실행
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# 게이트웨이를 Tailscale Serve 로 설정
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

열기: `https://<magicdns>/`

비고:

- Serve는 게이트웨이를 로컬 루프백 전용으로 유지하고 Tailscale ID 헤더를 통해 Control UI/WebSocket 트래픽을 인증합니다 (토큰 없는 인증은 신뢰할 수 있는 게이트웨이 호스트를 가정; HTTP API는 여전히 토큰/비밀번호 필요).
- 토큰/비밀번호를 요구하려면 `gateway.auth.allowTailscale: false` 를 설정하거나 `gateway.auth.mode: "password"` 를 사용하세요.

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

다른 프로바이더에 대한 정보는 [채널](/channels)을 참조하세요.

---

## 1GB RAM 최적화

$6 드롭릿은 1GB RAM 만 제공합니다. 원활한 실행을 위해:

### 스왑 추가 (권장)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 가벼운 모델 사용

OOM 문제가 발생하면 고려해볼 사항:

- 로컬 모델 대신 API 기반 모델 (Claude, GPT) 사용
- `agents.defaults.model.primary` 를 더 작은 모델로 설정

### 메모리 모니터링

```bash
free -h
htop
```

---

## 지속성

모든 상태는 다음에 저장됩니다:

- `~/.openclaw/` — 설정, 자격 증명, 세션 데이터
- `~/.openclaw/workspace/` — 워크스페이스 (SOUL.md, 메모리 등)

이들은 재부팅 후에도 유지됩니다. 주기적으로 백업하세요:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud 무료 대안

Oracle Cloud 는 **Always Free** ARM 인스턴스를 제공하며, 여기의 어떤 유료 옵션보다도 강력합니다 — 월 $0.

| 제공 내용        | 사양               |
| ---------------- | ------------------ |
| **4 OCPUs**      | ARM Ampere A1      |
| **24GB RAM**     | 충분히 여유 있음   |
| **200GB 저장소** | 블록 볼륨          |
| **영구 무료**    | 신용카드 요금 없음 |

**주의 사항:**

- 가입이 까다로울 수 있음 (실패 시 재시도하세요)
- ARM 아키텍처 — 대부분 작동하지만 일부 바이너리는 ARM 빌드 필요

전체 설정 가이드는 [Oracle Cloud](/platforms/oracle)를 참조하세요. 가입 팁 및 등록 과정의 문제 해결은 이 [커뮤니티 가이드](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)를 참조하세요.

---

## 문제 해결

### 게이트웨이가 시작되지 않음

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### 포트 이미 사용 중

```bash
lsof -i :18789
kill <PID>
```

### 메모리 부족

```bash
# 메모리 확인
free -h

# 스왑 더 추가
# 또는 $12/월 드롭릿 (2GB RAM) 로 업그레이드
```

---

## 또 다른 참고사항

- [Hetzner 가이드](/install/hetzner) — 더 저렴하고 강력함
- [Docker 설치](/install/docker) — 컨테이너화된 설정
- [Tailscale](/gateway/tailscale) — 안전한 원격 접근
- [설정](/gateway/configuration) — 전체 설정 참조

```

```
