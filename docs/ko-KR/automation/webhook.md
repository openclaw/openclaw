---
summary: "Webhook ingress for wake and isolated agent runs"
read_when:
  - Adding or changing webhook endpoints
  - Wiring external systems into OpenClaw
title: "Webhooks"
x-i18n:
  source_hash: dfc1500908fb496e5e5f9e63c3596d081af6d7b03c5401d4432d234b078817e1
---

# 웹훅

게이트웨이는 외부 트리거를 위한 작은 HTTP 웹훅 엔드포인트를 노출할 수 있습니다.

## 활성화

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    // Optional: restrict explicit `agentId` routing to this allowlist.
    // Omit or include "*" to allow any agent.
    // Set [] to deny all explicit `agentId` routing.
    allowedAgentIds: ["hooks", "main"],
  },
}
```

참고:

- `hooks.token`는 `hooks.enabled=true`일 때 필요합니다.
- `hooks.path`의 기본값은 `/hooks`입니다.

## 인증

모든 요청에는 후크 토큰이 포함되어야 합니다. 헤더 선호:

- `Authorization: Bearer <token>` (권장)
- `x-openclaw-token: <token>`
- 쿼리 문자열 토큰이 거부됩니다(`?token=...`는 `400`를 반환합니다).

## 엔드포인트

### `POST /hooks/wake`

페이로드:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **필수** (문자열): 이벤트에 대한 설명(예: "새 이메일 수신").
- `mode` 선택 사항 (`now` | `next-heartbeat`): 즉시 하트비트를 트리거할지(기본값 `now`) 또는 다음 정기 검사를 기다릴지 여부.

효과:

- **기본** 세션에 대한 시스템 이벤트를 대기열에 넣습니다.
- `mode=now`인 경우 즉시 하트비트를 트리거합니다.

### `POST /hooks/agent`

페이로드:

```json
{
  "message": "Run this",
  "name": "Email",
  "agentId": "hooks",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **필수** (문자열) : 에이전트가 처리할 프롬프트 또는 메시지입니다.
- `name` 선택 사항(문자열): 사람이 읽을 수 있는 후크 이름(예: "GitHub"), 세션 요약에서 접두사로 사용됩니다.
- `agentId` 선택 사항(문자열): 이 후크를 특정 에이전트로 라우팅합니다. 알 수 없는 ID는 기본 에이전트로 대체됩니다. 설정되면 확인된 에이전트의 작업공간 및 구성을 사용하여 후크가 실행됩니다.
- `sessionKey` 선택사항(문자열): 에이전트의 세션을 식별하는 데 사용되는 키입니다. 기본적으로 이 필드는 `hooks.allowRequestSessionKey=true`가 아닌 이상 거부됩니다.
- `wakeMode` 선택 사항 (`now` | `next-heartbeat`): 즉시 하트비트를 트리거할지(기본값 `now`) 아니면 다음 주기적인 확인을 기다릴지 여부.
- `deliver` 선택사항(부울): `true`인 경우 에이전트의 응답이 메시징 채널로 전송됩니다. 기본값은 `true`입니다. 하트비트 승인만 있는 응답은 자동으로 건너뜁니다.
- `channel` 선택사항(문자열): 전달을 위한 메시징 채널입니다. 다음 중 하나: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (플러그인), `signal`, `imessage`, `msteams`. 기본값은 `last`입니다.
- `to` 선택사항(문자열): 채널의 수신자 식별자(예: WhatsApp/Signal의 전화번호, Telegram의 채팅 ID, Discord/Slack/Mattermost(플러그인)의 채널 ID, MS Teams의 대화 ID). 기본 세션의 마지막 수신자가 기본값입니다.
- `model` 선택 사항(문자열): 모델 재정의(예: `anthropic/claude-3-5-sonnet` 또는 별칭). 제한된 경우 허용 모델 목록에 있어야 합니다.
- `thinking` 선택 사항(문자열): 사고 수준 재정의(예: `low`, `medium`, `high`).
- `timeoutSeconds` 선택사항(숫자): 에이전트 실행의 최대 기간(초)입니다.

효과:

- **격리된** 에이전트 차례 실행(자체 세션 키)
- 항상 **메인** 세션에 요약을 게시합니다.
- `wakeMode=now`인 경우 즉시 하트비트를 트리거합니다.

## 세션 키 정책(브레이킹 체인지)

`/hooks/agent` 페이로드 `sessionKey` 재정의는 기본적으로 비활성화되어 있습니다.

- 권장 사항: 고정된 `hooks.defaultSessionKey`를 설정하고 요청 재정의를 유지합니다.
- 선택 사항: 필요한 경우에만 요청 재정의를 허용하고 접두사를 제한합니다.

권장 구성:

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
  },
}
```

호환성 구성(레거시 동작):

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:"], // strongly recommended
  },
}
```

### `POST /hooks/<name>` (매핑됨)

사용자 정의 후크 이름은 `hooks.mappings`를 통해 확인됩니다(구성 참조). 매핑은 다음과 같습니다.
선택적 템플릿을 사용하여 임의의 페이로드를 `wake` 또는 `agent` 작업으로 변환합니다.
코드가 변환됩니다.

매핑 옵션(요약):

- `hooks.presets: ["gmail"]`는 내장된 Gmail 매핑을 활성화합니다.
- `hooks.mappings`를 사용하면 구성에서 `match`, `action` 및 템플릿을 정의할 수 있습니다.
- `hooks.transformsDir` + `transform.module`는 사용자 정의 로직을 위한 JS/TS 모듈을 로드합니다.
- `match.source`을 사용하여 일반 수집 엔드포인트(페이로드 기반 라우팅)를 유지합니다.
- TS 변환에는 런타임 시 TS 로더(예: `bun` 또는 `tsx`) 또는 사전 컴파일된 `.js`가 필요합니다.
- 매핑에 `deliver: true` + `channel`/`to`를 설정하여 답변을 채팅 화면으로 라우팅합니다.
  (`channel`의 기본값은 `last`이며 WhatsApp으로 대체됩니다.)
- `agentId` 후크를 특정 에이전트로 라우팅합니다. 알 수 없는 ID는 기본 에이전트로 대체됩니다.
- `hooks.allowedAgentIds`는 명시적인 `agentId` 라우팅을 제한합니다. 모든 에이전트를 허용하려면 생략(또는 `*` 포함)하세요. 명시적인 `agentId` 라우팅을 거부하려면 `[]`를 설정하세요.
- `hooks.defaultSessionKey`는 명시적 키가 제공되지 않은 경우 후크 에이전트 실행에 대한 기본 세션을 설정합니다.
- `hooks.allowRequestSessionKey`는 `/hooks/agent` 페이로드가 `sessionKey`를 설정할 수 있는지 여부를 제어합니다(기본값: `false`).
- `hooks.allowedSessionKeyPrefixes`는 선택적으로 요청 페이로드 및 매핑에서 명시적인 `sessionKey` 값을 제한합니다.
- `allowUnsafeExternalContent: true` 해당 후크에 대한 외부 콘텐츠 안전 래퍼를 비활성화합니다.
  (위험합니다. 신뢰할 수 있는 내부 소스에만 해당).
- `openclaw webhooks gmail setup`는 `openclaw webhooks gmail run`에 대한 `hooks.gmail` 구성을 작성합니다.
  전체 Gmail 시청 흐름은 [Gmail Pub/Sub](/automation/gmail-pubsub)를 참조하세요.

## 응답

- `200` for `/hooks/wake`
- `202` for `/hooks/agent` (비동기 실행 시작됨)
- 인증 실패 시 `401`
- `429` 동일한 클라이언트에서 반복적으로 인증 실패 후(`Retry-After` 확인)
- 유효하지 않은 페이로드의 경우 `400`
- `413` 대형 페이로드

## 예

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### 다른 모델 사용

해당 실행에 대한 모델을 재정의하려면 에이전트 페이로드(또는 매핑)에 `model`를 추가하세요.

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

`agents.defaults.models`을 적용하는 경우 재정의 모델이 포함되어 있는지 확인하세요.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## 보안

- 루프백, 테일넷 또는 신뢰할 수 있는 역방향 프록시 뒤에 후크 엔드포인트를 유지합니다.
- 전용 후크 토큰을 사용합니다. 게이트웨이 인증 토큰을 재사용하지 마세요.
- 반복적인 인증 실패는 무차별 공격 시도를 늦추기 위해 클라이언트 주소당 비율이 제한됩니다.
- 다중 에이전트 라우팅을 사용하는 경우 `hooks.allowedAgentIds`를 설정하여 명시적인 `agentId` 선택을 제한합니다.
- 발신자가 선택한 세션이 필요하지 않은 한 `hooks.allowRequestSessionKey=false`를 유지하십시오.
- `sessionKey` 요청을 활성화하는 경우 `hooks.allowedSessionKeyPrefixes`를 제한합니다(예: `["hook:"]`).
- 웹훅 로그에 민감한 원시 페이로드를 포함하지 마세요.
- 후크 페이로드는 신뢰할 수 없는 것으로 처리되며 기본적으로 안전 경계로 래핑됩니다.
  특정 후크에 대해 이를 비활성화해야 하는 경우 `allowUnsafeExternalContent: true`를 설정합니다.
  해당 후크의 매핑에서 (위험함).
