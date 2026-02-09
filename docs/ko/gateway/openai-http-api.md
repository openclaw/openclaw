---
summary: "Gateway(게이트웨이)에서 OpenAI 호환 /v1/chat/completions HTTP 엔드포인트를 노출합니다"
read_when:
  - OpenAI Chat Completions 를 기대하는 도구를 통합할 때
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaw 의 Gateway(게이트웨이)는 작은 OpenAI 호환 Chat Completions 엔드포인트를 제공할 수 있습니다.

이 엔드포인트는 **기본적으로 비활성화**되어 있습니다. 먼저 설정에서 활성화하십시오.

- `POST /v1/chat/completions`
- Gateway(게이트웨이)와 동일한 포트 (WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/v1/chat/completions`

내부적으로 요청은 일반적인 Gateway(게이트웨이) 에이전트 실행으로 처리됩니다 (`openclaw agent` 와 동일한 코드 경로).

## 인증

Gateway(게이트웨이) 인증 구성을 사용합니다. bearer 토큰을 전송하십시오:

- `Authorization: Bearer <token>`

참고:

- `gateway.auth.mode="token"` 인 경우, `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`) 를 사용하십시오.
- `gateway.auth.mode="password"` 인 경우, `gateway.auth.password` (또는 `OPENCLAW_GATEWAY_PASSWORD`) 를 사용하십시오.

## 에이전트 선택

커스텀 헤더는 필요하지 않습니다. OpenAI `model` 필드에 에이전트 id 를 인코딩하십시오:

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별칭)

또는 헤더로 특정 OpenClaw 에이전트를 대상으로 지정할 수 있습니다:

- `x-openclaw-agent-id: <agentId>` (기본값: `main`)

고급:

- `x-openclaw-session-key: <sessionKey>` 로 세션 라우팅을 완전히 제어합니다.

## 엔드포인트 활성화

`gateway.http.endpoints.chatCompletions.enabled` 를 `true` 로 설정하십시오:

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

`gateway.http.endpoints.chatCompletions.enabled` 를 `false` 로 설정하십시오:

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

기본적으로 이 엔드포인트는 **요청별 무상태**입니다 (각 호출마다 새로운 세션 키가 생성됩니다).

요청에 OpenAI `user` 문자열이 포함되면, Gateway(게이트웨이)는 이를 기반으로 안정적인 세션 키를 파생하여 반복 호출이 동일한 에이전트 세션을 공유할 수 있습니다.

## 스트리밍 (SSE)

Server-Sent Events (SSE) 를 수신하려면 `stream: true` 를 설정하십시오:

- `Content-Type: text/event-stream`
- 각 이벤트 라인은 `data: <json>` 입니다
- 스트림은 `data: [DONE]` 으로 종료됩니다

## 예제

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
