---
summary: "브라우저 기반의 게이트웨이 제어 UI (채팅, 노드, 설정)"
read_when:
  - 브라우저에서 게이트웨이를 조작하고 싶을 때
  - SSH 터널 없이 Tailnet에 접근하고 싶을 때
title: "Control UI"
---

# Control UI (브라우저)

Control UI는 게이트웨이에서 제공하는 작은 **Vite + Lit** 싱글 페이지 앱입니다:

- 기본: `http://<host>:18789/`
- 선택적 경로 접두사: `gateway.controlUi.basePath` 설정 (예: `/openclaw`)

이 앱은 같은 포트에서 **게이트웨이 WebSocket으로 직접** 통신합니다.

## 빠른 열기 (로컬)

게이트웨이가 같은 컴퓨터에서 실행 중이라면, 아래 URL을 엽니다:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (또는 [http://localhost:18789/](http://localhost:18789/))

페이지가 로드되지 않으면, 먼저 게이트웨이를 시작하세요: `openclaw gateway`.

인증은 WebSocket 핸드셰이크 동안 제공됩니다:

- `connect.params.auth.token`
- `connect.params.auth.password`
  대시보드 설정 패널을 통해 토큰을 저장할 수 있으며, 비밀번호는 저장되지 않습니다.
  온보딩 마법사는 기본적으로 게이트웨이 토큰을 생성하므로 첫 연결 시 여기에 붙여넣으십시오.

## 디바이스 페어링 (첫 연결)

새 브라우저 또는 디바이스에서 Control UI에 연결할 때, 게이트웨이는 **한 번의 페어링 승인**이 필요합니다. 이는 `gateway.auth.allowTailscale: true`로 설정된 같은 Tailnet에 있을 때도 그렇습니다. 이는 무단 접근을 방지하기 위한 보안 조치입니다.

**보게 될 메시지:** "disconnected (1008): pairing required"

**디바이스를 승인하려면:**

```bash
# 대기 중인 요청 목록
openclaw devices list

# 요청 ID로 승인
openclaw devices approve <requestId>
```

승인이 되면, 해당 디바이스는 기억되며 `openclaw devices revoke --device <id> --role <role>` 명령어로 취소할 때까지 재승인이 필요하지 않습니다. 토큰 순환 및 취소에 대한 자세한 내용은 [Devices CLI](/ko-KR/cli/devices)를 참조하세요.

**주의사항:**

- 로컬 연결 (`127.0.0.1`)은 자동 승인됩니다.
- 원격 연결 (LAN, Tailnet 등)은 명시적 승인이 필요합니다.
- 각 브라우저 프로필은 고유한 디바이스 ID를 생성하므로 브라우저를 전환하거나 브라우저 데이터를 지우면 재-페어링이 필요합니다.

## 현재 가능한 기능

- 게이트웨이 WS를 통한 모델과의 채팅 (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- 도구 호출 스트리밍 + 채팅 내 라이브 도구 출력 카드 (에이전트 이벤트)
- 채널: WhatsApp/Telegram/Discord/Slack + 플러그인 채널 (Mattermost 등) 상태 + QR 로그인 + 채널별 설정 (`channels.status`, `web.login.*`, `config.patch`)
- 인스턴스: 존재 목록 + 새로 고침 (`system-presence`)
- 세션: 목록 + 세션별 생각/상세 모드 오버라이드 (`sessions.list`, `sessions.patch`)
- Cron 작업: 목록/추가/실행/활성화/비활성화 + 실행 기록 (`cron.*`)
- 스킬: 상태, 활성화/비활성화, 설치, API 키 업데이트 (`skills.*`)
- 노드: 목록 + 기능 (`node.list`)
- Exec 승인: 게이트웨이 또는 노드 허용 목록 편집 + `exec host=gateway/node` 정책 요청 (`exec.approvals.*`)
- 설정: `~/.openclaw/openclaw.json` 보기/편집 (`config.get`, `config.set`)
- 설정: 검증 후 적용 + 재시작 (`config.apply`) 및 마지막 활성 세션 깨우기
- 설정 기록에는 동시에 편집된 내용을 덮어쓰지 않도록 기본 해시 보호 기능 포함
- 설정 스키마 + 폼 렌더링 (`config.schema`, 플러그인 + 채널 스키마 포함); Raw JSON 편집기는 계속 사용 가능
- 디버그: 상태/건강/모델 스냅샷 + 이벤트 로그 + 수동 RPC 호출 (`status`, `health`, `models.list`)
- 로그: 게이트웨이 파일 로그의 실시간 출력 필터/내보내기 (`logs.tail`)
- 업데이트: 패키지/깃 업데이트 실행 + restart 보고서와 함께 재시작 (`update.run`)

Cron 작업 패널 주의사항:

- 독립된 작업의 경우, 기본적으로 요약을 알립니다. 내부 전용 실행을 원할 경우 '없음'으로 전환할 수 있습니다.
- 알림 모드에서 '배달 모드'를 "webhook"으로 설정하고 '배달 대상'을 유효한 HTTP(S) 웹훅 URL로 설정하세요.
- 주요 세션 작업의 경우 웹훅 및 없음 배달 모드가 가능합니다.
- `cron.webhookToken`을 설정하여 전용 베어러 토큰을 보낼 수 있으며, 생략 시 웹훅은 인증 헤더 없이 전송됩니다.
- 지원 중단된 대체 옵션: `notify: true`로 저장된 기존 작업은 이주가 완료될 때까지 여전히 `cron.webhook`을 사용할 수 있습니다.

## 채팅 동작

- `chat.send`는 **논블로킹**입니다: `{ runId, status: "started" }`로 즉시 응답되며, 응답은 `chat` 이벤트를 통해 스트리밍됩니다.
- 같은 `idempotencyKey`로 재전송하면 실행 중에는 `{ status: "in_flight" }`를, 완료 후에는 `{ status: "ok" }`를 반환합니다.
- `chat.history` 응답은 UI 안전을 위해 크기 제한이 있습니다. 전사 항목이 너무 클 경우 게이트웨이가 긴 텍스트 필드를 잘라낼 수 있으며 대형 메타데이터 블록을 생략하고 초과 크기의 메시지를 플레이스홀더 (`[chat.history omitted: message too large]`)로 대체할 수 있습니다.
- `chat.inject`는 세션 전사에 어시스턴트 노트를 추가하고 UI 전용 업데이트를 위한 `chat` 이벤트를 방송합니다 (에이전트 실행 없음, 채널 전달 없음).
- 중지:
  - **중지** 클릭 (호출 `chat.abort`)
  - `/stop` 입력 (또는 `stop|esc|abort|wait|exit|interrupt`) 하여 대역 외에서 중지
  - `chat.abort`는 `{ sessionKey }`(없음 `runId`)를 지원하여 해당 세션의 모든 활성 실행을 중단합니다.
- 부분 보존 중지:
  - 실행이 중단되면 부분적인 어시스턴트 텍스트가 UI에 여전히 표시될 수 있습니다.
  - 게이트웨이는 버퍼된 출력이 있을 경우 중단된 부분적인 어시스턴트 텍스트를 전사 기록에 저장합니다.
  - 저장된 항목은 중단 메타데이터를 포함하므로 전사 소비자들이 정상 완료 출력과 중단 부분을 구분할 수 있습니다.

## Tailnet 접속 (권장)

### 통합된 Tailscale Serve (선호)

게이트웨이를 로컬 루프백에 유지하고 Tailscale Serve가 HTTPS로 프록시하도록 합니다:

```bash
openclaw gateway --tailscale serve
```

아래를 열기:

- `https://<magicdns>/` (또는 설정된 `gateway.controlUi.basePath`)

기본적으로 Control UI/WebSocket Serve 요청은 `gateway.auth.allowTailscale`이 `true`일 때 Tailscale ID 헤더 (`tailscale-user-login`)를 통해 인증할 수 있습니다. OpenClaw는 `x-forwarded-for` 주소를 `tailscale whois`로 확인하고 헤더와 일치시키며, 요청이 Tailscale의 `x-forwarded-*` 헤더와 함께 루프백으로 도달할 경우에만 이를 수락합니다. Serve 트래픽에 대해서도 토큰/비밀번호가 필요하도록 하려면 `gateway.auth.allowTailscale: false`(또는 `gateway.auth.mode: "password"` 강제 설정)를 적용하세요.
토큰 없는 Serve 인증은 게이트웨이 호스트가 신뢰할 수 있다고 가정합니다. 신뢰할 수 없는 로컬 코드가 해당 호스트에서 실행될 수 있다면 토큰/비밀번호 인증을 요구하세요.

### Tailnet + 토큰 바인딩

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

그런 다음 여십시오:

- `http://<tailscale-ip>:18789/` (또는 구성된 `gateway.controlUi.basePath`)

UI 설정에 토큰을 붙여넣으십시오 (전송된 값: `connect.params.auth.token`).

## 보안되지 않은 HTTP

만약 평범한 HTTP(`http://<lan-ip>` 또는 `http://<tailscale-ip>`)로 대시보드를 열 경우, 브라우저는 **비보안 컨텍스트**에서 실행되며 WebCrypto를 차단합니다. 기본적으로 OpenClaw는 장치 ID 없이 Control UI 연결을 **차단**합니다.

**권장 수정:** HTTPS (Tailscale Serve) 사용 또는 로컬에서 UI 열기:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (게이트웨이 호스트에서)

**안전하지 않은 인증 토글 동작:**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`allowInsecureAuth`는 Control UI 장치 ID 또는 페어링 검사를 우회하지 않습니다.

**긴급시만 사용:**

```json5
{
  gateway: {
    controlUi: { dangerouslyDisableDeviceAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

`dangerouslyDisableDeviceAuth`는 Control UI 장치 ID 검사를 비활성화하며 심각한 보안 강등입니다. 긴급 사용 후 빠르게 되돌리세요.

HTTPS 설정 안내는 [Tailscale](/ko-KR/gateway/tailscale) 문서를 참조하세요.

## UI 빌드

게이트웨이는 `dist/control-ui`에서 정적 파일을 제공합니다. 다음 명령어로 빌드하십시오:

```bash
pnpm ui:build # 처음 실행 시 UI 종속성을 자동으로 설치합니다
```

고정 자산 URL이 필요한 경우 선택적 절대 기반:

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

로컬 개발을 위한 별도의 개발 서버:

```bash
pnpm ui:dev # 처음 실행 시 UI 종속성을 자동으로 설치합니다
```

그런 다음 UI를 게이트웨이 WS URL에 지정하십시오 (예: `ws://127.0.0.1:18789`).

## 디버깅/테스트: 개발 서버 + 원격 게이트웨이

Control UI는 정적 파일입니다; WebSocket 대상은 구성 가능하며 HTTP 원본과 다를 수 있습니다. 이는 Vite 개발 서버는 로컬에 두고 게이트웨이는 다른 곳에서 실행하고 싶을 때 유용합니다.

1. UI 개발 서버 시작: `pnpm ui:dev`
2. 아래와 같은 URL 열기:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

필요시 선택적 1회 인증:

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

주의사항:

- `gatewayUrl`은 로드 후 localStorage에 저장되고 URL에서 제거됩니다.
- `token`은 localStorage에 저장되며; `password`는 메모리에서만 유지됩니다.
- `gatewayUrl`이 설정되면, UI는 구성 또는 환경 자격 증명으로 되돌아가지 않습니다.
  `token` (또는 `password`)를 명시적으로 제공하십시오. 명시적인 자격 증명이 없으면 오류가 발생합니다.
- 게이트웨이가 TLS(Tailscale Serve, HTTPS 프록시 등) 뒤에 있을 때 `wss://`를 사용하세요.
- `gatewayUrl`은 클릭재킹을 방지하기 위해 최상위 창에서만 허용됩니다 (내장되지 않음).
- 크로스-오리진 개발 설정의 경우 (예: 원격 게이트웨이에 `pnpm ui:dev`), UI 기원을 `gateway.controlUi.allowedOrigins`에 추가하십시오.

예제:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

원격 접속 설정 상세: [Remote access](/ko-KR/gateway/remote).
