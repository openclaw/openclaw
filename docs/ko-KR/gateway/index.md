---
summary: "Runbook for the Gateway service, lifecycle, and operations"
read_when:
  - Running or debugging the gateway process
title: "Gateway Runbook"
x-i18n:
  source_hash: 245aa1e27db5a94a34621c12bb408774614b1b910f8b8aa5f5df71cc97fafdc7
---

# 게이트웨이 런북

게이트웨이 서비스의 1일차 시작 및 2일차 작업에 이 페이지를 사용하세요.

<CardGroup cols={2}>
  <Card title="Deep troubleshooting" icon="siren" href="/gateway/troubleshooting">
    정확한 명령 래더 및 로그 서명을 통한 증상 우선 진단.
  </Card>
  <Card title="Configuration" icon="sliders" href="/gateway/configuration">
    작업 중심 설정 가이드 + 전체 구성 참조.
  </Card>
</CardGroup>

## 5분 로컬 시작

<Steps>
  <Step title="Start the Gateway">

```bash
openclaw gateway --port 18789
# debug/trace mirrored to stdio
openclaw gateway --port 18789 --verbose
# force-kill listener on selected port, then start
openclaw gateway --force
```

  </Step>

  <Step title="Verify service health">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

정상 기준: `Runtime: running` 및 `RPC probe: ok`.

  </Step>

  <Step title="Validate channel readiness">

```bash
openclaw channels status --probe
```

  </Step>
</Steps>

<Note>
게이트웨이 구성 다시 로드는 활성 구성 파일 경로를 감시합니다(프로필/상태 기본값 또는 설정 시 `OPENCLAW_CONFIG_PATH`에서 확인됨).
기본 모드는 `gateway.reload.mode="hybrid"`입니다.
</Note>

## 런타임 모델

- 라우팅, 제어 평면 및 채널 연결을 위한 하나의 상시 실행 프로세스입니다.
- 다음을 위한 단일 다중화 포트:
  - 웹소켓 제어/RPC
  - HTTP API(OpenAI 호환, 응답, 도구 호출)
  - 제어 UI 및 후크
- 기본 바인딩 모드: `loopback`.
- 기본적으로 인증이 필요합니다(`gateway.auth.token` / `gateway.auth.password` 또는 `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`).

### 포트 및 바인드 우선순위

| 설정            | 해결 순서                                                     |
| --------------- | ------------------------------------------------------------- |
| 게이트웨이 포트 | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| 바인드 모드     | CLI/재정의 → `gateway.bind` → `loopback`                      |

### 핫 리로드 모드

| `gateway.reload.mode` | 행동                                      |
| --------------------- | ----------------------------------------- |
| `off`                 | 구성을 다시 로드하지 않음                 |
| `hot`                 | 핫세이프 변경사항만 적용                  |
| `restart`             | 다시 로드해야 하는 변경사항 시 다시 시작  |
| `hybrid` (기본값)     | 안전할 때 핫 적용하고 필요할 때 다시 시작 |

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

그런 다음 클라이언트를 `ws://127.0.0.1:18789`에 로컬로 연결합니다.

<Warning>
게이트웨이 인증이 구성된 경우 클라이언트는 SSH 터널을 통해서도 인증(`token`/`password`)을 계속 보내야 합니다.
</Warning>

참조: [원격 게이트웨이](/gateway/remote), [인증](/gateway/authentication), [Tailscale](/gateway/tailscale).

## 감독 및 서비스 수명주기

프로덕션과 유사한 안정성을 위해 감독 실행을 사용합니다.

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

LaunchAgent 레이블은 `ai.openclaw.gateway`(기본값) 또는 `ai.openclaw.<profile>`(명명된 프로필)입니다. `openclaw doctor`는 서비스 구성 드리프트를 감사하고 복구합니다.

  </Tab>

  <Tab title="Linux (systemd user)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

로그아웃 후에도 지속성을 유지하려면 느린 시간을 활성화하세요.

```bash
sudo loginctl enable-linger <user>
```

  </Tab>

  <Tab title="Linux (system service)">

다중 사용자/상시 접속 호스트를 위한 시스템 장치를 사용합니다.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

  </Tab>
</Tabs>

## 하나의 호스트에 여러 게이트웨이

대부분의 설정에서는 **하나** 게이트웨이를 실행해야 합니다.
엄격한 격리/중복성을 위해서만 다중을 사용하십시오(예: 복구 프로필).

인스턴스별 체크리스트:

- 고유 `gateway.port`
- 고유 `OPENCLAW_CONFIG_PATH`
- 고유 `OPENCLAW_STATE_DIR`
- 고유 `agents.defaults.workspace`

예:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

[다중 게이트웨이](/gateway/multiple-gateways)를 참조하세요.

### 개발자 프로필 빠른 경로

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

기본값에는 격리 상태/구성 및 기본 게이트웨이 포트 `19001`가 포함됩니다.

## 프로토콜 빠른 참조(운영자 보기)

- 첫 번째 클라이언트 프레임은 `connect`이어야 합니다.
- 게이트웨이는 `hello-ok` 스냅샷(`presence`, `health`, `stateVersion`, `uptimeMs`, 제한/정책)을 반환합니다.
- 요청: `req(method, params)` → `res(ok/payload|error)`.
- 공통 이벤트: `connect.challenge`, `agent`, `chat`, `presence`, `tick`, `health`, `heartbeat`, `shutdown`.

에이전트 실행은 2단계로 이루어집니다.

1. 즉시 승인된 승인(`status:"accepted"`)
2. 최종 완료 응답(`status:"ok"|"error"`), 스트리밍된 `agent` 이벤트가 사이에 있습니다.

전체 프로토콜 문서를 참조하세요: [게이트웨이 프로토콜](/gateway/protocol).

## 작동 점검

### 활성

- WS를 열고 `connect`를 보냅니다.
- 스냅샷으로 `hello-ok` 응답을 기대합니다.

### 준비 상태

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### 격차 회복

이벤트는 재생되지 않습니다. 시퀀스 간격이 있는 경우 계속하기 전에 상태(`health`, `system-presence`)를 새로 고칩니다.

## 일반적인 실패 서명

| 서명                                                           | 예상되는 문제                            |
| -------------------------------------------------------------- | ---------------------------------------- |
| `refusing to bind gateway ... without auth`                    | 토큰/비밀번호가 없는 비루프백 바인딩     |
| `another gateway instance is already listening` / `EADDRINUSE` | 포트 충돌                                |
| `Gateway start blocked: set gateway.mode=local`                | 원격 모드로 설정된 구성                  |
| 연결 중 `unauthorized`                                         | 클라이언트와 게이트웨이 간의 인증 불일치 |

전체 진단 사다리를 보려면 [게이트웨이 문제 해결](/gateway/troubleshooting)을 사용하십시오.

## 안전 보장

- 게이트웨이를 사용할 수 없는 경우 게이트웨이 프로토콜 클라이언트가 빠르게 실패합니다(암시적 직접 채널 대체 없음).
- 유효하지 않거나 연결되지 않은 첫 번째 프레임은 거부되고 닫힙니다.
- 정상 종료는 소켓이 닫히기 전에 `shutdown` 이벤트를 발생시킵니다.

---

관련 항목:

- [문제 해결](/gateway/troubleshooting)
- [백그라운드 프로세스](/gateway/background-process)
- [구성](/gateway/configuration)
- [건강](/gateway/health)
- [의사](/gateway/doctor)
- [인증](/gateway/authentication)
