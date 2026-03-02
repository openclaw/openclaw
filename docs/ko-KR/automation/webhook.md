---
summary: "웨이크 및 격리 에이전트 실행을 위한 Webhook 수신"
read_when:
  - "Webhook 엔드포인트를 추가하거나 변경할 때"
  - "외부 시스템을 OpenClaw에 와이어링할 때"
title: "Webhook"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/automation/webhook.md
  workflow: 15
---

# Webhook

Gateway는 외부 트리거를 위해 작은 HTTP webhook 엔드포인트를 표시할 수 있습니다.

## 활성화

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    // 선택: 명시적 `agentId` 라우팅을 이 allowlist로 제한합니다.
    // "*"를 포함하도록 생략하여 모든 에이전트를 허용합니다.
    // 모든 명시적 `agentId` 라우팅을 거부하려면 []로 설정합니다.
    allowedAgentIds: ["hooks", "main"],
  },
}
```

메모:

- `hooks.token`은 `hooks.enabled=true`일 때 필수입니다.
- `hooks.path` 기본값 `/hooks`입니다.

## Auth

모든 요청은 훅 토큰을 포함해야 합니다. 헤더를 선호합니다:

- `Authorization: Bearer <token>` (권장)
- `x-openclaw-token: <token>`
- 쿼리 문자열 토큰을 거부합니다 (`?token=...` 반환 `400`).

## 엔드포인트

### `POST /hooks/wake`

페이로드:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **필수** (문자열): 이벤트의 설명 (예: "새 이메일 수신됨").
- `mode` 선택 (`now` | `next-heartbeat`): 즉시 하트비트를 트리거할지 (기본값 `now`) 또는 다음 주기적 체크를 기다릴지 여부.

효과:

- **메인** 세션에 대해 시스템 이벤트를 큐에 넣습니다.
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

- `message` **필수** (문자열): 에이전트가 처리할 프롬프트 또는 메시지.
- `name` 선택 (문자열): 훅의 인간 읽을 수 있는 이름 (예: "GitHub"), 세션 요약의 접두사로 사용됨.
- `agentId` 선택 (문자열): 이 훅을 특정 에이전트로 라우팅합니다. 알려지지 않은 ID는 기본 에이전트로 폴백합니다. 설정되면 훅은 해결된 에이전트의 워크스페이스 및 구성을 사용하여 실행합니다.
- `sessionKey` 선택 (문자열): 에이전트의 세션을 식별하는 데 사용되는 키. 기본적으로 이 필드는 `hooks.allowRequestSessionKey=true`가 아니면 거부됩니다.
- `wakeMode` 선택 (`now` | `next-heartbeat`): 즉시 하트비트를 트리거할지 (기본값 `now`) 또는 다음 주기적 체크를 기다릴지 여부.
- `deliver` 선택 (boolean): `true`이면 에이전트의 회신을 메시징 채널로 전송합니다. 기본값 `true`. 하트비트 승인만인 회신은 자동으로 건너뜁니다.
- `channel` 선택 (문자열): 배달을 위한 메시징 채널. 하나: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (플러그인), `signal`, `imessage`, `msteams`. 기본값 `last`.
- `to` 선택 (문자열): 채널에 대한 수신자 식별자 (예: WhatsApp/Signal용 전화번호, Telegram용 채팅 ID, Discord/Slack/Mattermost (플러그인)용 채널 ID, MS Teams용 대화 ID). 기본값 메인 세션의 마지막 수신자.
- `model` 선택 (문자열): 모델 오버라이드 (예: `anthropic/claude-3-5-sonnet` 또는 별칭). 제한되면 허용된 모델 목록에 있어야 합니다.
- `thinking` 선택 (문자열): 사고 수준 오버라이드 (예: `low`, `medium`, `high`).
- `timeoutSeconds` 선택 (숫자): 에이전트 실행의 최대 기간 (초).

효과:

- **격리** 에이전트 터를 실행합니다 (자체 세션 키).
- 항상 **메인** 세션에 요약을 게시합니다.
- `wakeMode=now`이면 즉시 하트비트를 트리거합니다.

## 응답

- `200` for `/hooks/wake`
- `202` for `/hooks/agent` (async run started)
- `401` on auth failure
- `429` on repeated auth failures from the same client (check `Retry-After`)
- `400` on invalid payload
- `413` on oversized payloads

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

agent 페이로드 (또는 매핑)에 `model`을 추가하여 해당 실행에 대해 모델을 오버라이드합니다:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

## 보안

- webhook 엔드포인트를 loopback, tailnet 또는 신뢰할 수 있는 역 프록시 뒤에 유지합니다.
- 전용 훅 토큰을 사용합니다. Gateway auth 토큰을 재사용하지 마세요.
- 반복된 auth 실패는 클라이언트별로 속도 제한됩니다 (brute-force 시도를 느리게 함).
- 다중 에이전트 라우팅을 사용하면 `hooks.allowedAgentIds`를 설정하여 명시적 `agentId` 선택을 제한합니다.
- `hooks.allowRequestSessionKey=false`를 유지합니다 (필요할 때만 요청 오버라이드 허용).
- 요청 `sessionKey`를 활성화하면 `hooks.allowedSessionKeyPrefixes`를 제한합니다 (예: `["hook:"]`).
