---
summary: "게이트웨이 서비스의 실행 계획, 라이프사이클 및 운영에 대한 런북"
read_when:
  - 게이트웨이 프로세스를 실행하거나 디버깅할 때
title: "게이트웨이 런북"
---

# 게이트웨이 런북

이 페이지는 게이트웨이 서비스의 초기 시작 및 두 번째 단계 운영에 사용됩니다.

<CardGroup cols={2}>
  <Card title="심층 문제 해결" icon="siren" href="/ko-KR/gateway/troubleshooting">
    증상 중심의 진단, 명확한 명령어 단계 및 로그 특성.
  </Card>
  <Card title="설정" icon="sliders" href="/ko-KR/gateway/configuration">
    작업 지향 설정 가이드 + 전체 설정 참조.
  </Card>
</CardGroup>

## 5분 내 로컬 시작

<Steps>
  <Step title="게이트웨이 시작">

```bash
openclaw gateway --port 18789
# debug/trace mirrored to stdio
openclaw gateway --port 18789 --verbose
# force-kill listener on selected port, then start
openclaw gateway --force
```

  </Step>

  <Step title="서비스 상태 확인">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

건강한 기준선: `Runtime: running` 그리고 `RPC probe: ok`.

  </Step>

  <Step title="채널 준비 상태 확인">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
게이트웨이 설정 리로드는 활성 설정 파일 경로(프로파일/상태 기본값에서 해결되거나 `OPENCLAW_CONFIG_PATH`로 설정된 경로)를 감시합니다.
기본 모드는 `gateway.reload.mode="hybrid"`입니다.
</Note>

## 런타임 모델

- 항상 실행되는 프로세스로 라우팅, 제어 평면 및 채널 연결을 처리.
- 다음을 위한 단일 멀티플렉스 포트:
  - WebSocket 제어/RPC
  - HTTP APIs (OpenAI 호환, 응답, 도구 호출)
  - 제어 UI 및 훅
- 기본 바인드 모드: `로컬 루프백`.
- 인증은 기본적으로 필요(`gateway.auth.token` / `gateway.auth.password`, 또는 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`).

### 포트 및 바인드 우선순위

| 설정         | 해결 순서                                                       |
| ------------ | ------------------------------------------------------------- |
| 게이트웨이 포트 | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| 바인드 모드    | CLI/override → `gateway.bind` → `로컬 루프백`               |

### 핫 리로드 모드

| `gateway.reload.mode` | 동작                                            |
| --------------------- | ------------------------------------------ |
| `off`                 | 설정 리로드 안 함                                |
| `hot`                 | 핫-세이프한 변경 만 적용                         |
| `restart`             | 리로드가 필요한 변경 시 재시작                      |
| `hybrid` (기본)       | 안전할 때 핫 적용, 필요 시 재시작                 |

## 운영자 명령 세트

```bash
openclaw gateway status
openclaw gateway status --deep
openclaw gateway status --json
openclaw gateway install
openclaw gateway restart
openclaw gateway stop
openclaw logs --follow
openclaw doctor
```

## 원격 액세스

선호: Tailscale/VPN.
대체: SSH 터널.

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

그런 다음 클라이언트를 로컬에서 `ws://127.0.0.1:18789`에 연결합니다.

<Warning>
게이트웨이 인증이 설정된 경우, 클라이언트는 SSH 터널을 통해서도 인증(`token`/`password`)을 보내야 합니다.
</Warning>

참조: [원격 게이트웨이](/ko-KR/gateway/remote), [인증](/ko-KR/gateway/authentication), [Tailscale](/ko-KR/gateway/tailscale).

## 감시 및 서비스 라이프사이클

상용 환경과 유사한 신뢰성을 위해 감시 실행을 사용하십시오.

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

LaunchAgent 레이블은 기본적으로 `ai.openclaw.gateway` 이며, 이름이 지정된 프로파일일 경우 `ai.openclaw.<profile>`. `openclaw doctor`는 서비스 설정 드리프트를 검사 및 수정합니다.

  </Tab>

  <Tab title="Linux (systemd user)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

로그아웃 후에도 지속적으로 유지하려면, 잔류를 활성화하십시오:

```bash
sudo loginctl enable-linger <user>
```

  </Tab>

  <Tab title="Linux (system service)">

다중 사용자 및 항상 켜져 있는 호스트를 위해 시스템 단위를 사용하십시오.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

  </Tab>
</Tabs>

## 하나의 호스트에 여러 게이트웨이

대부분의 설정은 **하나의** 게이트웨이를 실행해야 합니다.
엄격한 격리 또는 중복성을 위해 여러 게이트웨이를 사용할 수 있습니다 (예: 구출 프로필).

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

참조: [여러 게이트웨이](/ko-KR/gateway/multiple-gateways).

### Dev 프로필 빠른 경로

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

기본값에는 격리된 상태/설정과 기본 게이트웨이 포트 `19001`이 포함되어 있습니다.

## 프로토콜 빠른 참조 (운영자 관점)

- 클라이언트의 첫 프레임은 `connect` 여야 합니다.
- 게이트웨이는 `hello-ok` 스냅샷(`presence`, `health`, `stateVersion`, `uptimeMs`, 제한/정책)을 반환합니다.
- 요청: `req(method, params)` → `res(ok/payload|error)`.
- 일반 이벤트: `connect.challenge`, `agent`, `chat`, `presence`, `tick`, `health`, `heartbeat`, `shutdown`.

에이전트 실행은 두 단계로 진행됩니다:

1. 즉각적인 수락 확인 (`status:"accepted"`)
2. 최종 완료 응답 (`status:"ok"|"error"`), 중간에 스트리밍된 `agent` 이벤트 포함.

전체 프로토콜 문서 참조: [게이트웨이 프로토콜](/ko-KR/gateway/protocol).

## 운영 점검

### 활성 상태 확인

- WS를 열고 `connect`를 전송합니다.
- 스냅샷과 함께 `hello-ok` 응답을 기대합니다.

### 준비 상태 확인

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### 간극 복구

이벤트는 재생되지 않습니다. 시퀀스 간극이 발생하면 상태(`health`, `system-presence`)를 갱신한 후 계속합니다.

## 일반적인 실패 시그니처

| 시그니처                                                      | 가능성 있는 문제                             |
| -------------------------------------------------------------- | ---------------------------------------- |
| `refusing to bind gateway ... without auth`                    | 인증 정보가 없는 비-로컬 루프백 바인드       |
| `another gateway instance is already listening` / `EADDRINUSE` | 포트 충돌                            |
| `Gateway start blocked: set gateway.mode=local`                | 원격 모드로 설정된 구성                |
| `unauthorized` during connect                                  | 클라이언트와 게이트웨이 간의 인증 불일치 |

전체 진단 단계는 [게이트웨이 문제 해결](/ko-KR/gateway/troubleshooting)을 참조하십시오.

## 안전 보장

- 게이트웨이 프로토콜 클라이언트는 게이트웨이를 사용할 수 없을 때 빠르게 실패합니다(암시적인 직접 채널 백업 없음).
- 잘못된 메시지나 연결이 아닌 첫 프레임은 거부되고 소켓이 닫힙니다.
- 정상적인 종료: 소켓 닫힘 전 `shutdown` 이벤트 발생.

---

관련 항목:

- [문제 해결](/ko-KR/gateway/troubleshooting)
- [백그라운드 프로세스](/ko-KR/gateway/background-process)
- [설정](/ko-KR/gateway/configuration)
- [건강](/ko-KR/gateway/health)
- [의사](/ko-KR/gateway/doctor)
- [인증](/ko-KR/gateway/authentication)