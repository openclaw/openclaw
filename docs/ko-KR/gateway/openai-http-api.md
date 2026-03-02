---
summary: "게이트웨이에서 OpenAI 호환 /v1/chat/completions HTTP 끝점 노출"
read_when:
  - OpenAI Chat Completions을 예상하는 도구 통합
title: "OpenAI Chat Completions"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/openai-http-api.md
  workflow: 15
---

# OpenAI Chat Completions(HTTP)

OpenClaw의 게이트웨이는 작은 OpenAI 호환 Chat Completions 끝점을 제공할 수 있습니다.

이 끝점은 **기본적으로 비활성화됩니다**. 먼저 설정에서 활성화합니다.

- `POST /v1/chat/completions`
- 게이트웨이와 동일한 포트(WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/v1/chat/completions`

엔진 후드에서 요청은 정상 게이트웨이 에이전트 실행(동일한 코드 경로 `openclaw agent`)으로 실행되므로 라우팅/권한/설정이 게이트웨이와 일치합니다.

## 인증

게이트웨이 인증 설정을 사용합니다. 베어러 토큰을 전송합니다:

- `Authorization: Bearer <token>`

참고:

- `gateway.auth.mode="token"`일 때 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`) 사용.
- `gateway.auth.mode="password"`일 때 `gateway.auth.password` (또는 `OPENCLAW_GATEWAY_PASSWORD`) 사용.
- `gateway.auth.rateLimit`이 구성되고 너무 많은 인증 실패가 발생하면 끝점이 `429`를 `Retry-After` 사용으로 반환합니다.

## 보안 경계(중요)

이 끝점을 **전체 운영자 액세스** 표면으로 취급합니다.

- 이 곳의 HTTP 베어러 인증은 좁은 사용자 범위 모델이 아닙니다.
- 이 끝점에 대한 유효한 게이트웨이 토큰/암호는 소유자/운영자 자격증으로 취급해야 합니다.
- 요청은 신뢰할 수 있는 운영자 작업과 동일한 제어 평면 에이전트 경로를 통해 실행됩니다.
- 대상 에이전트 정책이 민감한 도구를 허용하면 이 끝점이 이를 사용할 수 있습니다.
- 이 끝점을 루프백/tailnet/개인 수신 전용으로 유지하세요; 공개 인터넷에 직접 노출하지 마세요.

[Security](/gateway/security) 및 [Remote access](/gateway/remote)를 참조하세요.

## 에이전트 선택

커스텀 헤더가 필요하지 않습니다: OpenAI `model` 필드에 에이전트 id를 인코딩합니다:

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별칭)

또는 헤더로 특정 OpenClaw 에이전트를 대상으로 합니다:

- `x-openclaw-agent-id: <agentId>` (기본값: `main`)

고급:

- `x-openclaw-session-key: <sessionKey>` 세션 라우팅을 완전히 제어합니다.

## 끝점 활성화

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
