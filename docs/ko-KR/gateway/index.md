---
summary: "Gateway 서비스, 라이프사이클 및 운영을 위한 실행 가이드"
read_when:
  - Gateway 프로세스를 실행하거나 디버깅할 때
title: "Gateway 실행 가이드"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/index.md
  workflow: 15
---

# Gateway 실행 가이드

Gateway 서비스의 1 일 시작과 2 일 운영을 위해 이 페이지를 사용합니다.

<CardGroup cols={2}>
  <Card title="심화 문제 해결" icon="siren" href="/ko-KR/gateway/troubleshooting">
    증상 기반 진단, 정확한 명령 단계 및 로그 서명.
  </Card>
  <Card title="구성" icon="sliders" href="/ko-KR/gateway/configuration">
    작업 기반 설정 가이드 및 전체 구성 참고.
  </Card>
  <Card title="암호 관리" icon="key-round" href="/ko-KR/gateway/secrets">
    SecretRef 계약, 런타임 스냅샷 동작 및 마이그레이션/재로드 작업.
  </Card>
  <Card title="암호 계획 계약" icon="shield-check" href="/ko-KR/gateway/secrets-plan-contract">
    정확한 `secrets apply` 대상/경로 규칙 및 참조 전용 인증 프로필 동작.
  </Card>
</CardGroup>

## 5 분 로컬 시작

<Steps>
  <Step title="Gateway 시작">

```bash
openclaw gateway --port 18789
# debug/trace 는 표준 출력으로 미러됨
openclaw gateway --port 18789 --verbose
# 선택한 포트의 리스너를 강제 종료한 후 시작
openclaw gateway --force
```

  </Step>

  <Step title="서비스 상태 확인">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

건강한 기준: `Runtime: running` 그리고 `RPC probe: ok`.

  </Step>

  <Step title="채널 준비 확인">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
Gateway 구성 재로드는 활성 구성 파일 경로를 감시합니다 (프로필/상태 기본값에서 확인됨, `OPENCLAW_CONFIG_PATH` 설정 시).
기본 모드는 `gateway.reload.mode="hybrid"`.
</Note>

## 런타임 모델

- 라우팅, 제어 평면 및 채널 연결을 위한 하나의 항상 켜진 프로세스.
- 다중화된 단일 포트:
  - WebSocket 제어/RPC
  - HTTP API (OpenAI 호환, Responses, 도구 호출)
  - 제어 UI 및 훅
- 기본 바인드 모드: `loopback`.
- 인증이 기본적으로 필요함 (`gateway.auth.token` / `gateway.auth.password`, 또는 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`).

### 포트 및 바인드 우선순위

| 설정         | 확인 순서                                                     |
| ------------ | ------------------------------------------------------------- |
| Gateway 포트 | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| 바인드 모드  | CLI/override → `gateway.bind` → `loopback`                    |

### 핫 리로드 모드

| `gateway.reload.mode` | 동작                              |
| --------------------- | --------------------------------- |
| `off`                 | 구성 재로드 없음                  |
| `hot`                 | 핫 안전 변경만 적용               |
| `restart`             | 재로드 필요 변경 시 재시작        |
| `hybrid` (기본값)     | 안전하면 핫 적용, 필요하면 재시작 |

## 운영자 명령 세트

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

## 원격 액세스

선호: Tailscale/VPN.
대체: SSH 터널.

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

그러면 클라이언트를 `ws://127.0.0.1:18789` 로컬에 연결합니다.

<Warning>
Gateway 인증이 구성된 경우, 클라이언트는 SSH 터널을 통해서도 인증 (`token`/`password`)을 보내야 합니다.
</Warning>

참고: [원격 Gateway](/ko-KR/gateway/remote), [인증](/ko-KR/gateway/authentication), [Tailscale](/ko-KR/gateway/tailscale).

## 감시 및 서비스 라이프사이클

프로덕션 같은 안정성을 위해 감시되는 실행을 사용합니다.

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

LaunchAgent 레이블은 `ai.openclaw.gateway` (기본값) 또는 `ai.openclaw.<profile>` (이름이 지정된 프로필). `openclaw doctor` 는 서비스 구성 편차를 감사하고 복구합니다.

  </Tab>

  <Tab title="Linux (systemd user)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

로그아웃 후에도 유지되도록 lingering 을 활성화합니다:

```bash
sudo loginctl enable-linger <user>
```

  </Tab>

  <Tab title="Linux (system service)">

다중 사용자/항상 켜진 호스트에는 시스템 유닛을 사용합니다.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

  </Tab>
</Tabs>

## 한 호스트에서 여러 Gateway

대부분의 설정은 **하나의** Gateway 를 실행해야 합니다.
엄격한 격리/중복성이 필요한 경우에만 여러 개를 사용합니다 (예: 복구 프로필).

각 인스턴스 체크리스트:

- 고유한 `gateway.port`
- 고유한 `OPENCLAW_CONFIG_PATH`
- 고유한 `OPENCLAW_STATE_DIR`
- 고유한 `agents.defaults.workspace`

예:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

참고: [여러 Gateway](/ko-KR/gateway/multiple-gateways).

### Dev 프로필 빠른 경로

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

기본값에는 격리된 상태/구성 및 기본 Gateway 포트 `19001` 이 포함됩니다.

## 프로토콜 빠른 참고 (운영자 보기)

- 첫 번째 클라이언트 프레임은 `connect` 여야 합니다.
- Gateway 는 `hello-ok` 스냅샷을 반환합니다 (`presence`, `health`, `stateVersion`, `uptimeMs`, 제한/정책).
- 요청: `req(method, params)` → `res(ok/payload|error)`.
- 일반 이벤트: `connect.challenge`, `agent`, `chat`, `presence`, `tick`, `health`, `heartbeat`, `shutdown`.

에이전트 실행은 2 단계입니다:

1. 즉시 수락 인정 (`status:"accepted"`)
2. 최종 완료 응답 (`status:"ok"|"error"`), 중간에 스트리밍된 `agent` 이벤트 포함.

전체 프로토콜 문서 보기: [Gateway 프로토콜](/ko-KR/gateway/protocol).

## 운영 확인

### 생존성

- WS 를 열고 `connect` 를 보냅니다.
- 스냅샷이 있는 `hello-ok` 응답을 예상합니다.

### 준비 상태

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### 간극 복구

이벤트는 재생되지 않습니다. 시퀀스 간격이 있으면 상태를 새로 고칩니다 (`health`, `system-presence`).

## 일반적인 실패 서명

| 서명                                                           | 가능한 문제                           |
| -------------------------------------------------------------- | ------------------------------------- |
| `refusing to bind gateway ... without auth`                    | 토큰/암호 없이 비 로컬호스트 바인드   |
| `another gateway instance is already listening` / `EADDRINUSE` | 포트 충돌                             |
| `Gateway start blocked: set gateway.mode=local`                | 원격 모드로 설정된 구성               |
| `unauthorized` 연결 중                                         | 클라이언트와 Gateway 간의 인증 불일치 |

전체 진단 단계는 [Gateway 문제 해결](/ko-KR/gateway/troubleshooting) 을 사용합니다.

## 안전 보장

- Gateway 프로토콜 클라이언트는 Gateway 를 사용할 수 없을 때 빠르게 실패합니다 (암묵적 직접 채널 대체 없음).
- 잘못되었거나 연결되지 않은 첫 번째 프레임은 거부되고 닫힙니다.
- 우아한 종료는 소켓 종료 전에 `shutdown` 이벤트를 발생시킵니다.

---

관련:

- [문제 해결](/ko-KR/gateway/troubleshooting)
- [백그라운드 프로세스](/ko-KR/gateway/background-process)
- [구성](/ko-KR/gateway/configuration)
- [상태](/ko-KR/gateway/health)
- [Doctor](/ko-KR/gateway/doctor)
- [인증](/ko-KR/gateway/authentication)
