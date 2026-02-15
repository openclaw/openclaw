---
summary: "Expose an OpenAI-compatible /v1/chat/completions HTTP endpoint from the Gateway"
read_when:
  - Integrating tools that expect OpenAI Chat Completions
title: "OpenAI Chat Completions"
x-i18n:
  source_hash: 6f935777f489bff925a3bf18b1e4b7493f83ae7b1e581890092e5779af59b732
---

# OpenAI 채팅 완료(HTTP)

OpenClaw의 게이트웨이는 소규모 OpenAI 호환 채팅 완료 엔드포인트를 제공할 수 있습니다.

이 엔드포인트는 **기본적으로 비활성화되어 있습니다**. 먼저 구성에서 활성화하세요.

- `POST /v1/chat/completions`
- 게이트웨이와 동일한 포트(WS + HTTP 다중화): `http://<gateway-host>:<port>/v1/chat/completions`

내부적으로 요청은 일반 게이트웨이 에이전트 실행(`openclaw agent`과 동일한 코드 경로)으로 실행되므로 라우팅/권한/구성이 게이트웨이와 일치합니다.

## 인증

게이트웨이 인증 구성을 사용합니다. 전달자 토큰 보내기:

- `Authorization: Bearer <token>`

참고:

- `gateway.auth.mode="token"`인 경우 `gateway.auth.token`(또는 `OPENCLAW_GATEWAY_TOKEN`)를 사용합니다.
- `gateway.auth.mode="password"`인 경우 `gateway.auth.password`(또는 `OPENCLAW_GATEWAY_PASSWORD`)를 사용합니다.

## 에이전트 선택

사용자 정의 헤더가 필요하지 않습니다. OpenAI `model` 필드에 에이전트 ID를 인코딩합니다.

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별칭)

또는 헤더로 특정 OpenClaw 에이전트를 타겟팅합니다.

- `x-openclaw-agent-id: <agentId>` (기본값: `main`)

고급:

- `x-openclaw-session-key: <sessionKey>` 세션 라우팅을 완전히 제어합니다.

## 엔드포인트 활성화

`gateway.http.endpoints.chatCompletions.enabled`를 `true`로 설정합니다.

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

`gateway.http.endpoints.chatCompletions.enabled`를 `false`로 설정합니다.

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

기본적으로 엔드포인트는 **요청당 상태 비저장**입니다(호출할 때마다 새 세션 키가 생성됨).

요청에 OpenAI `user` 문자열이 포함된 경우 게이트웨이는 여기에서 안정적인 세션 키를 파생하므로 반복 호출이 에이전트 세션을 공유할 수 있습니다.

## 스트리밍(SSE)

서버에서 보낸 이벤트(SSE)를 수신하려면 `stream: true`를 설정하세요.

- `Content-Type: text/event-stream`
- 각 이벤트 라인은 `data: <json>` 입니다.
- 스트림은 `data: [DONE]`로 끝납니다.

## 예

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
