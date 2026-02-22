---
summary: "OpenClaw on Oracle Cloud (항상 무료 ARM)"
read_when:
  - Oracle Cloud에 OpenClaw 설치
  - OpenClaw를 위한 저비용 VPS 호스팅을 찾고 있음
  - 작은 서버에서 24/7 OpenClaw를 원함
title: "Oracle Cloud"
---

# OpenClaw on Oracle Cloud (OCI)

## 목표

Oracle Cloud의 **Always Free** ARM 계층에서 지속적인 OpenClaw 게이트웨이를 실행합니다.

Oracle의 무료 계층은 OpenClaw에 적합할 수 있습니다 (특히 이미 OCI 계정이 있는 경우). 하지만 다음과 같은 타협이 필요합니다:

- ARM 아키텍처 (대부분 작동하지만 일부 바이너리는 x86 전용일 수 있음)
- 용량 및 가입이 번거로울 수 있음

## 비용 비교 (2026)

| Provider     | Plan            | Specs                  | Price/mo | Notes                 |
| ------------ | --------------- | ---------------------- | -------- | --------------------- |
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0       | ARM, Limited Capacity |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | ~ $4     | 가장 저렴한 유료 옵션 |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6       | 쉬운 UI, 좋은 문서   |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6       | 다양한 위치          |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5       | 이제 Akamai의 일부  |

---

## 필수 조건

- Oracle Cloud 계정 ([가입](https://www.oracle.com/cloud/free/)) — 문제가 발생하면 [커뮤니티 가입 가이드](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) 참조
- Tailscale 계정 ([tailscale.com](https://tailscale.com)에서 무료)
- 약 30분

## 1) OCI 인스턴스 생성

1. [Oracle Cloud Console](https://cloud.oracle.com/)에 로그인
2. **Compute → Instances → Create Instance**로 이동
3. 설정:
   - **이름:** `openclaw`
   - **이미지:** Ubuntu 24.04 (aarch64)
   - **형상:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (최대 4까지 가능)
   - **메모리:** 12 GB (최대 24 GB까지 가능)
   - **부트 볼륨:** 50 GB (최대 200 GB 무료)
   - **SSH 키:** 공개 키 추가
4. **Create** 클릭
5. 공인 IP 주소 기록

**팁:** 인스턴스 생성이 "용량 부족"으로 실패하면 다른 가용성 도메인을 시도하거나 나중에 다시 시도하세요. 무료 계층 용량은 제한되어 있습니다.

## 2) 연결 및 업데이트

```bash
# 공인 IP를 통해 연결
ssh ubuntu@YOUR_PUBLIC_IP

# 시스템 업데이트
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**참고:** `build-essential`은 일부 종속성의 ARM 컴파일에 필요합니다.

## 3) 사용자 및 호스트 이름 구성

```bash
# 호스트 이름 설정
sudo hostnamectl set-hostname openclaw

# ubuntu 사용자 암호 설정
sudo passwd ubuntu

# 지속 활성화 (로그아웃 후에도 사용자 서비스가 실행되도록 유지)
sudo loginctl enable-linger ubuntu
```

## 4) Tailscale 설치

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

이는 Tailscale SSH를 활성화하여, tailnet의 어떤 장치로부터도 `ssh openclaw`으로 연결할 수 있게 해줍니다 — 공인 IP 불필요.

확인:

```bash
tailscale status
```

**이제부터는 Tailscale을 통해 연결:** `ssh ubuntu@openclaw` (또는 Tailscale IP 사용).

## 5) OpenClaw 설치

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

"How do you want to hatch your bot?" 질문 시, **"Do this later"** 선택.

> 참고: ARM 네이티브 빌드 문제 발생 시, Homebrew 대신 시스템 패키지(e.g. `sudo apt install -y build-essential`)로 시작하세요.

## 6) 게이트웨이 구성 (로컬 루프백 + 토큰 인증) 및 Tailscale Serve 활성화

기본 값으로 토큰 인증 사용. 이는 예측 가능하며 “비보안 인증” 제어 UI 플래그를 필요로 하지 않습니다.

```bash
# VM에서 게이트웨이를 비공개로 유지
openclaw config set gateway.bind loopback

# 게이트웨이 및 제어 UI에 대한 인증 필요
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Tailscale Serve를 통해 노출 (HTTPS + tailnet 접근)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7) 확인

```bash
# 버전 확인
openclaw --version

# 데몬 상태 확인
systemctl --user status openclaw-gateway

# Tailscale Serve 확인
tailscale serve status

# 로컬 응답 테스트
curl http://localhost:18789
```

## 8) VCN 보안 잠금

모든 것이 제대로 작동하면 이제 Tailscale을 제외한 모든 트래픽을 차단하도록 VCN을 잠급니다. OCI의 가상 클라우드 네트워크는 네트워크 테두리에서 방화벽 역할을 하며 — 트래픽이 인스턴스에 도달하기 전에 차단됩니다.

1. OCI 콘솔에서 **네트워킹 → 가상 클라우드 네트워크**로 이동
2. VCN 클릭 → **보안 목록** → 기본 보안 목록
3. 다음을 제외한 모든 인바운드 규칙 **제거**:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. 기본 아웃바운드 규칙 유지 (모든 아웃바운드 허용)

이로써 포트 22에서의 SSH, HTTP, HTTPS 및 네트워크 가장자리에 있는 모든 다른 것이 차단됩니다. 앞으로는 Tailscale을 통해서만 연결할 수 있습니다.

---

## 제어 UI에 액세스

Tailscale 네트워크에 있는 모든 장치에서:

```
https://openclaw.<tailnet-name>.ts.net/
```

`<tailnet-name>`을 tailnet 이름으로 교체하세요 (`tailscale status`에서 확인 가능).

SSH 터널 필요 없음. Tailscale이 제공하는 것:

- HTTPS 암호화 (자동 인증서)
- Tailscale 신원을 통한 인증
- tailnet에 있는 어떤 장치(노트북, 전화기 등)로부터의 접근

---

## 보안: VCN + Tailscale (권장 기본 설정)

VCN을 잠그고 (UDP 41641만 열림) 게이트웨이를 로컬 루프백에 바인딩하면, 강력한 심층 방어 (defense-in-depth)를 얻습니다: 공용 트래픽은 네트워크 테두리에서 차단되고, 관리자 접근은 tailnet을 통해 이루어집니다.

이 설정은 종종 Internet-wide SSH 무차별 대입 공격을 저지하기 위한 추가 호스트 기반 방화벽 규칙의 _필요성_을 제거합니다 — 하지만 여전히 OS를 업데이트하고 `openclaw security audit`을 실행하며 공용 인터페이스에서 실수로 리스닝하지 않도록 확인해야 합니다.

### 이미 보호된 항목

| 전통적인 단계             | 필요 여부 | 이유                                                                                             |
| -------------------- | ------- | ---------------------------------------------------------------------------------------- |
| UFW 방화벽           | 아니오    | VCN이 인스턴스에 도달하기 전에 트래픽을 차단                                                      |
| fail2ban             | 아니오    | 포트 22가 VCN에서 차단된 상태에서는 무차별 대입 공격이 발생하지 않음                               |
| sshd 강화            | 아니오    | Tailscale SSH는 sshd를 사용하지 않음                                                           |
| 루트 로그인 비활성화 | 아니오    | Tailscale은 시스템 사용자 대신 Tailscale 신원을 사용                                          |
| SSH 키-전용 인증     | 아니오    | Tailscale은 tailnet을 통해 인증                                                               |
| IPv6 강화            | 보통 필요 없음 | VCN/서브넷 설정에 따라 다름; 실제로 할당/노출된 것을 확인                                             |

### 여전히 권장되는 항목

- **자격 증명 권한:** `chmod 700 ~/.openclaw`
- **보안 감사:** `openclaw security audit`
- **시스템 업데이트:** `sudo apt update && sudo apt upgrade`를 정기적으로 실행
- **Tailscale 모니터링:** [Tailscale 관리 콘솔](https://login.tailscale.com/admin)에서 장치 리뷰

### 보안 자세 확인

```bash
# 공용 포트가 리스닝 중이지 않은지 확인
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Tailscale SSH가 활성화되었는지 확인
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# 선택 사항: sshd를 완전히 비활성화
sudo systemctl disable --now ssh
```

---

## 대안: SSH 터널

Tailscale Serve가 작동하지 않으면, SSH 터널을 사용하세요:

```bash
# 로컬 머신에서 (Tailscale을 통해)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

그런 다음 `http://localhost:18789`를 엽니다.

---

## 문제 해결

### 인스턴스 생성 실패 ("용량 부족")

무료 계층 ARM 인스턴스는 인기가 많습니다. 다음을 시도하세요:

- 다른 가용성 도메인
- 비사용 시간대에 다시 시도 (이른 오전)
- 형상을 선택할 때 "Always Free" 필터 사용

### Tailscale이 연결되지 않음

```bash
# 상태 확인
sudo tailscale status

# 다시 인증
sudo tailscale up --ssh --hostname=openclaw --reset
```

### 게이트웨이가 시작되지 않음

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### 제어 UI에 접근할 수 없음

```bash
# Tailscale Serve가 실행 중인지 확인
tailscale serve status

# 게이트웨이가 리스닝 중인지 확인
curl http://localhost:18789

# 필요 시 재시작
systemctl --user restart openclaw-gateway
```

### ARM 바이너리 문제

일부 도구에는 ARM 빌드가 없을 수 있습니다. 확인:

```bash
uname -m  # aarch64로 표시되어야 함
```

대부분의 npm 패키지는 잘 작동합니다. 바이너리의 경우, `linux-arm64` 또는 `aarch64` 릴리스를 찾으세요.

---

## 지속성

모든 상태는 다음에 저장됩니다:

- `~/.openclaw/` — 설정, 자격 증명, 세션 데이터
- `~/.openclaw/workspace/` — 워크스페이스 (SOUL.md, 메모리, 아티팩트)

정기적으로 백업:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## 참조

- [Gateway remote access](/ko-KR/gateway/remote) — 다른 원격 접근 패턴
- [Tailscale integration](/ko-KR/gateway/tailscale) — 전체 Tailscale 문서
- [Gateway configuration](/ko-KR/gateway/configuration) — 모든 설정 옵션
- [DigitalOcean guide](/ko-KR/platforms/digitalocean) — 유료 + 쉬운 가입을 원하는 경우
- [Hetzner guide](/ko-KR/install/hetzner) — 도커 기반 대안