---
summary: "OpenClaw용 VPS 호스팅 허브 (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - 클라우드에서 Gateway를 실행하고 싶을 때
  - VPS/호스팅 가이드의 빠른 맵이 필요할 때
title: "VPS 호스팅"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/vps.md"
  workflow: 15
---

# VPS 호스팅

이 허브는 지원되는 VPS/호스팅 가이드로의 링크이고 클라우드 배포가 높은 수준에서 어떻게 작동하는지 설명합니다.

## 제공자 선택

- **Railway** (원클릭 + 브라우저 설정): [Railway](/install/railway)
- **Northflank** (원클릭 + 브라우저 설정): [Northflank](/install/northflank)
- **Oracle Cloud (항상 무료)**: [Oracle](/platforms/oracle) — 월 $0 (항상 무료, ARM; 용량/가입은 불안정할 수 있음)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + HTTPS 프록시): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/무료 계층)**: 잘 작동합니다. 비디오 가이드:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## 클라우드 설정이 작동하는 방식

- **Gateway는 VPS에서 실행**되고 상태 + 워크스페이스를 소유합니다.
- 랩톱/휴대폰에서 **Control UI** 또는 **Tailscale/SSH**를 통해 연결합니다.
- VPS를 진실의 원천으로 취급하고 상태 + 워크스페이스를 **백업**합니다.
- 안전한 기본값: Gateway를 loopback에 유지하고 SSH 터널 또는 Tailscale Serve를 통해 액세스합니다.
  `lan`/`tailnet`에 바인드하는 경우 `gateway.auth.token` 또는 `gateway.auth.password`를 요구합니다.

원격 액세스: [Gateway 원격](/gateway/remote)
플랫폼 허브: [플랫폼](/platforms)

## VPS에서 공유 회사 에이전트

이는 사용자가 하나의 신뢰 경계에 있을 때 (예: 회사 팀) 및 에이전트가 비즈니스 전용일 때 유효한 설정입니다.

- 전용 런타임 (VPS/VM/컨테이너 + 전용 OS 사용자/계정)에 유지합니다.
- 개인 Apple/Google 계정 또는 개인 브라우저/암호 관리자 프로필에 해당 런타임을 서명하지 마세요.
- 사용자가 서로 적대적이면 gateway/호스트/OS 사용자로 분할합니다.

보안 모델 세부사항: [보안](/gateway/security)

## VPS와 함께 노드 사용

Gateway를 클라우드에 유지하고 로컬 장치 (Mac/iOS/Android/헤드레스)에 **노드**를 페어링할 수 있습니다.
노드는 로컬 화면/카메라/캔버스 및 `system.run` 기능을 제공하는 동안 Gateway는 클라우드에 남아 있습니다.

문서: [노드](/nodes), [노드 CLI](/cli/nodes)

## 소규모 VM 및 ARM 호스트에 대한 시작 튜닝

로우파워 VM (또는 ARM 호스트)에서 CLI 명령이 느린 경우 Node의 모듈 컴파일 캐시를 활성화합니다:

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF'
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

- `NODE_COMPILE_CACHE`는 반복된 명령 시작 시간을 개선합니다.
- `OPENCLAW_NO_RESPAWN=1`은 자동 재시작 경로로부터 추가 시작 오버헤드를 피합니다.
- 첫 번째 명령 실행이 캐시를 준비합니다. 후속 실행이 더 빠릅니다.
- Raspberry Pi 사항은 [Raspberry Pi](/platforms/raspberry-pi)를 참조하세요.

### systemd 튜닝 체크리스트 (선택 사항)

`systemd`를 사용하는 VM 호스트의 경우 다음을 고려합니다:

- 안정적인 시작 경로를 위해 서비스 환경 변수 추가:
  - `OPENCLAW_NO_RESPAWN=1`
  - `NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache`
- 재시작 동작을 명시적으로 유지:
  - `Restart=always`
  - `RestartSec=2`
  - `TimeoutStartSec=90`
- SSD 지원 디스크를 상태/캐시 경로에 선호하여 무작위 I/O 콜드 시작 페널티를 줄입니다.

예제:

```bash
sudo systemctl edit openclaw
```

```ini
[Service]
Environment=OPENCLAW_NO_RESPAWN=1
Environment=NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
Restart=always
RestartSec=2
TimeoutStartSec=90
```

`Restart=` 정책이 자동 복구에 어떻게 도움이 되는지:
[systemd는 서비스 복구를 자동화할 수 있습니다](https://www.redhat.com/en/blog/systemd-automate-recovery).
