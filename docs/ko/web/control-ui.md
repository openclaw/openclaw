---
read_when:
    - 브라우저에서 게이트웨이를 작동하고 싶습니다.
    - SSH 터널 없이 Tailnet 액세스를 원합니다.
summary: 게이트웨이(채팅, 노드, 구성)에 대한 브라우저 기반 제어 UI
title: 컨트롤 UI
x-i18n:
    generated_at: "2026-02-08T16:13:57Z"
    model: gtx
    provider: google-translate
    source_hash: baaaf73820f0e703826d99fbd34f87a7b486376c80d581f664a1648dbc9bca4d
    source_path: web/control-ui.md
    workflow: 15
---

# 컨트롤 UI(브라우저)

컨트롤 UI는 작습니다. **Vite + 조명** 게이트웨이에서 제공하는 단일 페이지 앱:

- 기본: `http://<host>:18789/`
- 선택적 접두사: 설정 `gateway.controlUi.basePath` (예: `/openclaw`)

그것은 말한다 **게이트웨이 WebSocket에 직접** 같은 포트에.

## 빠른 열기(로컬)

게이트웨이가 동일한 컴퓨터에서 실행 중인 경우 다음을 엽니다.

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (또는 [http://localhost:18789/](http://localhost:18789/))

페이지가 로드되지 않으면 먼저 게이트웨이를 시작하십시오. `openclaw gateway`.

인증은 WebSocket 핸드셰이크 중에 다음을 통해 제공됩니다.

- `connect.params.auth.token`
- `connect.params.auth.password`
  대시보드 설정 패널을 사용하면 토큰을 저장할 수 있습니다. 비밀번호는 유지되지 않습니다.
  온보딩 마법사는 기본적으로 게이트웨이 토큰을 생성하므로 처음 연결할 때 여기에 붙여넣습니다.

## 장치 페어링(첫 번째 연결)

새로운 브라우저나 장치에서 Control UI에 연결하면 게이트웨이
필요하다 **일회성 페어링 승인** — 동일한 Tailnet에 있더라도
와 `gateway.auth.allowTailscale: true`. 방지하기 위한 보안 조치입니다.
무단 액세스.

**당신이 볼 수 있는 것:** "연결 끊김(1008): 페어링 필요"

**장치를 승인하려면:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

승인되면 기기가 기억되며 다음을 제외하면 재승인이 필요하지 않습니다.
당신은 그것을 취소 `openclaw devices revoke --device <id> --role <role>`. 보다
[장치 CLI](/cli/devices) 토큰 순환 및 해지를 위해.

**참고:**

- 로컬 연결(`127.0.0.1`)은 자동으로 승인됩니다.
- 원격 연결(LAN, Tailnet 등)에는 명시적인 승인이 필요합니다.
- 각 브라우저 프로필은 고유한 장치 ID를 생성하므로 브라우저를 전환하거나
  브라우저 데이터를 지우려면 다시 페어링해야 합니다.

## 할 수 있는 일(오늘)

- Gateway WS를 통해 모델과 채팅(`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- 도구 통화 스트리밍 + Chat의 라이브 도구 출력 카드(에이전트 이벤트)
- 채널: WhatsApp/Telegram/Discord/Slack + 플러그인 채널(Mattermost 등) 상태 + QR 로그인 + 채널별 구성(`channels.status`, `web.login.*`, `config.patch`)
- 인스턴스: 현재 상태 목록 + 새로 고침(`system-presence`)
- 세션: 목록 + 세션별 사고/장황한 재정의(`sessions.list`, `sessions.patch`)
- 크론 작업: 목록/추가/실행/활성화/비활성화 + 실행 기록(`cron.*`)
- 기술: 상태, 활성화/비활성화, 설치, API 키 업데이트(`skills.*`)
- 노드: 목록 + 대문자(`node.list`)
- Exec 승인: 게이트웨이 또는 노드 허용 목록 편집 + 정책 요청 `exec host=gateway/node` (`exec.approvals.*`)
- 구성: 보기/편집 `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- 구성: 유효성 검사를 통해 적용 + 다시 시작(`config.apply`) 마지막 활성 세션을 깨웁니다.
- 구성 쓰기에는 동시 편집 방해를 방지하기 위한 기본 해시 가드가 포함됩니다.
- 구성 스키마 + 양식 렌더링(`config.schema`, 플러그인 + 채널 스키마 포함); 원시 JSON 편집기를 계속 사용할 수 있습니다.
- 디버그: 상태/상태/모델 스냅샷 + 이벤트 로그 + 수동 RPC 호출(`status`, `health`, `models.list`)
- 로그: 필터/내보내기가 포함된 게이트웨이 파일 로그의 실시간 테일(`logs.tail`)
- 업데이트: 패키지/git 업데이트 실행 + 다시 시작(`update.run`) 재시작 보고서 포함

크론 작업 패널 참고사항:

- 격리된 작업의 경우 기본적으로 요약을 알리는 것이 전달됩니다. 내부 전용 실행을 원하는 경우 없음으로 전환할 수 있습니다.
- 공지를 선택하면 채널/대상 필드가 나타납니다.

## 채팅 행동

- `chat.send` ~이다 **비차단**: 즉시 응답합니다. `{ runId, status: "started" }` 응답 스트림은 다음을 통해 이루어집니다. `chat` 이벤트.
- 같은 내용으로 재전송 `idempotencyKey` 보고 `{ status: "in_flight" }` 달리는 동안 그리고 `{ status: "ok" }` 완료 후.
- `chat.inject` 세션 기록에 보조 메모를 추가하고 방송합니다. `chat` UI 전용 업데이트에 대한 이벤트(에이전트 실행 없음, 채널 전달 없음)
- 멈추다:
  - 딸깍 하는 소리 **멈추다** (전화 `chat.abort`)
  - 유형 `/stop` (또는 `stop|esc|abort|wait|exit|interrupt`) 대역 외 중단
  - `chat.abort` 지원하다 `{ sessionKey }` (아니요 `runId`) 해당 세션에 대한 모든 활성 실행을 중단하려면

## 테일넷 액세스(권장)

### 통합 테일스케일 서브(선호)

게이트웨이를 루프백 상태로 유지하고 Tailscale Serve가 이를 HTTPS로 프록시하도록 합니다.

```bash
openclaw gateway --tailscale serve
```

열려 있는:

- `https://<magicdns>/` (또는 구성한 `gateway.controlUi.basePath`)

기본적으로 서비스 요청은 Tailscale ID 헤더를 통해 인증할 수 있습니다.
(`tailscale-user-login`) 언제 `gateway.auth.allowTailscale` ~이다 `true`. 오픈클로
문제를 해결하여 신원을 확인합니다. `x-forwarded-for` 주소
`tailscale whois` 이를 헤더와 일치시키고 다음과 같은 경우에만 이를 허용합니다.
요청이 Tailscale의 루프백에 도달함 `x-forwarded-*` 헤더. 세트
`gateway.auth.allowTailscale: false` (또는 강제로 `gateway.auth.mode: "password"`)
서비스 트래픽에도 토큰/비밀번호를 요구하려는 경우.

### tailnet + 토큰에 바인딩

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

그런 다음 다음을 엽니다.

- `http://<tailscale-ip>:18789/` (또는 구성한 `gateway.controlUi.basePath`)

토큰을 UI 설정에 붙여넣습니다(다음으로 전송됨). `connect.params.auth.token`).

## 안전하지 않은 HTTP

일반 HTTP(`http://<lan-ip>` 또는 `http://<tailscale-ip>`),
브라우저는 다음에서 실행됩니다. **비보안 컨텍스트** WebCrypto를 차단합니다. 기본적으로
오픈클로 **블록** 장치 ID 없이 UI 연결을 제어합니다.

**권장 수정사항:** HTTPS(Tailscale Serve)를 사용하거나 로컬에서 UI를 엽니다.

- `https://<magicdns>/` (제공하다)
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

보다 [테일스케일](/gateway/tailscale) HTTPS 설정 지침을 확인하세요.

## UI 구축

게이트웨이는 다음에서 정적 파일을 제공합니다. `dist/control-ui`. 다음을 사용하여 빌드하세요.

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

그런 다음 게이트웨이 WS URL에서 UI를 가리킵니다(예: `ws://127.0.0.1:18789`).

## 디버깅/테스트: 개발 서버 + 원격 게이트웨이

컨트롤 UI는 정적 파일입니다. WebSocket 대상은 구성 가능하며
HTTP 원본과 다릅니다. Vite 개발 서버를 원할 때 편리합니다.
로컬이지만 게이트웨이는 다른 곳에서 실행됩니다.

1. UI 개발 서버를 시작합니다. `pnpm ui:dev`
2. 다음과 같은 URL을 엽니다.

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

선택적 일회성 인증(필요한 경우):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

참고:

- `gatewayUrl` 로드 후 localStorage에 저장되고 URL에서 제거됩니다.
- `token` localStorage에 저장됩니다. `password` 메모리에만 보관됩니다.
- 언제 `gatewayUrl` 설정되면 UI는 구성 또는 환경 자격 증명으로 대체되지 않습니다.
  제공하다 `token` (또는 `password`) 명시적으로. 명시적 자격 증명이 누락되면 오류가 발생합니다.
- 사용 `wss://` 게이트웨이가 TLS(Tailscale Serve, HTTPS 프록시 등) 뒤에 있는 경우.
- `gatewayUrl` 클릭재킹을 방지하기 위해 최상위 창(포함되지 않음)에서만 허용됩니다.
- 교차 출처 개발 설정의 경우(예: `pnpm ui:dev` 원격 게이트웨이에) UI를 추가합니다.
  원산지 `gateway.controlUi.allowedOrigins`.

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

원격 액세스 설정 세부정보: [원격 액세스](/gateway/remote).
