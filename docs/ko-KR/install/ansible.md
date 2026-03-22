---
title: "Ansible"
summary: "Ansible, Tailscale VPN 및 방화벽 격리를 통한 자동화된, 강화된 OpenClaw 설치"
read_when:
  - 보안 강화가 포함된 자동 서버 배포를 원할 때
  - VPN 접근이 가능한 방화벽 격리 설정이 필요할 때
  - 원격 Debian/Ubuntu 서버에 배포할 때
x-i18n:
  source_path: docs/install/ansible.md
---

# Ansible 설치

**[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** 을 사용하여 프로덕션 서버에 OpenClaw 를 배포합니다 -- 보안 우선 아키텍처를 갖춘 자동화 설치 프로그램입니다.

<Info>
[openclaw-ansible](https://github.com/openclaw/openclaw-ansible) 저장소가 Ansible 배포의 정보 출처입니다. 이 페이지는 간략한 개요입니다.
</Info>

## 사전 요구사항

| 요구사항     | 세부사항                                      |
| ------------ | --------------------------------------------- |
| **OS**       | Debian 11+ 또는 Ubuntu 20.04+                 |
| **접근**     | Root 또는 sudo 권한                           |
| **네트워크** | 패키지 설치를 위한 인터넷 연결                |
| **Ansible**  | 2.14+ (빠른 시작 스크립트에 의해 자동 설치됨) |

## 제공되는 것

- **방화벽 우선 보안** -- UFW + Docker 격리 (SSH + Tailscale 만 접근 가능)
- **Tailscale VPN** -- 서비스를 공개적으로 노출하지 않는 안전한 원격 접근
- **Docker** -- 격리된 샌드박스 컨테이너, localhost 전용 바인딩
- **심층 방어** -- 4 계층 보안 아키텍처
- **Systemd 통합** -- 강화가 포함된 부팅 시 자동 시작
- **원 커맨드 설정** -- 몇 분 만에 완전한 배포

## 빠른 시작

원 커맨드 설치:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

## 설치되는 것

Ansible 플레이북은 다음을 설치하고 구성합니다:

1. **Tailscale** -- 안전한 원격 접근을 위한 메시 VPN
2. **UFW 방화벽** -- SSH + Tailscale 포트만 허용
3. **Docker CE + Compose V2** -- 에이전트 샌드박스용
4. **Node.js 24 + pnpm** -- 런타임 의존성 (현재 `22.16+` 인 Node 22 LTS 도 지원됨)
5. **OpenClaw** -- 호스트 기반, 컨테이너화되지 않음
6. **Systemd 서비스** -- 보안 강화가 포함된 자동 시작

<Note>
Gateway 는 호스트에서 직접 실행됩니다 (Docker 내부가 아님). 하지만 에이전트 샌드박스는 격리를 위해 Docker 를 사용합니다. 자세한 내용은 [샌드박싱](/gateway/sandboxing)을 참고하세요.
</Note>

## 설치 후 설정

<Steps>
  <Step title="openclaw 사용자로 전환">
    ```bash
    sudo -i -u openclaw
    ```
  </Step>
  <Step title="온보딩 마법사 실행">
    설치 후 스크립트가 OpenClaw 설정 구성을 안내합니다.
  </Step>
  <Step title="메시징 프로바이더 연결">
    WhatsApp, Telegram, Discord 또는 Signal 에 로그인합니다:
    ```bash
    openclaw channels login
    ```
  </Step>
  <Step title="설치 확인">
    ```bash
    sudo systemctl status openclaw
    sudo journalctl -u openclaw -f
    ```
  </Step>
  <Step title="Tailscale 에 연결">
    안전한 원격 접근을 위해 VPN 메시에 참여합니다.
  </Step>
</Steps>

### 빠른 명령어

```bash
# 서비스 상태 확인
sudo systemctl status openclaw

# 실시간 로그 보기
sudo journalctl -u openclaw -f

# Gateway 재시작
sudo systemctl restart openclaw

# 프로바이더 로그인 (openclaw 사용자로 실행)
sudo -i -u openclaw
openclaw channels login
```

## 보안 아키텍처

배포는 4 계층 방어 모델을 사용합니다:

1. **방화벽 (UFW)** -- SSH (22) + Tailscale (41641/udp) 만 공개적으로 노출
2. **VPN (Tailscale)** -- VPN 메시를 통해서만 Gateway 접근 가능
3. **Docker 격리** -- DOCKER-USER iptables 체인이 외부 포트 노출 방지
4. **Systemd 강화** -- NoNewPrivileges, PrivateTmp, 비권한 사용자

외부 공격 면적을 확인하려면:

```bash
nmap -p- YOUR_SERVER_IP
```

포트 22 (SSH) 만 열려 있어야 합니다. 다른 모든 서비스 (Gateway, Docker) 는 잠겨 있습니다.

Docker 는 에이전트 샌드박스 (격리된 도구 실행) 를 위해 설치되며, Gateway 자체를 실행하기 위한 것이 아닙니다. 샌드박스 구성에 대해서는 [멀티 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools)를 참고하세요.

## 수동 설치

자동화보다 수동 제어를 선호하는 경우:

<Steps>
  <Step title="사전 요구사항 설치">
    ```bash
    sudo apt update && sudo apt install -y ansible git
    ```
  </Step>
  <Step title="저장소 복제">
    ```bash
    git clone https://github.com/openclaw/openclaw-ansible.git
    cd openclaw-ansible
    ```
  </Step>
  <Step title="Ansible 컬렉션 설치">
    ```bash
    ansible-galaxy collection install -r requirements.yml
    ```
  </Step>
  <Step title="플레이북 실행">
    ```bash
    ./run-playbook.sh
    ```

    또는 직접 실행한 다음 설정 스크립트를 수동으로 실행합니다:
    ```bash
    ansible-playbook playbook.yml --ask-become-pass
    # 그런 다음 실행: /tmp/openclaw-setup.sh
    ```

  </Step>
</Steps>

## 업데이트

Ansible 설치 프로그램은 OpenClaw 를 수동 업데이트용으로 설정합니다. 표준 업데이트 플로우는 [업데이트](/install/updating)를 참고하세요.

Ansible 플레이북을 다시 실행하려면 (예: 구성 변경 시):

```bash
cd openclaw-ansible
./run-playbook.sh
```

이것은 멱등성이 있으며 여러 번 실행해도 안전합니다.

## 문제 해결

<AccordionGroup>
  <Accordion title="방화벽이 연결을 차단함">
    - 먼저 Tailscale VPN 을 통해 접근할 수 있는지 확인하세요
    - SSH 접근 (포트 22) 은 항상 허용됩니다
    - Gateway 는 설계상 Tailscale 을 통해서만 접근 가능합니다
  </Accordion>
  <Accordion title="서비스가 시작되지 않음">
    ```bash
    # 로그 확인
    sudo journalctl -u openclaw -n 100

    # 권한 확인
    sudo ls -la /opt/openclaw

    # 수동 시작 테스트
    sudo -i -u openclaw
    cd ~/openclaw
    openclaw gateway run
    ```

  </Accordion>
  <Accordion title="Docker 샌드박스 문제">
    ```bash
    # Docker 실행 여부 확인
    sudo systemctl status docker

    # 샌드박스 이미지 확인
    sudo docker images | grep openclaw-sandbox

    # 누락된 경우 샌드박스 이미지 빌드
    cd /opt/openclaw/openclaw
    sudo -u openclaw ./scripts/sandbox-setup.sh
    ```

  </Accordion>
  <Accordion title="프로바이더 로그인 실패">
    `openclaw` 사용자로 실행하고 있는지 확인하세요:
    ```bash
    sudo -i -u openclaw
    openclaw channels login
    ```
  </Accordion>
</AccordionGroup>

## 고급 구성

자세한 보안 아키텍처와 문제 해결은 openclaw-ansible 저장소를 참고하세요:

- [보안 아키텍처](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [기술 세부사항](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [문제 해결 가이드](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## 관련 문서

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) -- 전체 배포 가이드
- [Docker](/install/docker) -- 컨테이너화된 Gateway 설정
- [샌드박싱](/gateway/sandboxing) -- 에이전트 샌드박스 구성
- [멀티 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools) -- 에이전트별 격리
