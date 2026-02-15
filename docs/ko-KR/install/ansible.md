---
summary: "Automated, hardened OpenClaw installation with Ansible, Tailscale VPN, and firewall isolation"
read_when:
  - You want automated server deployment with security hardening
  - You need firewall-isolated setup with VPN access
  - You're deploying to remote Debian/Ubuntu servers
title: "Ansible"
x-i18n:
  source_hash: b1e1e1ea13bff37b22bc58dad4b15a2233c6492771403dff364c738504aa7159
---

# 앤서블 설치

OpenClaw를 프로덕션 서버에 배포하는 권장 방법은 보안 우선 아키텍처를 갖춘 자동 설치 프로그램인 **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**를 사용합니다.

## 빠른 시작

단일 명령 설치:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 전체 가이드: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible 저장소는 Ansible 배포의 정보 소스입니다. 이 페이지는 간략한 개요입니다.

## 얻을 수 있는 것

- 🔒 **방화벽 우선 보안**: UFW + Docker 격리(SSH + Tailscale만 액세스 가능)
- 🔐 **Tailscale VPN**: 서비스를 공개적으로 노출하지 않고 원격 액세스를 보호합니다.
- 🐳 **Docker**: 격리된 샌드박스 컨테이너, 로컬 호스트 전용 바인딩
- 🛡️ **심층 방어**: 4계층 보안 아키텍처
- 🚀 **단일 명령 설정**: 몇 분 만에 배포 완료
- 🔧 **시스템 통합**: 강화를 통해 부팅 시 자동 시작

## 요구사항

- **OS**: Debian 11+ 또는 Ubuntu 20.04+
- **액세스**: Root 또는 sudo 권한
- **네트워크**: 패키지 설치를 위한 인터넷 연결
- **Ansible**: 2.14+(빠른 시작 스크립트에 의해 자동으로 설치됨)

## 무엇이 설치되나요?

Ansible 플레이북은 다음을 설치하고 구성합니다.

1. **Tailscale**(보안 원격 액세스를 위한 메시 VPN)
2. **UFW 방화벽**(SSH + Tailscale 포트만 해당)
3. **Docker CE + Compose V2**(에이전트 샌드박스용)
4. **Node.js 22.x + pnpm**(런타임 종속성)
5. **OpenClaw**(호스트 기반, 컨테이너화되지 않음)
6. **Systemd 서비스** (보안 강화로 자동 시작)

참고: 게이트웨이는 **호스트에서 직접**(Docker가 아님) 실행되지만 에이전트 샌드박스는 격리를 위해 Docker를 사용합니다. 자세한 내용은 [샌드박싱](/gateway/sandboxing)을 참조하세요.

## 설치 후 설정

설치가 완료되면 openclaw 사용자로 전환합니다.

```bash
sudo -i -u openclaw
```

설치 후 스크립트는 다음을 안내합니다.

1. **온보딩 마법사**: OpenClaw 설정 구성
2. **공급자 로그인**: WhatsApp/Telegram/Discord/Signal 연결
3. **게이트웨이 테스트**: 설치 확인
4. **Tailscale 설정**: VPN 메시에 연결

### 빠른 명령

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

### 4중 방어

1. **방화벽(UFW)**: SSH(22) + Tailscale(41641/udp)만 공개적으로 노출됨
2. **VPN(Tailscale)**: VPN 메시를 통해서만 액세스 가능한 게이트웨이
3. **Docker Isolation**: DOCKER-USER iptables 체인은 외부 포트 노출을 방지합니다.
4. **시스템 강화**: NoNewPrivileges, PrivateTmp, 권한이 없는 사용자

### 확인

외부 공격 표면 테스트:

```bash
nmap -p- YOUR_SERVER_IP
```

**포트 22**(SSH)만 열려 있음을 표시해야 합니다. 다른 모든 서비스(게이트웨이, Docker)는 잠겨 있습니다.

### 도커 가용성

Docker는 게이트웨이 자체를 실행하기 위한 것이 아니라 **에이전트 샌드박스**(격리된 도구 실행)용으로 설치됩니다. 게이트웨이는 localhost에만 바인딩되며 Tailscale VPN을 통해 액세스할 수 있습니다.

샌드박스 구성은 [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools)를 참조하세요.

## 수동 설치

자동화보다 수동 제어를 선호하는 경우:

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

## OpenClaw 업데이트 중

Ansible 설치 프로그램은 수동 업데이트를 위해 OpenClaw를 설정합니다. 표준 업데이트 흐름은 [업데이트](/install/updating)를 참조하세요.

Ansible 플레이북을 다시 실행하려면(예: 구성 변경):

```bash
cd openclaw-ansible
./run-playbook.sh
```

참고: 이는 멱등성이 있으며 여러 번 실행해도 안전합니다.

## 문제 해결

### 방화벽이 내 연결을 차단합니다.

잠겨 있는 경우:

- 먼저 Tailscale VPN을 통해 액세스할 수 있는지 확인하세요.
- SSH 접속(포트 22)은 항상 허용됩니다.
- 게이트웨이는 설계상 Tailscale을 통해서만 **액세스 가능**합니다.

### 서비스가 시작되지 않습니다

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

### 공급자 로그인 실패

`openclaw` 사용자로 실행 중인지 확인하세요.

```bash
sudo -i -u openclaw
openclaw channels login
```

## 고급 구성

자세한 보안 아키텍처 및 문제 해결:

- [보안 아키텍처](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [기술적 세부사항](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [문제해결 가이드](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 관련

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — 전체 배포 가이드
- [Docker](/install/docker) — 컨테이너화된 게이트웨이 설정
- [Sandboxing](/gateway/sandboxing) — 에이전트 샌드박스 구성
- [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools) — 에이전트별 격리
