---
summary: "Oracle Cloud (Always Free ARM)에서 OpenClaw 실행"
read_when:
  - Oracle Cloud 에서 OpenClaw 설정하기
  - OpenClaw 용 저비용 VPS 호스팅을 찾고 있을 때
  - 소형 서버에서 24/7 OpenClaw 를 원할 때
title: "Oracle Cloud"
---

# Oracle Cloud (OCI)에서 OpenClaw

## 목표

Oracle Cloud 의 **Always Free** ARM 티어에서 지속적으로 실행되는 OpenClaw Gateway(게이트웨이)를 운영합니다.

Oracle 의 무료 티어는 OpenClaw 에 매우 적합할 수 있습니다(특히 이미 OCI 계정이 있는 경우). 다만 몇 가지 트레이드오프가 있습니다:

- ARM 아키텍처(대부분은 동작하지만 일부 바이너리는 x86 전용일 수 있음)
- 수용량과 가입 과정이 까다로울 수 있음

## 비용 비교 (2026)

| 제공업체         | 플랜              | 사양                  | 40. 월별 가격 | 참고 자료        |
| ------------ | --------------- | ------------------- | -------------------------------- | ------------ |
| Oracle Cloud | Always Free ARM | 최대 4 OCPU, 24GB RAM | $0                               | ARM, 제한된 수용량 |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM     | ~ $4             | 가장 저렴한 유료 옵션 |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM     | $6                               | 쉬운 UI, 좋은 문서 |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM     | $6                               | 많은 지역        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM     | $5                               | 현재 Akamai 소속 |

---

## 사전 준비 사항

- Oracle Cloud 계정([가입](https://www.oracle.com/cloud/free/)) — 문제가 발생하면 [커뮤니티 가입 가이드](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd)를 참고하십시오
- Tailscale 계정([tailscale.com](https://tailscale.com)에서 무료)
- 약 30분

## 1. OCI 인스턴스 생성

1. [Oracle Cloud Console](https://cloud.oracle.com/)에 로그인합니다
2. **Compute → Instances → Create Instance**로 이동합니다
3. 다음과 같이 구성합니다:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (또는 최대 4)
   - **Memory:** 12 GB (또는 최대 24 GB)
   - **Boot volume:** 50 GB (최대 200 GB 무료)
   - **SSH key:** 공개 키 추가
4. **Create**를 클릭합니다
5. 공인 IP 주소를 기록합니다

**팁:** 인스턴스 생성 시 "Out of capacity" 오류가 발생하면 다른 가용 도메인을 선택하거나 나중에 다시 시도하십시오. 무료 티어의 수용량은 제한적입니다.

## 2. 연결 및 업데이트

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**참고:** 일부 의존성의 ARM 컴파일을 위해 `build-essential` 이(가) 필요합니다.

## 3. 사용자 및 호스트 이름 구성

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Tailscale 설치

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

이를 통해 Tailscale SSH 가 활성화되므로, tailnet 에 속한 어떤 디바이스에서든 `ssh openclaw` 를 통해 연결할 수 있습니다. 공인 IP 는 필요하지 않습니다.

확인:

```bash
tailscale status
```

**이후에는 Tailscale 로 연결하십시오:** `ssh ubuntu@openclaw` (또는 Tailscale IP 사용).

## 5. OpenClaw 설치

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

"How do you want to hatch your bot?"라는 질문이 나오면 \*\*"Do this later"\*\*를 선택하십시오.

> 참고: ARM 네이티브 빌드 문제를 겪는 경우, Homebrew 를 사용하기 전에 시스템 패키지(예: `sudo apt install -y build-essential`)부터 시도하십시오.

## 6. Gateway(게이트웨이) 구성(loopback + 토큰 인증) 및 Tailscale Serve 활성화

기본값으로 토큰 인증을 사용하십시오. 이는 예측 가능하며 “insecure auth” Control UI 플래그를 사용할 필요를 피할 수 있습니다.

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

## 7. 확인

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

## 8. VCN 보안 잠금

모든 것이 정상 동작하는 것을 확인한 후, Tailscale 를 제외한 모든 트래픽을 차단하도록 VCN 을 잠그십시오. OCI 의 Virtual Cloud Network 는 네트워크 엣지에서 방화벽 역할을 하며, 트래픽은 인스턴스에 도달하기 전에 차단됩니다.

1. OCI Console 에서 **Networking → Virtual Cloud Networks**로 이동합니다
2. VCN 을 클릭한 후 **Security Lists** → Default Security List 를 선택합니다
3. 다음을 제외한 모든 인그레스 규칙을 **제거**합니다:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. 기본 이그레스 규칙(모든 아웃바운드 허용)은 유지합니다

이렇게 하면 네트워크 엣지에서 포트 22 의 SSH, HTTP, HTTPS 및 기타 모든 트래픽이 차단됩니다. 이후에는 Tailscale 을 통해서만 연결할 수 있습니다.

---

## Control UI 접근

Tailscale 네트워크에 있는 어떤 디바이스에서든:

```
https://openclaw.<tailnet-name>.ts.net/
```

`<tailnet-name>` 를 tailnet 이름으로 바꾸십시오( `tailscale status` 에서 확인 가능).

SSH 터널은 필요하지 않습니다. Tailscale 이 다음을 제공합니다:

- HTTPS 암호화(자동 인증서)
- Tailscale 아이덴티티 기반 인증
- tailnet 내 어떤 디바이스(노트북, 휴대폰 등)에서든 접근 가능

---

## 보안: VCN + Tailscale (권장 기준)

VCN 을 잠그고(UDP 41641 만 허용) Gateway(게이트웨이)를 loopback 에 바인딩하면 강력한 다층 방어가 구성됩니다. 공용 트래픽은 네트워크 엣지에서 차단되고, 관리 접근은 tailnet 을 통해 이루어집니다.

이 구성은 인터넷 전반의 SSH 무차별 대입 공격을 막기 위한 추가적인 호스트 기반 방화벽 규칙의 _필요성_을 줄여주는 경우가 많습니다. 다만 OS 를 최신 상태로 유지하고, `openclaw security audit` 를 실행하며, 공용 인터페이스에서 실수로 리스닝하고 있지 않은지 확인해야 합니다.

### 이미 보호되는 항목

| 전통적인 단계     | 필요 여부  | 이유                                           |
| ----------- | ------ | -------------------------------------------- |
| UFW 방화벽     | 아니요    | VCN 이 트래픽이 인스턴스에 도달하기 전에 차단함                 |
| fail2ban    | 아니요    | VCN 에서 포트 22 가 차단되면 무차별 대입 공격이 발생하지 않음       |
| sshd 하드닝    | 아니요    | Tailscale SSH 는 sshd 를 사용하지 않음               |
| 루트 로그인 비활성화 | 아니요    | Tailscale 은 시스템 사용자가 아닌 Tailscale 아이덴티티를 사용함 |
| SSH 키 전용 인증 | 아니요    | Tailscale 이 tailnet 을 통해 인증함                 |
| IPv6 하드닝    | 보통 불필요 | VCN/서브넷 설정에 따라 다름; 실제로 할당/노출된 항목을 확인해야 함     |

### 여전히 권장 사항

- **자격 증명 권한:** `chmod 700 ~/.openclaw`
- **보안 감사:** `openclaw security audit`
- **시스템 업데이트:** `sudo apt update && sudo apt upgrade` 를 정기적으로 수행
- **Tailscale 모니터링:** [Tailscale 관리 콘솔](https://login.tailscale.com/admin)에서 디바이스 검토

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

## 대안: SSH 터널

Tailscale Serve 가 동작하지 않는 경우 SSH 터널을 사용하십시오:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

그런 다음 `http://localhost:18789` 을 여십시오.

---

## 문제 해결

### 인스턴스 생성 실패 ("Out of capacity")

무료 티어 ARM 인스턴스는 인기가 많습니다. 다음을 시도하십시오:

- 다른 가용 도메인 선택
- 비혼잡 시간대(이른 아침)에 재시도
- Shape 선택 시 "Always Free" 필터 사용

### Tailscale 연결 실패

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway(게이트웨이)가 시작되지 않음

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Control UI 에 접근할 수 없음

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM 바이너리 문제

일부 도구는 ARM 빌드를 제공하지 않을 수 있습니다. 다음을 확인하십시오:

```bash
uname -m  # Should show aarch64
```

대부분의 npm 패키지는 문제없이 동작합니다. 바이너리의 경우 `linux-arm64` 또는 `aarch64` 릴리스를 찾으십시오.

---

## 영속성

모든 상태는 여기에 저장됨:

- `~/.openclaw/` — 구성, 자격 증명, 세션 데이터
- `~/.openclaw/workspace/` — 작업 공간(SOUL.md, 메모리, 아티팩트)

정기적으로 백업하십시오:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 참고

- [Gateway 원격 접근](/gateway/remote) — 다른 원격 접근 패턴
- [Tailscale 통합](/gateway/tailscale) — 전체 Tailscale 문서
- [Gateway 구성](/gateway/configuration) — 모든 구성 옵션
- [DigitalOcean 가이드](/platforms/digitalocean) — 유료 + 더 쉬운 가입을 원할 경우
- [Hetzner 가이드](/install/hetzner) — Docker 기반 대안
