---
summary: "Ansible, Tailscale VPN 및 방화벽 격리를 통한 자동화되고 강화된 OpenClaw 설치"
read_when:
  - 보안 강화가 적용된 자동화 서버 배포가 필요할 때
  - VPN 액세스가 포함된 방화벽 격리 설정이 필요할 때
  - 원격 Debian/Ubuntu 서버에 배포할 때
title: "Ansible"
---

# Ansible 설치

프로덕션 서버에 OpenClaw 를 배포하는 권장 방식은 **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** 을 사용하는 것입니다. 이는 보안을 최우선으로 설계된 아키텍처를 갖춘 자동화 설치 도구입니다.

## 빠른 시작

단일 명령 설치:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 전체 가이드: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible 저장소는 Ansible 배포에 대한 단일 기준 소스입니다. 이 페이지는 간략한 개요를 제공합니다.

## What You Get

- 🔒 **방화벽 우선 보안**: UFW + Docker 격리 (SSH + Tailscale 만 접근 가능)
- 🔐 **Tailscale VPN**: 서비스를 공개하지 않고도 안전한 원격 액세스
- 🐳 **Docker**: 격리된 샌드박스 컨테이너, localhost 전용 바인딩
- 🛡️ **심층 방어**: 4계층 보안 아키텍처
- 🚀 **단일 명령 설정**: 수분 내 전체 배포 완료
- 🔧 **Systemd 통합**: 보안 강화 옵션과 함께 부팅 시 자동 시작

## 요구 사항

- **OS**: Debian 11+ 또는 Ubuntu 20.04+
- **접근 권한**: Root 또는 sudo 권한
- **네트워크**: 패키지 설치를 위한 인터넷 연결
- **Ansible**: 2.14+ (빠른 시작 스크립트로 자동 설치됨)

## What Gets Installed

Ansible 플레이북은 다음을 설치 및 구성합니다:

1. **Tailscale** (안전한 원격 액세스를 위한 메시 VPN)
2. **UFW 방화벽** (SSH + Tailscale 포트만 허용)
3. **Docker CE + Compose V2** (에이전트 샌드박스용)
4. **Node.js 22.x + pnpm** (런타임 의존성)
5. **OpenClaw** (컨테이너가 아닌 호스트 기반 실행)
6. **Systemd 서비스** (보안 강화와 함께 자동 시작)

참고: Gateway(게이트웨이) 는 **Docker 가 아닌 호스트에서 직접 실행** 되며, 에이전트 샌드박스는 격리를 위해 Docker 를 사용합니다. 자세한 내용은 [Sandboxing](/gateway/sandboxing) 을 참고하십시오.

## 설치 후 설정

설치가 완료되면 openclaw 사용자로 전환하십시오:

```bash
sudo -i -u openclaw
```

설치 후 스크립트는 다음 과정을 안내합니다:

1. **온보딩 마법사**: OpenClaw 설정 구성
2. **프로바이더 로그인**: WhatsApp/Telegram/Discord/Signal 연결
3. **Gateway 테스트**: 설치 검증
4. **Tailscale 설정**: VPN 메시 연결

### 빠른 명령어

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## 보안 아키텍처

### 4계층 방어

1. **방화벽 (UFW)**: 외부에 공개되는 포트는 SSH (22) 와 Tailscale (41641/udp) 만 허용
2. **VPN (Tailscale)**: Gateway 는 VPN 메시를 통해서만 접근 가능
3. **Docker 격리**: DOCKER-USER iptables 체인이 외부 포트 노출을 차단
4. **Systemd 보안 강화**: NoNewPrivileges, PrivateTmp, 비특권 사용자 실행

### 검증

외부 공격 표면을 테스트하십시오:

```bash
nmap -p- YOUR_SERVER_IP
```

결과에는 **포트 22** (SSH) 만 열려 있어야 합니다. 다른 모든 서비스 (Gateway, Docker)는 잠겨 있습니다.

### Docker 사용 범위

Docker 는 **에이전트 샌드박스** (격리된 도구 실행) 를 위해 설치되며, Gateway 자체를 실행하는 용도는 아닙니다. Gateway 는 localhost 에만 바인딩되며 Tailscale VPN 을 통해 접근합니다.

샌드박스 구성에 대해서는 [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) 를 참고하십시오.

## 수동 설치

자동화 대신 수동 제어를 선호하는 경우:

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## OpenClaw 업데이트

Ansible 설치 프로그램은 OpenClaw 를 수동 업데이트 방식으로 설정합니다. 표준 업데이트 절차는 [Updating](/install/updating) 을 참고하십시오.

구성 변경 등을 위해 Ansible 플레이북을 다시 실행하려면:

```bash
cd openclaw-ansible
./run-playbook.sh
```

참고: 이 작업은 멱등적이며 여러 번 실행해도 안전합니다.

## 문제 해결

### 방화벽이 연결을 차단하는 경우

접근이 차단된 경우 다음을 확인하십시오:

- 먼저 Tailscale VPN 을 통해 접근 가능한지 확인하십시오
- SSH 접근 (포트 22) 은 항상 허용됩니다
- Gateway 는 설계상 **Tailscale 을 통해서만** 접근 가능합니다

### 서비스가 시작되지 않는 경우

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker 샌드박스 문제

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### 프로바이더 로그인 실패

다음 사용자로 실행 중인지 확인하십시오: `openclaw` 사용자:

```bash
sudo -i -u openclaw
openclaw channels login
```

## 고급 구성

자세한 보안 아키텍처 및 문제 해결 내용은 다음을 참고하십시오:

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 관련 문서

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — 전체 배포 가이드
- [Docker](/install/docker) — 컨테이너 기반 Gateway 설정
- [Sandboxing](/gateway/sandboxing) — 에이전트 샌드박스 구성
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — 에이전트별 격리
