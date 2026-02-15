---
summary: "OpenClaw on DigitalOcean (simple paid VPS option)"
read_when:
  - Setting up OpenClaw on DigitalOcean
  - Looking for cheap VPS hosting for OpenClaw
title: "DigitalOcean"
x-i18n:
  source_hash: bacdea3a44bc663d467b2ca4f8c3062407bf25c1600a9f9000436207e858f2f0
---

# DigitalOcean의 OpenClaw

## 목표

**$6/월**(또는 예약 가격으로 $4/월)의 비용으로 DigitalOcean에서 영구 OpenClaw 게이트웨이를 실행하세요.

$0/월 옵션을 원하고 ARM + 공급자별 설정에 신경 쓰지 않는다면 [Oracle Cloud 가이드](/platforms/oracle)를 참조하세요.

## 비용 비교(2026년)

| 공급자          | 계획            | 사양                      | 가격/월     | 메모                       |
| --------------- | --------------- | ------------------------- | ----------- | -------------------------- |
| 오라클 클라우드 | 항상 무료 ARM   | 최대 4개의 OCPU, 24GB RAM | $0          | ARM, 제한된 용량/가입 문제 |
| 헤츠너          | CX22            | vCPU 2개, 4GB RAM         | €3.79 (~$4) | 가장 저렴한 유료 옵션      |
| 디지털오션      | 기본            | vCPU 1개, 1GB RAM         | $6          | 쉬운 UI, 좋은 문서         |
| 불터            | 클라우드 컴퓨팅 | vCPU 1개, 1GB RAM         | $6          | 많은 위치                  |
| 리노드          | 나노드          | vCPU 1개, 1GB RAM         | $5          | 이제 Akamai의 일부         |

**공급업체 선택:**

- DigitalOcean: 가장 간단한 UX + 예측 가능한 설정(본 가이드)
- 헤츠너: 좋은 가격/성능 ([헤츠너 가이드](/install/hetzner) 참조)
- Oracle Cloud: 월 $0일 수 있지만 더 까다롭고 ARM 전용입니다([Oracle 가이드](/platforms/oracle) 참조).

---

## 전제조건

- DigitalOcean 계정([$200 무료 크레딧으로 가입](https://m.do.co/c/signup))
- SSH 키 쌍(또는 비밀번호 인증 사용 의지)
- ~20분

## 1) 물방울 만들기

1. [DigitalOcean](https://cloud.digitalocean.com/)에 로그인합니다.
2. **만들기 → 드롭릿**을 클릭합니다.
3. 선택:
   - **지역:** 귀하(또는 귀하의 사용자)와 가장 가까운 지역
   - **이미지:** 우분투 24.04 LTS
   - **크기:** 기본 → 일반 → **$6/월** (1 vCPU, 1GB RAM, 25GB SSD)
   - **인증:** SSH 키(권장) 또는 비밀번호
4. **액적 생성**을 클릭합니다.
5. IP 주소를 기록해 두세요

## 2) SSH를 통해 연결

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) OpenClaw 설치

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4) 온보딩 실행

```bash
openclaw onboard --install-daemon
```

마법사가 다음 단계를 안내합니다.

- 모델 인증(API 키 또는 OAuth)
- 채널 설정(Telegram, WhatsApp, Discord 등)
- 게이트웨이 토큰(자동 생성)
- 데몬 설치(systemd)

## 5) 게이트웨이 확인

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6) 대시보드에 액세스

게이트웨이는 기본적으로 루프백에 바인딩됩니다. 제어 UI에 액세스하려면:

**옵션 A: SSH 터널(권장)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**옵션 B: Tailscale Serve(HTTPS, 루프백 전용)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

열기: `https://<magicdns>/`

참고:

- Serve는 게이트웨이 루프백만 유지하고 Tailscale ID 헤더를 통해 인증합니다.
- 대신 토큰/비밀번호를 요구하려면 `gateway.auth.allowTailscale: false`을 설정하거나 `gateway.auth.mode: "password"`를 사용하세요.

**옵션 C: 테일넷 바인딩(서브 없음)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

열기: `http://<tailscale-ip>:18789` (토큰 필요).

## 7) 채널 연결

### 텔레그램

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### 왓츠앱

```bash
openclaw channels login whatsapp
# Scan QR code
```

다른 제공업체는 [채널](/channels)을 참조하세요.

---

## 1GB RAM에 대한 최적화

6달러짜리 드롭릿에는 1GB RAM만 있습니다. 원활하게 진행하려면 다음을 수행하세요.

### 스왑 추가(권장)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 더 가벼운 모델을 사용하세요

OOM이 발생하는 경우 다음을 고려하세요.

- 로컬 모델 대신 API 기반 모델(Claude, GPT) 사용
- `agents.defaults.model.primary`를 더 작은 모델로 설정

### 모니터 메모리

```bash
free -h
htop
```

---

## 지속성

모든 주 거주 지역:

- `~/.openclaw/` — 구성, 자격 증명, 세션 데이터
- `~/.openclaw/workspace/` — 작업 공간 (SOUL.md, 메모리 등)

재부팅 후에도 유지됩니다. 정기적으로 백업하십시오.

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 오라클 클라우드 무료 대안

Oracle Cloud는 여기의 어떤 유료 옵션보다 훨씬 더 강력한 **항상 무료** ARM 인스턴스를 월 $0의 비용으로 제공합니다.

| 당신이 얻는 것     | 사양                 |
| ------------------ | -------------------- |
| **OCPU 4개**       | ARM 암페어 A1        |
| **24GB RAM**       | 충분하다             |
| **200GB 스토리지** | 블록 볼륨            |
| **영원히 무료**    | 신용카드 수수료 없음 |

**주의사항:**

- 가입이 까다로울 수 있음(실패할 경우 다시 시도)
- ARM 아키텍처 — 대부분의 기능이 작동하지만 일부 바이너리에는 ARM 빌드가 필요합니다.

전체 설정 가이드는 [Oracle Cloud](/platforms/oracle)를 참조하세요. 가입 팁과 등록 절차 문제 해결은 이 [커뮤니티 가이드](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)를 참조하세요.

---

## 문제 해결

### 게이트웨이가 시작되지 않습니다

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### 포트가 이미 사용 중입니다.

```bash
lsof -i :18789
kill <PID>
```

### 메모리 부족

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## 참고 항목

- [헤츠너 가이드](/install/hetzner) — 더 저렴하고 더 강력함
- [Docker install](/install/docker) — 컨테이너화된 설정
- [Tailscale](/gateway/tailscale) — 보안 원격 액세스
- [구성](/gateway/configuration) — 전체 구성 참조
