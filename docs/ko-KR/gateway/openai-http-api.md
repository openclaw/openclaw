---
summary: "Gateway에서 OpenAI 호환 /v1/chat/completions HTTP 엔드포인트 노출"
read_when:
  - OpenAI Chat Completions를 기대하는 도구와 통합할 때
title: "OpenAI Chat Completions"
x-i18n:
  source_path: docs/gateway/openai-http-api.md
---

# OpenAI Chat Completions (HTTP)

OpenClaw의 Gateway는 소형 OpenAI 호환 Chat Completions 엔드포인트를 제공할 수 있습니다.

이 엔드포인트는 **기본적으로 비활성화**되어 있습니다. 먼저 설정에서 활성화하세요.

- `POST /v1/chat/completions`
- Gateway와 동일한 포트 (WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/v1/chat/completions`

내부적으로 요청은 일반 Gateway 에이전트 실행(`openclaw agent`와 동일한 코드 경로)으로 실행되므로, 라우팅/권한/설정이 Gateway와 일치합니다.

## 인증

Gateway 인증 설정을 사용합니다. 베어러 토큰을 전송합니다:

- `Authorization: Bearer <token>`

참고:

- `gateway.auth.mode="token"`일 때 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`)을 사용합니다.
- `gateway.auth.mode="password"`일 때 `gateway.auth.password` (또는 `OPENCLAW_GATEWAY_PASSWORD`)를 사용합니다.
- `gateway.auth.rateLimit`이 설정되고 인증 실패가 너무 많으면, 엔드포인트는 `Retry-After`와 함께 `429`를 반환합니다.

## 보안 경계 (중요)

이 엔드포인트를 Gateway 인스턴스의 **전체 운영자 접근** 표면으로 취급하세요.

- 이 HTTP 베어러 인증은 좁은 사용자별 범위 모델이 아닙니다.
- 이 엔드포인트의 유효한 Gateway 토큰/비밀번호는 소유자/운영자 자격 증명처럼 취급해야 합니다.
- 요청은 신뢰할 수 있는 운영자 작업과 동일한 컨트롤 플레인 에이전트 경로를 통해 실행됩니다.
- 이 엔드포인트에는 별도의 비소유자/사용자별 도구 경계가 없습니다. 호출자가 Gateway 인증을 통과하면 OpenClaw은 해당 호출자를 이 Gateway의 신뢰할 수 있는 운영자로 취급합니다.
- 대상 에이전트 정책이 민감한 도구를 허용하는 경우, 이 엔드포인트에서 사용할 수 있습니다.
- 이 엔드포인트를 루프백/tailnet/프라이빗 인그레스에서만 유지하세요. 공개 인터넷에 직접 노출하지 마세요.

[보안](/gateway/security) 및 [원격 접근](/gateway/remote)을 참고하세요.

## 에이전트 선택

커스텀 헤더 불필요: OpenAI `model` 필드에 에이전트 ID를 인코딩합니다:

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별칭)

또는 헤더로 특정 OpenClaw 에이전트를 대상으로 합니다:

- `x-openclaw-agent-id: <agentId>` (기본값: `main`)

고급:

- `x-openclaw-session-key: <sessionKey>`로 세션 라우팅을 완전히 제어합니다.

## 엔드포인트 활성화

`gateway.http.endpoints.chatCompletions.enabled`를 `true`로 설정합니다:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## 엔드포인트 비활성화

`gateway.http.endpoints.chatCompletions.enabled`를 `false`로 설정합니다:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## 세션 동작

기본적으로 엔드포인트는 **요청별 상태 비저장**입니다 (호출마다 새 세션 키가 생성됨).

요청에 OpenAI `user` 문자열이 포함된 경우, Gateway는 이로부터 안정적인 세션 키를 파생하여 반복 호출이 에이전트 세션을 공유할 수 있습니다.

## 스트리밍 (SSE)

`stream: true`를 설정하여 Server-Sent Events (SSE)를 수신합니다:

- `Content-Type: text/event-stream`
- 각 이벤트 라인은 `data: <json>`입니다
- 스트림은 `data: [DONE]`으로 종료됩니다

## 예시

비 스트리밍:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

스트리밍:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
