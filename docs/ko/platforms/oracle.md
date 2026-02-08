---
read_when:
    - Oracle Cloud에서 OpenClaw 설정
    - OpenClaw를 위한 저렴한 VPS 호스팅을 찾고 있습니다.
    - 소규모 서버에서 연중무휴 OpenClaw를 원함
summary: Oracle Cloud의 OpenClaw(항상 무료 ARM)
title: 오라클 클라우드
x-i18n:
    generated_at: "2026-02-08T16:05:56Z"
    model: gtx
    provider: google-translate
    source_hash: 8ec927ab5055c915fda464458f85bfb96151967c3b7cd1b1fd2b2f156110fc6d
    source_path: platforms/oracle.md
    workflow: 15
---

# Oracle Cloud(OCI)의 OpenClaw

## 목표

Oracle Cloud에서 영구 OpenClaw 게이트웨이 실행 **항상 무료** ARM 계층.

Oracle의 무료 계층은 OpenClaw에 매우 적합할 수 있지만(특히 이미 OCI 계정이 있는 경우) 다음과 같은 단점이 있습니다.

- ARM 아키텍처(대부분의 경우 작동하지만 일부 바이너리는 x86 전용일 수 있음)
- 용량과 가입이 까다로울 수 있습니다.

## 비용 비교(2026년)

| Provider     | Plan            | Specs                  | Price/mo | Notes                 |
| ------------ | --------------- | ---------------------- | -------- | --------------------- |
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0       | ARM, limited capacity |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | ~ $4     | Cheapest paid option  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6       | Easy UI, good docs    |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6       | Many locations        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5       | Now part of Akamai    |

---

## 전제조건

- 오라클 클라우드 계정([가입](https://www.oracle.com/cloud/free/)) - 보다 [커뮤니티 가입 가이드](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) 문제가 발생하면
- Tailscale 계정(무료 [tailscale.com](https://tailscale.com))
- ~30분

## 1) OCI 인스턴스 생성

1. 로그인 [오라클 클라우드 콘솔](https://cloud.oracle.com/)
2. 다음으로 이동 **컴퓨팅 → 인스턴스 → 인스턴스 생성**
3. 구성:
   - **이름:** `openclaw`
   - **영상:** 우분투 24.04(aarch64)
   - **모양:** `VM.Standard.A1.Flex` (암페어 ARM)
   - **OCPU:** 2개(또는 최대 4개)
   - **메모리:** 12GB(또는 최대 24GB)
   - **부팅 볼륨:** 50GB(최대 200GB 무료)
   - **SSH 키:** 공개 키 추가
4. 딸깍 하는 소리 **만들다**
5. 공용 IP 주소를 기록해 두세요

**팁:** "용량 부족"으로 인해 인스턴스 생성이 실패하는 경우 다른 가용성 도메인을 시도하거나 나중에 다시 시도하세요. 프리 티어 용량은 제한되어 있습니다.

## 2) 연결 및 업데이트

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**메모:** `build-essential` 일부 종속성의 ARM 컴파일에는 필요합니다.

## 3) 사용자 및 호스트 이름 구성

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4) 테일스케일 설치

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

이렇게 하면 Tailscale SSH가 활성화되므로 다음을 통해 연결할 수 있습니다. `ssh openclaw` tailnet의 모든 장치에서 — 공용 IP가 필요하지 않습니다.

확인하다:

```bash
tailscale status
```

**이제부터 Tailscale을 통해 연결하세요.** `ssh ubuntu@openclaw` (또는 Tailscale IP를 사용하십시오).

## 5) 오픈클로 설치

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

"봇을 어떻게 부화하시겠습니까?"라는 메시지가 표시되면 다음을 선택하세요. **"이건 나중에 해주세요"**.

> 참고: ARM 네이티브 빌드 문제가 발생하는 경우 시스템 패키지(예: `sudo apt install -y build-essential`) Homebrew에 도달하기 전에.

## 6) 게이트웨이(루프백 + 토큰 인증) 구성 및 Tailscale Serve 활성화

토큰 인증을 기본값으로 사용합니다. 이는 예측 가능하며 "안전하지 않은 인증" 제어 UI 플래그가 필요하지 않습니다.

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7) 확인

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8) VCN 보안 잠금

이제 모든 것이 작동하므로 VCN을 잠가서 Tailscale을 제외한 모든 트래픽을 차단합니다. OCI의 가상 클라우드 네트워크는 네트워크 에지에서 방화벽 역할을 합니다. 즉, 트래픽이 인스턴스에 도달하기 전에 차단됩니다.

1. 이동 **네트워킹 → 가상 클라우드 네트워크** OCI 콘솔에서
2. VCN을 클릭 → **보안 목록** → 기본 보안 목록
3. **제거하다** 다음을 제외한 모든 수신 규칙:
   - `0.0.0.0/0 UDP 41641` (테일스케일)
4. 기본 송신 규칙 유지(모든 아웃바운드 허용)

이는 포트 22, HTTP, HTTPS 및 네트워크 에지의 기타 모든 항목에서 SSH를 차단합니다. 이제부터 Tailscale을 통해서만 연결할 수 있습니다.

---

## 컨트롤 UI에 액세스

Tailscale 네트워크의 모든 장치에서:

```
https://openclaw.<tailnet-name>.ts.net/
```

바꾸다 `<tailnet-name>` 귀하의 tailnet 이름으로 (다음에 표시됨) `tailscale status`).

SSH 터널이 필요하지 않습니다. Tailscale은 다음을 제공합니다.

- HTTPS 암호화(자동 인증서)
- Tailscale ID를 통한 인증
- 테일넷의 모든 장치(노트북, 휴대폰 등)에서 액세스

---

## 보안: VCN + Tailscale(권장 기준)

VCN이 잠겨 있고(UDP 41641만 열려 있음) 게이트웨이가 루프백에 바인딩되어 있으면 강력한 심층 방어가 가능합니다. 공용 트래픽은 네트워크 에지에서 차단되고 관리 액세스는 테일넷을 통해 이루어집니다.

이 설정은 종종 _필요_ 순전히 인터넷 전체 SSH 무차별 대입을 중지하기 위한 추가 호스트 기반 방화벽 규칙의 경우 — 하지만 여전히 OS를 업데이트된 상태로 유지해야 합니다. `openclaw security audit`, 공개 인터페이스에서 실수로 듣고 있지 않은지 확인하십시오.

### 이미 보호된 항목

| Traditional Step   | Needed?     | Why                                                                          |
| ------------------ | ----------- | ---------------------------------------------------------------------------- |
| UFW firewall       | No          | VCN blocks before traffic reaches instance                                   |
| fail2ban           | No          | No brute force if port 22 blocked at VCN                                     |
| sshd hardening     | No          | Tailscale SSH doesn't use sshd                                               |
| Disable root login | No          | Tailscale uses Tailscale identity, not system users                          |
| SSH key-only auth  | No          | Tailscale authenticates via your tailnet                                     |
| IPv6 hardening     | Usually not | Depends on your VCN/subnet settings; verify what’s actually assigned/exposed |

### 여전히 추천

- **자격 증명 권한:** `chmod 700 ~/.openclaw`
- **보안 감사:** `openclaw security audit`
- **시스템 업데이트:** `sudo apt update && sudo apt upgrade` 정기적으로
- **모니터 테일스케일:** 장치 검토 [Tailscale 관리 콘솔](https://login.tailscale.com/admin)

### 보안 상태 확인

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## 대체: SSH 터널

Tailscale Serve가 작동하지 않으면 SSH 터널을 사용하십시오.

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

그런 다음 열어 `http://localhost:18789`.

---

## 문제 해결

### 인스턴스 생성 실패('용량 부족')

무료 등급 ARM 인스턴스가 인기가 있습니다. 노력하다:

- 다양한 가용성 도메인
- 사용량이 적은 시간(이른 아침)에 다시 시도하세요.
- 도형 선택 시 '항상 무료' 필터를 사용하세요.

### Tailscale이 연결되지 않습니다

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### 게이트웨이가 시작되지 않습니다

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### 컨트롤 UI에 접근할 수 없습니다

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM 바이너리 문제

일부 도구에는 ARM 빌드가 없을 수 있습니다. 확인하다:

```bash
uname -m  # Should show aarch64
```

대부분의 npm 패키지는 잘 작동합니다. 바이너리의 경우 다음을 찾으십시오. `linux-arm64` 또는 `aarch64` 릴리스.

---

## 고집

모든 주 거주 지역:

- `~/.openclaw/` — 구성, 자격 증명, 세션 데이터
- `~/.openclaw/workspace/` — 작업 공간(SOUL.md, 메모리, 아티팩트)

정기적으로 백업:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 참조

- [게이트웨이 원격 액세스](/gateway/remote) — 기타 원격 액세스 패턴
- [테일스케일 통합](/gateway/tailscale) — 전체 Tailscale 문서
- [게이트웨이 구성](/gateway/configuration) — 모든 구성 옵션
- [디지털오션 가이드](/platforms/digitalocean) — 유료 + 간편한 가입을 원하는 경우
- [헤츠너 가이드](/install/hetzner) — Docker 기반 대안
