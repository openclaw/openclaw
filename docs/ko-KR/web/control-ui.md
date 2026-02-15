---
summary: "Browser-based control UI for the Gateway (chat, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
x-i18n:
  source_hash: baaaf73820f0e703826d99fbd34f87a7b486376c80d581f664a1648dbc9bca4d
---

# 컨트롤 UI(브라우저)

Control UI는 게이트웨이에서 제공하는 작은 **Vite + Lit** 단일 페이지 앱입니다.

- 기본값 : `http://<host>:18789/`
- 선택적 접두사: `gateway.controlUi.basePath` 설정(예: `/openclaw`)

동일한 포트의 **Gateway WebSocket**에 직접 연결됩니다.

## 빠른 열기(로컬)

게이트웨이가 동일한 컴퓨터에서 실행 중인 경우 다음을 엽니다.

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (또는 [http://localhost:18789/](http://localhost:18789/))

페이지가 로드되지 않으면 먼저 게이트웨이를 시작하십시오: `openclaw gateway`.

인증은 WebSocket 핸드셰이크 중에 다음을 통해 제공됩니다.

- `connect.params.auth.token`
- `connect.params.auth.password`
  대시보드 설정 패널을 사용하면 토큰을 저장할 수 있습니다. 비밀번호는 유지되지 않습니다.
  온보딩 마법사는 기본적으로 게이트웨이 토큰을 생성하므로 처음 연결할 때 여기에 붙여넣습니다.

## 장치 페어링(첫 번째 연결)

새로운 브라우저나 장치에서 Control UI에 연결하면 게이트웨이
동일한 Tailnet에 있더라도 **일회성 페어링 승인**이 필요합니다.
`gateway.auth.allowTailscale: true`로. 방지하기 위한 보안 조치입니다.
무단 액세스.

**표시되는 내용:** "연결 끊김(1008): 페어링 필요"

**기기를 승인하려면:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

승인되면 기기가 기억되며 다음을 제외하면 재승인이 필요하지 않습니다.
`openclaw devices revoke --device <id> --role <role>`로 취소합니다. 참조
토큰 순환 및 취소를 위한 [Devices CLI](/cli/devices).

**참고:**

- 로컬 연결(`127.0.0.1`)이 자동 승인됩니다.
- 원격 연결(LAN, Tailnet 등)에는 명시적인 승인이 필요합니다.
- 각 브라우저 프로필은 고유한 장치 ID를 생성하므로 브라우저를 전환하거나
  브라우저 데이터를 지우려면 다시 페어링해야 합니다.

## 할 수 있는 것(오늘)

- 게이트웨이 WS를 통해 모델과 채팅 (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- 채팅의 스트리밍 도구 호출 + 라이브 도구 출력 카드(에이전트 이벤트)
- 채널: WhatsApp/Telegram/Discord/Slack + 플러그인 채널(Mattermost 등) 상태 + QR 로그인 + 채널별 구성 (`channels.status`, `web.login.*`, `config.patch`)
- 인스턴스: 존재 목록 + 새로 고침 (`system-presence`)
- 세션: 목록 + 세션별 사고/자세한 재정의(`sessions.list`, `sessions.patch`)
- 크론 작업: 목록/추가/실행/활성화/비활성화 + 실행 기록 (`cron.*`)
- 스킬: 상태, 활성화/비활성화, 설치, API 키 업데이트 (`skills.*`)
- 노드: 목록 + 대문자 (`node.list`)
- Exec 승인: 게이트웨이 또는 노드 허용 목록 편집 + `exec host=gateway/node` (`exec.approvals.*`)에 대한 정책 요청
- 구성: 보기/편집 `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- 구성: 적용 + 유효성 검사(`config.apply`)로 다시 시작하고 마지막 활성 세션 깨우기
- 구성 쓰기에는 동시 편집 방해를 방지하기 위한 기본 해시 가드가 포함됩니다.
- 구성 스키마 + 양식 렌더링(`config.schema`, 플러그인 + 채널 스키마 포함) 원시 JSON 편집기를 계속 사용할 수 있습니다.
- 디버그: 상태/상태/모델 스냅샷 + 이벤트 로그 + 수동 RPC 호출 (`status`, `health`, `models.list`)
- 로그: 필터/내보내기가 포함된 게이트웨이 파일 로그의 라이브 테일(`logs.tail`)
- 업데이트: 재시작 보고서와 함께 패키지/git 업데이트 + 재시작(`update.run`) 실행

크론 작업 패널 참고사항:

- 격리된 작업의 경우 기본적으로 요약을 알리는 것이 전달됩니다. 내부 전용 실행을 원하는 경우 없음으로 전환할 수 있습니다.
- 공지를 선택하면 채널/대상 필드가 나타납니다.

## 채팅 행동

- `chat.send`는 **비차단**입니다. `{ runId, status: "started" }`로 즉시 응답하고 응답은 `chat` 이벤트를 통해 스트리밍됩니다.
- 동일한 `idempotencyKey`로 다시 전송하면 실행 중에는 `{ status: "in_flight" }`가 반환되고 완료 후에는 `{ status: "ok" }`가 반환됩니다.
- `chat.inject`는 세션 기록에 보조 메모를 추가하고 UI 전용 업데이트(에이전트 실행 없음, 채널 전달 없음)에 대한 `chat` 이벤트를 브로드캐스트합니다.
- 중지:
  - **중지**를 클릭합니다(`chat.abort` 호출).
  - 대역 외를 중단하려면 `/stop`(또는 `stop|esc|abort|wait|exit|interrupt`)를 입력하세요.
  - `chat.abort`는 해당 세션에 대한 모든 활성 실행을 중단하기 위해 `{ sessionKey }` (`runId` 없음)을 지원합니다.

## 테일넷 액세스(권장)

### 통합 테일스케일 서브(선호)

게이트웨이를 루프백 상태로 유지하고 Tailscale Serve가 이를 HTTPS로 프록시하도록 합니다.

```bash
openclaw gateway --tailscale serve
```

열기:

- `https://<magicdns>/` (또는 구성한 `gateway.controlUi.basePath`)

기본적으로 서비스 요청은 Tailscale ID 헤더를 통해 인증할 수 있습니다.
(`tailscale-user-login`) `gateway.auth.allowTailscale`가 `true`일 때. 오픈클로
`x-forwarded-for` 주소를 확인하여 신원을 확인합니다.
`tailscale whois` 이를 헤더와 일치시키고,
요청이 Tailscale의 `x-forwarded-*` 헤더로 루프백에 도달합니다. 세트
`gateway.auth.allowTailscale: false` (또는 강제 `gateway.auth.mode: "password"`)
서비스 트래픽에도 토큰/비밀번호를 요구하려는 경우.

### tailnet + 토큰에 바인딩

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

그런 다음 다음을 엽니다.

- `http://<tailscale-ip>:18789/` (또는 구성한 `gateway.controlUi.basePath`)

토큰을 UI 설정에 붙여넣습니다(`connect.params.auth.token`로 전송됨).

## 안전하지 않은 HTTP

일반 HTTP(`http://<lan-ip>` 또는 `http://<tailscale-ip>`)를 통해 대시보드를 열면,
브라우저는 **비보안 컨텍스트**에서 실행되며 WebCrypto를 차단합니다. 기본적으로
OpenClaw는 장치 ID가 없는 제어 UI 연결을 **차단**합니다.

**권장 수정 사항:** HTTPS(Tailscale Serve)를 사용하거나 로컬에서 UI를 엽니다.

- `https://<magicdns>/` (서브)
- `http://127.0.0.1:18789/` (게이트웨이 호스트에서)

**다운그레이드 예(HTTP를 통한 토큰 전용):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

이렇게 하면 제어 UI에 대한 장치 ID + 페어링이 비활성화됩니다(HTTPS에서도 마찬가지). 사용
네트워크를 신뢰하는 경우에만.

HTTPS 설정 지침은 [Tailscale](/gateway/tailscale)을 참조하세요.

## UI 구축

게이트웨이는 `dist/control-ui`의 정적 파일을 제공합니다. 다음을 사용하여 빌드하세요.

```bash
pnpm ui:build # auto-installs UI deps on first run
```

선택적 절대 기반(고정 자산 URL을 원하는 경우):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

로컬 개발의 경우(별도의 개발 서버):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

그런 다음 게이트웨이 WS URL(예: `ws://127.0.0.1:18789`)에서 UI를 가리킵니다.

## 디버깅/테스트: 개발 서버 + 원격 게이트웨이

컨트롤 UI는 정적 파일입니다. WebSocket 대상은 구성 가능하며
HTTP 원본과 다릅니다. Vite 개발 서버를 원할 때 편리합니다.
로컬이지만 게이트웨이는 다른 곳에서 실행됩니다.

1. UI 개발 서버를 시작합니다: `pnpm ui:dev`
2. 다음과 같은 URL을 엽니다.

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

선택적 일회성 인증(필요한 경우):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

참고:

- `gatewayUrl`는 로드 후 localStorage에 저장되고 URL에서 제거됩니다.
- `token`는 localStorage에 저장됩니다. `password`은 메모리에만 보관됩니다.
- `gatewayUrl`가 설정되면 UI가 구성 또는 환경 자격 증명으로 대체되지 않습니다.
  `token`(또는 `password`)를 명시적으로 제공하세요. 명시적 자격 증명이 누락되면 오류가 발생합니다.
- 게이트웨이가 TLS(Tailscale Serve, HTTPS 프록시 등) 뒤에 있는 경우 `wss://`를 사용합니다.
- `gatewayUrl`는 클릭재킹을 방지하기 위해 최상위 창(포함되지 않음)에서만 허용됩니다.
- 교차 출처 개발 설정(예: 원격 게이트웨이에 대한 `pnpm ui:dev`)의 경우 UI를 추가합니다.
  원점은 `gateway.controlUi.allowedOrigins`입니다.

예:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

원격 접속 설정 내용: [원격 접속](/gateway/remote).
