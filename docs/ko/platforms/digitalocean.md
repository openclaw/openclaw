---
read_when:
    - DigitalOcean에서 OpenClaw 설정
    - OpenClaw용 저렴한 VPS 호스팅을 찾고 있습니다.
summary: DigitalOcean의 OpenClaw(간단한 유료 VPS 옵션)
title: 디지털오션
x-i18n:
    generated_at: "2026-02-08T15:59:39Z"
    model: gtx
    provider: google-translate
    source_hash: bacdea3a44bc663d467b2ca4f8c3062407bf25c1600a9f9000436207e858f2f0
    source_path: platforms/digitalocean.md
    workflow: 15
---

# DigitalOcean의 OpenClaw

## 목표

DigitalOcean에서 지속적인 OpenClaw Gateway를 실행하세요. **$6/월** (또는 예약된 가격으로 $4/월).

월 $0 옵션을 원하고 ARM + 공급자별 설정에 신경 쓰지 않는다면 다음을 참조하세요. [오라클 클라우드 가이드](/platforms/oracle).

## 비용 비교(2026년)

| Provider     | Plan            | Specs                  | Price/mo    | Notes                                 |
| ------------ | --------------- | ---------------------- | ----------- | ------------------------------------- |
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0          | ARM, limited capacity / signup quirks |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | €3.79 (~$4) | Cheapest paid option                  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6          | Easy UI, good docs                    |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6          | Many locations                        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5          | Now part of Akamai                    |

**공급자 선택:**

- DigitalOcean: 가장 간단한 UX + 예측 가능한 설정(이 가이드)
- Hetzner: 좋은 가격/성능(참조 [헤츠너 가이드](/install/hetzner))
- Oracle Cloud: 월 $0일 수 있지만 더 까다롭고 ARM 전용입니다(참조 [오라클 가이드](/platforms/oracle))

---

## 전제조건

- DigitalOcean 계정([$200 무료 크레딧으로 가입](https://m.do.co/c/signup))
- SSH 키 쌍(또는 비밀번호 인증 사용 의지)
- ~20분

## 1) 물방울 만들기

1. 로그인 [디지털오션](https://cloud.digitalocean.com/)
2. 딸깍 하는 소리 **생성 → 물방울**
3. 선택하다:
   - **지역:** 귀하(또는 귀하의 사용자)에게 가장 가까운
   - **영상:** 우분투 24.04 LTS
   - **크기:** 기본 → 일반 → **$6/월** (vCPU 1개, 1GB RAM, 25GB SSD)
   - **입증:** SSH 키(권장) 또는 비밀번호
4. 딸깍 하는 소리 **물방울 만들기**
5. IP 주소를 기록해 두세요

## 2) SSH를 통해 연결

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) 오픈클로 설치

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

## 6) 대시보드에 접속

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

열려 있는: `https://<magicdns>/`

참고:

- Serve는 게이트웨이 루프백만 유지하고 Tailscale ID 헤더를 통해 인증합니다.
- 대신 토큰/비밀번호를 요구하려면 다음을 설정하세요. `gateway.auth.allowTailscale: false` 또는 사용 `gateway.auth.mode: "password"`.

**옵션 C: 테일넷 바인드(서브 없음)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

열려 있는: `http://<tailscale-ip>:18789` (토큰이 필요합니다).

## 7) 채널 연결

### 전보

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### 왓츠앱

```bash
openclaw channels login whatsapp
# Scan QR code
```

보다 [채널](/channels) 다른 공급자의 경우.

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
- 환경 `agents.defaults.model.primary` 더 작은 모델로

### 메모리 모니터링

```bash
free -h
htop
```

---

## 고집

모든 주 거주 지역:

- `~/.openclaw/` — 구성, 자격 증명, 세션 데이터
- `~/.openclaw/workspace/` — 작업 공간(SOUL.md, 메모리 등)

재부팅 후에도 유지됩니다. 정기적으로 백업하십시오.

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud 무료 대안

오라클 클라우드 제공 **항상 무료** 여기의 어떤 유료 옵션보다 훨씬 더 강력한 ARM 인스턴스를 월 $0에 이용할 수 있습니다.

| What you get      | Specs                  |
| ----------------- | ---------------------- |
| **4 OCPUs**       | ARM Ampere A1          |
| **24GB RAM**      | More than enough       |
| **200GB storage** | Block volume           |
| **Forever free**  | No credit card charges |

**주의사항:**

- 가입이 까다로울 수 있음(실패할 경우 다시 시도)
- ARM 아키텍처 — 대부분의 기능이 작동하지만 일부 바이너리에는 ARM 빌드가 필요합니다.

전체 설정 가이드를 보려면 다음을 참조하세요. [오라클 클라우드](/platforms/oracle). 등록 팁과 등록 프로세스 문제 해결을 보려면 다음을 참조하세요. [커뮤니티 가이드](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## 문제 해결

### 게이트웨이가 시작되지 않습니다

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### 이미 사용 중인 포트

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

## 참조

- [헤츠너 가이드](/install/hetzner) — 더 저렴하고 더 강력함
- [도커 설치](/install/docker) — 컨테이너화된 설정
- [테일스케일](/gateway/tailscale) — 안전한 원격 액세스
- [구성](/gateway/configuration) — 전체 구성 참조
