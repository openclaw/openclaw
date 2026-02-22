---
summary: "웨이크 및 독립된 에이전트 실행을 위한 웹훅 인그레스"
read_when:
  - 웹훅 엔드포인트 추가 또는 변경
  - 외부 시스템을 OpenClaw에 연결
title: "웹훅"
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

주의사항:

- `hooks.enabled=true`일 때 `hooks.token`이 필요합니다.
- `hooks.path`는 기본적으로 `/hooks`로 설정됩니다.

## 인증

모든 요청에는 웹훅 토큰이 포함되어야 합니다. 헤더를 사용하는 것이 좋습니다:

- `Authorization: Bearer <token>` (권장)
- `x-openclaw-token: <token>`
- 쿼리 문자열 토큰은 거부됩니다 (`?token=...`은 `400` 반환).

## 엔드포인트

### `POST /hooks/wake`

페이로드:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **required** (string): 이벤트 설명 (예: "새 이메일 수신").
- `mode` optional (`now` | `next-heartbeat`): 즉시 하트비트를 트리거할지 여부 (기본값 `now`) 또는 다음 주기적 확인을 기다릴지 여부.

효과:

- **메인** 세션에 시스템 이벤트를 큐에 추가합니다.
- `mode=now`이면 즉시 하트비트를 트리거합니다.

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

- `message` **required** (string): 에이전트가 처리할 프롬프트 또는 메시지.
- `name` optional (string): 웹훅의 사람이 읽을 수 있는 이름 (예: "GitHub"), 세션 요약에 접두사로 사용.
- `agentId` optional (string): 특정 에이전트로 이 웹훅을 라우팅. 알 수 없는 ID는 기본 에이전트로 회귀. 설정 시, 웹훅은 해상된 에이전트의 워크스페이스와 구성을 사용하여 실행됨.
- `sessionKey` optional (string): 에이전트의 세션을 식별하는 데 사용되는 키. 기본적으로 이 필드는 `hooks.allowRequestSessionKey=true`가 아닌 경우 거부됩니다.
- `wakeMode` optional (`now` | `next-heartbeat`): 즉시 하트비트를 트리거할지 여부 (기본값 `now`) 또는 다음주기적 확인을 기다릴지 여부.
- `deliver` optional (boolean): `true`이면 에이전트의 응답이 메시징 채널로 전송됩니다. 기본값은 `true`. 하트비트 확인 응답만 있으면 자동으로 건너뜀.
- `channel` optional (string): 전송 메시징 채널. 선택지 중 하나: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (플러그인), `signal`, `imessage`, `msteams`. 기본값은 `last`.
- `to` optional (string): 채널의 수신자 식별자 (예: WhatsApp/Signal의 전화번호, Telegram의 chat ID, Discord/Slack/Mattermost (플러그인)의 channel ID, MS Teams의 대화 ID). 기본값은 메인 세션의 마지막 수신자.
- `model` optional (string): 모델 재정의 (예: `anthropic/claude-3-5-sonnet` 또는 별칭). 제한된 경우 허용 모델 목록 내에 있어야 함.
- `thinking` optional (string): 생각 수준 재정의 (예: `low`, `medium`, `high`).
- `timeoutSeconds` optional (number): 에이전트 실행의 최대 지속 시간(초).

효과:

- **독립된** 에이전트 턴을 실행 (자체 세션 키)
- 항상 요약을 **메인** 세션에 게시
- `wakeMode=now`이면 즉시 하트비트를 트리거

## 세션 키 정책 (주요 변경 사항)

`/hooks/agent` 페이로드 `sessionKey` 재정의는 기본적으로 비활성화됨.

- 권장: 고정된 `hooks.defaultSessionKey`을 설정하고 요청 재정의를 꺼 둠.
- 선택 사항: 필요할 때만 요청 재정의를 활성화하고 접두사를 제한.

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

호환성 구성 (레거시 동작):

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:"], // 강력히 권장
  },
}
```

### `POST /hooks/<name>` (매핑됨)

사용자 정의 웹훅 이름은 `hooks.mappings`를 통해 해결됩니다 (구성 참조). 매핑은 임의 페이로드를 `wake` 또는 `agent` 액션으로 변환할 수 있으며, 선택적 템플릿 또는 코드 변환을 포함할 수 있습니다.

매핑 옵션 (요약):

- `hooks.presets: ["gmail"]`은 기본 제공 Gmail 매핑을 활성화합니다.
- `hooks.mappings`를 통해 구성에서 `match`, `action` 및 템플릿을 정의할 수 있습니다.
- `hooks.transformsDir` + `transform.module`는 사용자 정의 논리를 위한 JS/TS 모듈을 로드합니다.
  - `hooks.transformsDir` (설정된 경우)은 OpenClaw 구성 디렉터리의 transforms 루트 내에 유지되어야 합니다 (일반적으로 `~/.openclaw/hooks/transforms`).
  - `transform.module`은 유효한 transforms 디렉터리 내에 있는 것으로 해결되어야 함 (탐색/탈출 경로는 거부됨).
- `match.source`를 사용하여 일반적인 인제스트 엔드포인트 유지 (페이로드 기반 라우팅).
- TS 변환은 TS 로더 (예: `bun` 또는 `tsx`)나 사전 컴파일된 `.js`를 런타임에 필요로 함.
- 매핑에 `deliver: true` + `channel`/`to`를 설정하여 챗 표면으로 응답을 라우팅 (`channel`은 기본적으로 `last`, WhatsApp을 백업으로 사용).
- `agentId`는 웹훅을 특정 에이전트에 라우팅; 알 수 없는 ID는 기본 에이전트로 회귀.
- `hooks.allowedAgentIds`는 명시적인 `agentId` 라우팅을 제한합니다. 이를 생략하거나 `*`를 포함하여 모든 에이전트를 허용. `[]`로 설정하여 명시적인 `agentId` 라우팅을 거부합니다.
- `hooks.defaultSessionKey`는 명시적인 키가 제공되지 않은 경우 웹훅 에이전트 실행을 위한 기본 세션을 설정합니다.
- `hooks.allowRequestSessionKey`는 `/hooks/agent` 페이로드가 `sessionKey`를 설정할 수 있는지를 제어 (기본값: `false`).
- `hooks.allowedSessionKeyPrefixes`는 요청 페이로드 및 매핑에서 명시적인 `sessionKey` 값을 선택적으로 제한합니다.
- `allowUnsafeExternalContent: true`는 해당 웹훅에 대해 외부 콘텐츠 안전 래퍼를 비활성화합니다 (위험함; 신뢰할 수 있는 내부 소스에만 해당).
- `openclaw webhooks gmail setup`은 `openclaw webhooks gmail run`에 대한 `hooks.gmail` 구성을 작성합니다. [Gmail Pub/Sub](/ko-KR/automation/gmail-pubsub)에서 전체 Gmail 감시 흐름을 확인하세요.

## 응답

- `/hooks/wake`에 대해 `200`
- `/hooks/agent`에 대해 `202` (비동기 실행 시작됨)
- 인증 실패 시 `401`
- 동일한 클라이언트로부터의 반복 인증 실패 후 `429` (확인 `Retry-After`)
- 잘못된 페이로드에 대해 `400`
- 너무 큰 페이로드에 대해 `413`

## 예시

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

에이전트 페이로드 (또는 매핑)에 `model`을 추가하여 해당 실행에 대한 모델을 재정의합니다:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

만약 `agents.defaults.models`를 강제한다면, 재정의 모델이 거기에 포함되어 있는지 확인하세요.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## 보안

- 루프백, tailnet, 또는 신뢰할 수 있는 역방향 프록시 뒤에 웹훅 엔드포인트를 유지합니다.
- 전용 웹훅 토큰을 사용하세요; 게이트웨이 인증 토큰을 재사용하지 않습니다.
- 동일한 클라이언트 주소에서 반복적인 인증 실패 시 속도가 제한되어 강제 시도를 느리게 만듭니다.
- 다중 에이전트 라우팅을 사용하는 경우 명시적인 `agentId` 선택을 제한하기 위해 `hooks.allowedAgentIds`를 설정합니다.
- 호출자 선택 세션이 필요하지 않은 한 `hooks.allowRequestSessionKey=false`로 유지합니다.
- 요청 `sessionKey`를 활성화하는 경우 `hooks.allowedSessionKeyPrefixes`를 제한합니다 (예: `["hook:"]`).
- 웹훅 로그에 민감한 원본 페이로드를 포함하지 않도록 합니다.
- 웹훅 페이로드는 불신으로 간주되며 기본적으로 안전 경계로 래핑됩니다. 특정 웹훅에 대해 이를 비활성화해야 하는 경우 해당 웹훅의 매핑에서 `allowUnsafeExternalContent: true`를 설정하십시오 (위험).