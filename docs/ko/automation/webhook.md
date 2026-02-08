---
read_when:
    - 웹훅 엔드포인트 추가 또는 변경
    - OpenClaw에 외부 시스템 연결
summary: 절전 모드 해제 및 격리된 에이전트 실행을 위한 웹훅 인그레스
title: 웹훅
x-i18n:
    generated_at: "2026-02-08T15:46:19Z"
    model: gtx
    provider: google-translate
    source_hash: f26b88864567be82366b1f66a4772ef2813c7846110c62fce6caf7313568265e
    source_path: automation/webhook.md
    workflow: 15
---

# 웹훅

게이트웨이는 외부 트리거를 위한 작은 HTTP 웹훅 엔드포인트를 노출할 수 있습니다.

## 할 수 있게 하다

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

참고:

- `hooks.token` 다음과 같은 경우에 필요합니다. `hooks.enabled=true`.
- `hooks.path` 기본값은 `/hooks`.

## 인증

모든 요청에는 후크 토큰이 포함되어야 합니다. 헤더 선호:

- `Authorization: Bearer <token>` (권장)
- `x-openclaw-token: <token>`
- `?token=<token>` (더 이상 사용되지 않음, 경고를 기록하고 향후 주요 릴리스에서 제거될 예정임)

## 엔드포인트

### `POST /hooks/wake`

유효 탑재량:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **필수의** (문자열): 이벤트에 대한 설명입니다(예: "새 이메일 수신됨").
- `mode` 선택사항(`now` | `next-heartbeat`): 즉시 하트비트를 트리거할지 여부(기본값) `now`) 또는 다음 정기 점검을 기다리십시오.

효과:

- 다음에 대한 시스템 이벤트를 대기열에 넣습니다. **기본** 세션
- 만약에 `mode=now`, 즉각적인 하트비트를 트리거합니다.

### `POST /hooks/agent`

유효 탑재량:

```json
{
  "message": "Run this",
  "name": "Email",
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

- `message` **필수의** (문자열): 에이전트가 처리할 프롬프트 또는 메시지입니다.
- `name` 선택 사항(문자열): 사람이 읽을 수 있는 후크 이름(예: "GitHub")이며 세션 요약에서 접두사로 사용됩니다.
- `sessionKey` 선택사항(문자열): 에이전트의 세션을 식별하는 데 사용되는 키입니다. 기본값은 무작위입니다. `hook:<uuid>`. 일관된 키를 사용하면 후크 컨텍스트 내에서 여러 차례 대화가 가능합니다.
- `wakeMode` 선택사항(`now` | `next-heartbeat`): 즉시 하트비트를 트리거할지 여부(기본값) `now`) 또는 다음 정기 점검을 기다리십시오.
- `deliver` 선택 사항(부울): If `true`, 에이전트의 응답이 메시징 채널로 전송됩니다. 기본값은 `true`. 하트비트 승인만 있는 응답은 자동으로 건너뜁니다.
- `channel` 선택사항(문자열): 전달을 위한 메시징 채널입니다. 다음 중 하나: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (플러그인), `signal`, `imessage`, `msteams`. 기본값은 `last`.
- `to` 선택사항(문자열): 채널의 수신자 식별자(예: WhatsApp/Signal의 전화번호, Telegram의 채팅 ID, Discord/Slack/Mattermost(플러그인)의 채널 ID, MS Teams의 대화 ID)입니다. 기본 세션의 마지막 수신자가 기본값입니다.
- `model` 선택사항(문자열): 모델 재정의(예: `anthropic/claude-3-5-sonnet` 또는 별칭). 제한된 경우 허용 모델 목록에 있어야 합니다.
- `thinking` 선택사항(문자열): 사고 수준 재정의(예: `low`, `medium`, `high`).
- `timeoutSeconds` 선택 사항(숫자): 에이전트 실행의 최대 기간(초)입니다.

효과:

- 실행 **외딴** 에이전트 차례(자체 세션 키)
- 항상 요약을 게시합니다. **기본** 세션
- 만약에 `wakeMode=now`, 즉각적인 하트비트를 트리거합니다.

### `POST /hooks/<name>` (매핑됨)

사용자 정의 후크 이름은 다음을 통해 해결됩니다. `hooks.mappings` (구성 참조). 매핑은 다음과 같습니다.
임의의 페이로드를 다음으로 변환 `wake` 또는 `agent` 선택적 템플릿을 사용하는 작업 또는
코드가 변환됩니다.

매핑 옵션(요약):

- `hooks.presets: ["gmail"]` 내장된 Gmail 매핑을 활성화합니다.
- `hooks.mappings` 정의할 수 있습니다 `match`, `action`, 그리고 구성의 템플릿.
- `hooks.transformsDir` + `transform.module` 사용자 정의 로직을 위한 JS/TS 모듈을 로드합니다.
- 사용 `match.source` 일반 수집 엔드포인트(페이로드 기반 라우팅)를 유지합니다.
- TS 변환에는 TS 로더가 필요합니다(예: `bun` 또는 `tsx`) 또는 미리 컴파일된 `.js` 런타임에.
- 세트 `deliver: true` + `channel`/`to` 답변을 채팅 화면으로 라우팅하기 위한 매핑
  (`channel` 기본값은 `last` 그리고 WhatsApp으로 돌아갑니다).
- `allowUnsafeExternalContent: true` 해당 후크에 대한 외부 콘텐츠 안전 래퍼를 비활성화합니다.
  (위험합니다. 신뢰할 수 있는 내부 소스에만 해당).
- `openclaw webhooks gmail setup` 쓴다 `hooks.gmail` 구성 `openclaw webhooks gmail run`.
  보다 [Gmail 게시/구독](/automation/gmail-pubsub) 전체 Gmail 시청 흐름을 확인하세요.

## 응답

- `200` ~을 위한 `/hooks/wake`
- `202` ~을 위한 `/hooks/agent` (비동기 실행이 시작됨)
- `401` 인증 실패 시
- `400` 유효하지 않은 페이로드
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

### 다른 모델을 사용하세요

추가하다 `model` 해당 실행에 대한 모델을 재정의하기 위해 에이전트 페이로드(또는 매핑)에:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

시행한다면 `agents.defaults.models`, 거기에 재정의 모델이 포함되어 있는지 확인하세요.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## 보안

- 루프백, 테일넷 또는 신뢰할 수 있는 역방향 프록시 뒤에 후크 엔드포인트를 유지합니다.
- 전용 후크 토큰을 사용하세요. 게이트웨이 인증 토큰을 재사용하지 마세요.
- 웹훅 로그에 민감한 원시 페이로드를 포함하지 마세요.
- 후크 페이로드는 신뢰할 수 없는 것으로 처리되며 기본적으로 안전 경계로 래핑됩니다.
  특정 후크에 대해 이를 비활성화해야 하는 경우 다음을 설정하십시오. `allowUnsafeExternalContent: true`
  해당 후크의 매핑에서 (위험함).
