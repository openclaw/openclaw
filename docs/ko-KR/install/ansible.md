---
summary: "Ansible, Tailscale VPN 및 방화벽 격리를 통한 자동화된 강화 OpenClaw 설치"
read_when:
  - 보안 강화를 통한 자동화된 서버 배포를 원할 때
  - VPN 접근과 함께 방화벽으로 격리된 설정이 필요할 때
  - 원격 Debian/Ubuntu 서버에 배포할 때
title: "Ansible"
---

# Ansible 설치

프로덕션 서버에 OpenClaw를 배포하는 권장 방법은 **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — 보안을 최우선으로 하는 자동화된 설치 프로그램을 사용하는 것입니다.

## 시작하기

한 줄 명령어로 설치:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 전체 가이드: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible 저장소는 Ansible 배포의 단일 진실 소스로서, 이 페이지는 빠른 개요를 제공합니다.

## 받을 수 있는 혜택

- 🔒 **방화벽 우선 보안**: UFW + Docker 격리 (SSH + Tailscale만 접근 가능)
- 🔐 **Tailscale VPN**: 서비스를 공개하지 않고 안전한 원격 접근 제공
- 🐳 **Docker**: 격리된 샌드박스 컨테이너, localhost 전용 바인딩
- 🛡️ **심층 방어력**: 4계층 보안 아키텍처
- 🚀 **한 줄 설정**: 몇 분 안에 완전한 배포
- 🔧 **Systemd 통합**: 강화된 보안으로 부팅 시 자동 실행

## 요구사항

- **OS**: Debian 11+ 또는 Ubuntu 20.04+
- **접근 권한**: 루트 또는 sudo 권한
- **네트워크**: 패키지 설치를 위한 인터넷 연결
- **Ansible**: 2.14+ (시작하기 스크립트에 의해 자동 설치됨)

## 설치 항목

Ansible 플레이북은 다음을 설치하고 구성합니다:

1. **Tailscale** (안전한 원격 접근을 위한 메쉬 VPN)
2. **UFW 방화벽** (SSH + Tailscale 포트만 허용)
3. **Docker CE + Compose V2** (에이전트 샌드박스를 위해)
4. **Node.js 22.x + pnpm** (실행 환경 의존성)
5. **OpenClaw** (호스트 기반, 컨테이너화되지 않음)
6. **Systemd 서비스** (강화된 보안과 함께 자동 시작)

참고: 게이트웨이는 **호스트에서 직접 실행**되며 (Docker에서 실행되지 않음), 에이전트 샌드박스는 격리를 위해 Docker를 사용합니다. 자세한 내용은 [샌드박스 격리](/gateway/sandboxing)를 참조하세요.

## 설치 후 설정

설치 완료 후, openclaw 사용자로 전환하세요:

```bash
sudo -i -u openclaw
```

설치 후 스크립트가 다음 과정을 안내합니다:

1. **온보딩 마법사**: OpenClaw 설정 구성
2. **프로바이더 로그인**: WhatsApp/Telegram/Discord/Signal 연결
3. **게이트웨이 테스트**: 설치 검증
4. **Tailscale 설정**: VPN 메쉬에 연결

### 빠른 명령어

```bash
# 서비스 상태 확인
sudo systemctl status openclaw

# 실시간 로그 보기
sudo journalctl -u openclaw -f

# 게이트웨이 재시작
sudo systemctl restart openclaw

# 프로바이더 로그인 (openclaw 사용자로 실행)
sudo -i -u openclaw
openclaw channels login
```

## 보안 아키텍처

### 4계층 방어

1. **방화벽 (UFW)**: SSH (22) + Tailscale (41641/udp)만 공개적으로 노출
2. **VPN (Tailscale)**: 게이트웨이는 VPN 메쉬를 통해서만 접근 가능
3. **Docker 격리**: DOCKER-USER iptables 체인으로 외부 포트 노출 방지
4. **Systemd 강화**: NoNewPrivileges, PrivateTmp, 비권한 사용자

### 확인

외부 공격 표면 테스트:

```bash
nmap -p- YOUR_SERVER_IP
```

**포트 22** (SSH)만 열려 있어야 합니다. 모든 다른 서비스 (게이트웨이, Docker)는 잠긴 상태입니다.

### Docker 가용성

Docker는 **에이전트 샌드박스**(격리된 도구 실행)용으로 설치됩니다, 게이트웨이는 직접 실행되지 않습니다. 게이트웨이는 localhost에만 바인딩되며 Tailscale VPN을 통해 접근 가능합니다.

샌드박스 구성에 대한 자세한 내용은 [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)를 참조하세요.

## 수동 설치

자동화 대신 수동 제어를 선호하는 경우:

```bash
# 1. 사전 요구사항 설치
sudo apt update && sudo apt install -y ansible git

# 2. 저장소 클론
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Ansible 컬렉션 설치
ansible-galaxy collection install -r requirements.yml

# 4. 플레이북 실행
./run-playbook.sh

# 직접 실행 (그 후 수동으로 /tmp/openclaw-setup.sh 실행)
# ansible-playbook playbook.yml --ask-become-pass
```

## OpenClaw 업데이트

Ansible 설치 프로그램은 수동 업데이트를 위한 OpenClaw를 설정합니다. 표준 업데이트 흐름은 [Updating](/install/updating)를 참조하세요.

Ansible 플레이북을 다시 실행하려면 (예: 설정 변경):

```bash
cd openclaw-ansible
./run-playbook.sh
```

참고: 이것은 멱등이며 여러 번 실행해도 안전합니다.

## 문제 해결

### 방화벽이 내 연결을 차단합니다

잠겨 있는 경우:

- 먼저 Tailscale VPN을 통해 접근할 수 있는지 확인하십시오.
- SSH 접근 (포트 22)은 항상 허용됩니다.
- 게이트웨이는 기본적으로 Tailscale을 통해서만 접근 가능합니다.

### 서비스가 시작되지 않음

```bash
# 로그 확인
sudo journalctl -u openclaw -n 100

# 권한 확인
sudo ls -la /opt/openclaw

# 수동 시작 테스트
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker 샌드박스 문제

```bash
# Docker 실행 확인
sudo systemctl status docker

# 샌드박스 이미지 확인
sudo docker images | grep openclaw-sandbox

# 이미지가 없을 경우 빌드
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### 프로바이더 로그인 실패

`openclaw` 사용자로 실행 중인지 확인하세요:

```bash
sudo -i -u openclaw
openclaw channels login
```

## 고급 구성

자세한 보안 아키텍처 및 문제 해결:

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 관련 항목

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — 전체 배포 가이드
- [Docker](/install/docker) — 컨테이너화된 게이트웨이 설정
- [샌드박스 격리](/gateway/sandboxing) — 에이전트 샌드박스 구성
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — 에이전트별 격리
