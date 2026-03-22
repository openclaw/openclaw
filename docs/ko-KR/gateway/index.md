---
summary: "Gateway 서비스의 운영, 수명주기, 그리고 운영 가이드"
read_when:
  - Gateway 프로세스를 실행하거나 디버깅할 때
title: "Gateway 운영 가이드"
x-i18n:
  source_path: docs/gateway/index.md
---

# Gateway 운영 가이드

이 페이지는 Gateway 서비스의 1일차 시작과 2일차 운영에 활용합니다.

<CardGroup cols={2}>
  <Card title="심층 문제 해결" icon="siren" href="/gateway/troubleshooting">
    증상 기반 진단과 정확한 명령어 순서 및 로그 시그니처를 제공합니다.
  </Card>
  <Card title="설정" icon="sliders" href="/gateway/configuration">
    작업 중심 설정 가이드와 전체 설정 레퍼런스입니다.
  </Card>
  <Card title="시크릿 관리" icon="key-round" href="/gateway/secrets">
    SecretRef 계약, 런타임 스냅샷 동작, 마이그레이션/리로드 작업을 다룹니다.
  </Card>
  <Card title="시크릿 플랜 계약" icon="shield-check" href="/gateway/secrets-plan-contract">
    `secrets apply`의 정확한 대상/경로 규칙과 ref 전용 인증 프로필 동작을 설명합니다.
  </Card>
</CardGroup>

## 5분 로컬 시작

<Steps>
  <Step title="Gateway 시작">

```bash
openclaw gateway --port 18789
# 디버그/트레이스를 표준 입출력에 미러링
openclaw gateway --port 18789 --verbose
# 선택한 포트의 리스너를 강제 종료 후 시작
openclaw gateway --force
```

  </Step>

  <Step title="서비스 상태 확인">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

정상 기준선: `Runtime: running` 및 `RPC probe: ok`.

  </Step>

  <Step title="채널 준비 상태 검증">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
Gateway 설정 리로드는 활성 설정 파일 경로(프로필/상태 기본값에서 확인되거나 `OPENCLAW_CONFIG_PATH`가 설정된 경우 해당 경로)를 감시합니다.
기본 모드는 `gateway.reload.mode="hybrid"`입니다.
</Note>

## 런타임 모델

- 라우팅, 컨트롤 플레인, 채널 연결을 위한 하나의 상시 가동 프로세스입니다.
- 단일 다중화 포트:
  - WebSocket 제어/RPC
  - HTTP API (OpenAI 호환, Responses, tools invoke)
  - 컨트롤 UI 및 훅
- 기본 바인드 모드: `loopback`.
- 인증은 기본적으로 필수입니다 (`gateway.auth.token` / `gateway.auth.password` 또는 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`).

### 포트 및 바인드 우선순위

| 설정         | 해석 순서                                                     |
| ------------ | ------------------------------------------------------------- |
| Gateway 포트 | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| 바인드 모드  | CLI/오버라이드 → `gateway.bind` → `loopback`                  |

### 핫 리로드 모드

| `gateway.reload.mode` | 동작                                |
| --------------------- | ----------------------------------- |
| `off`                 | 설정 리로드 없음                    |
| `hot`                 | 핫 세이프 변경만 적용               |
| `restart`             | 리로드 필요 변경 시 재시작          |
| `hybrid` (기본값)     | 안전할 때 핫 적용, 필요할 때 재시작 |

## 운영자 명령어 세트

```bash
openclaw gateway status
openclaw gateway status --deep
openclaw gateway status --json
openclaw gateway install
openclaw gateway restart
openclaw gateway stop
openclaw secrets reload
openclaw logs --follow
openclaw doctor
```

## 원격 접근

권장: Tailscale/VPN.
대안: SSH 터널.

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

그 다음 클라이언트에서 `ws://127.0.0.1:18789`로 로컬 연결합니다.

<Warning>
Gateway 인증이 설정된 경우, SSH 터널을 통하더라도 클라이언트는 인증(`token`/`password`)을 보내야 합니다.
</Warning>

참고: [원격 Gateway](/gateway/remote), [인증](/gateway/authentication), [Tailscale](/gateway/tailscale).

## 감독 및 서비스 수명주기

프로덕션 수준의 안정성을 위해 감독 실행을 사용합니다.

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

LaunchAgent 레이블은 `ai.openclaw.gateway` (기본) 또는 `ai.openclaw.<profile>` (지정된 프로필)입니다. `openclaw doctor`는 서비스 설정 드리프트를 감사하고 복구합니다.

  </Tab>

  <Tab title="Linux (systemd user)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

로그아웃 후에도 유지하려면 lingering을 활성화합니다:

```bash
sudo loginctl enable-linger <user>
```

  </Tab>

  <Tab title="Linux (system service)">

다중 사용자/상시 가동 호스트에는 시스템 유닛을 사용합니다.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

  </Tab>
</Tabs>

## 한 호스트에서 여러 Gateway 실행

대부분의 설정은 **하나의** Gateway로 충분합니다.
엄격한 격리/중복성이 필요한 경우에만 복수 실행합니다 (예: 복구 프로필).

인스턴스별 체크리스트:

- 고유한 `gateway.port`
- 고유한 `OPENCLAW_CONFIG_PATH`
- 고유한 `OPENCLAW_STATE_DIR`
- 고유한 `agents.defaults.workspace`

예시:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

참고: [여러 Gateway](/gateway/multiple-gateways).

### 개발 프로필 빠른 경로

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

기본값에는 격리된 상태/설정과 기본 Gateway 포트 `19001`이 포함됩니다.

## 프로토콜 빠른 참조 (운영자 관점)

- 첫 번째 클라이언트 프레임은 반드시 `connect`여야 합니다.
- Gateway는 `hello-ok` 스냅샷(`presence`, `health`, `stateVersion`, `uptimeMs`, 제한/정책)을 반환합니다.
- 요청: `req(method, params)` → `res(ok/payload|error)`.
- 주요 이벤트: `connect.challenge`, `agent`, `chat`, `presence`, `tick`, `health`, `heartbeat`, `shutdown`.

에이전트 실행은 2단계입니다:

1. 즉시 수락 확인 (`status:"accepted"`)
2. 최종 완료 응답 (`status:"ok"|"error"`), 그 사이에 스트리밍 `agent` 이벤트가 전송됩니다.

전체 프로토콜 문서 참고: [Gateway 프로토콜](/gateway/protocol).

## 운영 확인

### 활성 확인 (Liveness)

- WS를 열고 `connect`를 전송합니다.
- 스냅샷이 포함된 `hello-ok` 응답을 기대합니다.

### 준비 확인 (Readiness)

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### 갭 복구

이벤트는 재생되지 않습니다. 시퀀스 갭이 발생하면 계속하기 전에 상태(`health`, `system-presence`)를 새로고침합니다.

## 일반적인 실패 시그니처

| 시그니처                                                       | 가능한 원인                         |
| -------------------------------------------------------------- | ----------------------------------- |
| `refusing to bind gateway ... without auth`                    | 토큰/비밀번호 없이 비 루프백 바인드 |
| `another gateway instance is already listening` / `EADDRINUSE` | 포트 충돌                           |
| `Gateway start blocked: set gateway.mode=local`                | 원격 모드로 설정됨                  |
| `unauthorized` during connect                                  | 클라이언트와 Gateway 간 인증 불일치 |

전체 진단 절차는 [Gateway 문제 해결](/gateway/troubleshooting)을 참고하세요.

## 안전 보장

- Gateway 프로토콜 클라이언트는 Gateway를 사용할 수 없을 때 즉시 실패합니다 (암묵적 다이렉트 채널 폴백 없음).
- 유효하지 않거나 connect가 아닌 첫 프레임은 거부되고 종료됩니다.
- 정상 종료 시 소켓 닫기 전에 `shutdown` 이벤트를 발생시킵니다.

---

관련 문서:

- [문제 해결](/gateway/troubleshooting)
- [백그라운드 프로세스](/gateway/background-process)
- [설정](/gateway/configuration)
- [상태 확인](/gateway/health)
- [Doctor](/gateway/doctor)
- [인증](/gateway/authentication)
