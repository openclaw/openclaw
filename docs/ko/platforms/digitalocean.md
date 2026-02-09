---
summary: "DigitalOcean 에서의 OpenClaw (간단한 유료 VPS 옵션)"
read_when:
  - DigitalOcean 에서 OpenClaw 설정 중
  - OpenClaw 를 위한 저렴한 VPS 호스팅을 찾는 경우
title: "DigitalOcean"
---

# DigitalOcean 에서 OpenClaw

## 목표

DigitalOcean 에서 **월 $6** (또는 예약 요금제로 월 $4)로 영구적인 OpenClaw Gateway(게이트웨이) 를 실행합니다.

월 $0 옵션을 원하고 ARM + 프로바이더별 설정을 감수할 수 있다면 [Oracle Cloud 가이드](/platforms/oracle)를 참고하십시오.

## 비용 비교 (2026)

| 프로바이더        | 플랜              | 사양                  | 21. 월별 가격                               | 참고 자료                   |
| ------------ | --------------- | ------------------- | -------------------------------------------------------------- | ----------------------- |
| Oracle Cloud | Always Free ARM | 최대 4 OCPU, 24GB RAM | $0                                                             | ARM, 제한된 용량 / 가입 시 까다로움 |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM     | €3.79 (~$4) | 가장 저렴한 유료 옵션            |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM     | $6                                                             | 쉬운 UI, 좋은 문서            |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM     | $6                                                             | 다양한 지역                  |
| Linode       | Nanode          | 1 vCPU, 1GB RAM     | $5                                                             | 현재 Akamai 의 일부          |

**프로바이더 선택:**

- DigitalOcean: 가장 단순한 UX + 예측 가능한 설정 (이 가이드)
- Hetzner: 가격 대비 성능 우수 ([Hetzner 가이드](/install/hetzner) 참고)
- Oracle Cloud: 월 $0 가능하지만 더 까다롭고 ARM 전용 ([Oracle 가이드](/platforms/oracle) 참고)

---

## 사전 준비 사항

- DigitalOcean 계정 ([$200 무료 크레딧으로 가입](https://m.do.co/c/signup))
- SSH 키 페어 (또는 비밀번호 인증 사용 가능)
- 약 20 분

## 1. Droplet 생성

1. [DigitalOcean](https://cloud.digitalocean.com/) 에 로그인합니다.
2. **Create → Droplets** 를 클릭합니다.
3. 다음을 선택합니다:
   - **Region:** 사용자(또는 사용자들)와 가장 가까운 지역
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH 키 (권장) 또는 비밀번호
4. **Create Droplet** 을 클릭합니다.
5. IP 주소를 기록합니다.

## 2) SSH 로 연결

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. OpenClaw 설치

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

## 4. 온보딩 실행

```bash
openclaw onboard --install-daemon
```

마법사는 다음 과정을 안내합니다:

- 모델 인증 (API 키 또는 OAuth)
- 채널 설정 (Telegram, WhatsApp, Discord 등)
- Gateway 토큰 (자동 생성)
- 데몬 설치 (systemd)

## 5. Gateway 확인

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. 대시보드 접근

Gateway 는 기본적으로 loopback 에 바인딩됩니다. Control UI 에 접근하려면 다음 중 하나를 사용하십시오:

**옵션 A: SSH 터널 (권장)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**옵션 B: Tailscale Serve (HTTPS, loopback 전용)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

열기: `https://<magicdns>/`

참고 사항:

- Serve 는 Gateway 를 loopback 전용으로 유지하며 Tailscale 아이덴티티 헤더로 인증합니다.
- 대신 토큰/비밀번호를 요구하려면 `gateway.auth.allowTailscale: false` 을 설정하거나 `gateway.auth.mode: "password"` 을 사용하십시오.

**옵션 C: Tailnet 바인드 (Serve 미사용)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

열기: `http://<tailscale-ip>:18789` (토큰 필요).

## 7. 채널 연결

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

다른 프로바이더는 [Channels](/channels) 를 참고하십시오.

---

## 1GB RAM 최적화

$6 Droplet 은 1GB RAM 만 제공합니다. 원활한 동작을 위해 다음을 권장합니다:

### 스왑 추가 (권장)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 더 가벼운 모델 사용

OOM 이 발생한다면 다음을 고려하십시오:

- 로컬 모델 대신 API 기반 모델 (Claude, GPT) 사용
- `agents.defaults.model.primary` 를 더 작은 모델로 설정

### 메모리 모니터링

```bash
free -h
htop
```

---

## 지속성

22. 모든 상태는 다음에 저장됩니다:

- `~/.openclaw/` — 설정, 자격 증명, 세션 데이터
- `~/.openclaw/workspace/` — 워크스페이스 (SOUL.md, 메모리 등)

이 데이터는 재부팅 후에도 유지됩니다. 정기적으로 백업하십시오:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud 무료 대안

Oracle Cloud 는 여기의 어떤 유료 옵션보다도 훨씬 강력한 **Always Free** ARM 인스턴스를 월 $0 로 제공합니다.

| 23. 제공되는 내용 | 사양            |
| ---------------------------------- | ------------- |
| **4 OCPU**                         | ARM Ampere A1 |
| **24GB RAM**                       | 충분히 여유로움      |
| **200GB 스토리지**                     | 블록 볼륨         |
| **영구 무료**                          | 신용카드 요금 없음    |

**주의 사항:**

- 가입 과정이 까다로울 수 있습니다 (실패 시 재시도)
- ARM 아키텍처 — 대부분 동작하지만 일부 바이너리는 ARM 빌드가 필요합니다

전체 설정 가이드는 [Oracle Cloud](/platforms/oracle) 를 참고하십시오. 가입 팁과 등록 과정 문제 해결은 이 [커뮤니티 가이드](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)를 참고하십시오.

---

## 문제 해결

### Gateway 가 시작되지 않음

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### 포트가 이미 사용 중임

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

## 24. 함께 보기

- [Hetzner 가이드](/install/hetzner) — 더 저렴하고 더 강력함
- [Docker 설치](/install/docker) — 컨테이너 기반 설정
- [Tailscale](/gateway/tailscale) — 안전한 원격 접근
- [구성](/gateway/configuration) — 전체 설정 레퍼런스
