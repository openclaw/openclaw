---
summary: "게이트웨이에서 OpenAI 호환 /v1/chat/completions HTTP 엔드포인트 노출"
read_when:
  - OpenAI Chat Completions을 기대하는 도구와 통합할 때
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaw의 게이트웨이는 소형 OpenAI 호환 Chat Completions 엔드포인트를 제공합니다.

이 엔드포인트는 **기본적으로 비활성화되어 있습니다**. 먼저 설정에서 활성화하세요.

- `POST /v1/chat/completions`
- 게이트웨이와 동일한 포트 (WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/v1/chat/completions`

내부적으로 요청은 일반 게이트웨이 에이전트 실행으로 처리됩니다 (`openclaw agent`와 동일한 코드 경로). 따라서 라우팅/권한/설정이 게이트웨이와 일치합니다.

## 인증

게이트웨이 인증 설정을 사용합니다. 베어러 토큰(Bearer token)을 전송하세요:

- `Authorization: Bearer <token>`

주의사항:

- `gateway.auth.mode="token"`일 때, `gateway.auth.token`(또는 `OPENCLAW_GATEWAY_TOKEN`)을 사용하세요.
- `gateway.auth.mode="password"`일 때, `gateway.auth.password`(또는 `OPENCLAW_GATEWAY_PASSWORD`)를 사용하세요.
- `gateway.auth.rateLimit`이 설정되어 있고 인증 실패가 너무 많이 발생하면, 엔드포인트는 `429`와 함께 `Retry-After`를 반환합니다.

## 에이전트 선택

커스텀 헤더 없이도 가능합니다: OpenAI `model` 필드에 에이전트 ID를 인코딩하세요:

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별칭)

또는 헤더를 통해 특정 OpenClaw 에이전트를 지정하세요:

- `x-openclaw-agent-id: <agentId>` (기본값: `main`)

고급:

- `x-openclaw-session-key: <sessionKey>`로 세션 라우팅을 완전히 제어하세요.

## 엔드포인트 활성화

`gateway.http.endpoints.chatCompletions.enabled`를 `true`로 설정하세요:

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

`gateway.http.endpoints.chatCompletions.enabled`를 `false`로 설정하세요:

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

기본적으로 엔드포인트는 **요청당 무상태**로 동작합니다 (각 호출마다 새로운 세션 키가 생성됨).

요청에 OpenAI `user` 문자열이 포함되어 있으면, 게이트웨이는 이를 기반으로 안정적인 세션 키를 생성하여 반복 호출이 에이전트 세션을 공유할 수 있게 합니다.

## 스트리밍 (SSE)

`stream: true`로 설정하여 Server-Sent Events (SSE)를 수신하세요:

- `Content-Type: text/event-stream`
- 각 이벤트 라인은 `data: <json>` 형식
- 스트림은 `data: [DONE]`으로 종료됩니다

## 예시

비스트리밍:

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
