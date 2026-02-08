---
read_when:
    - OpenAI 채팅 완료를 기대하는 도구 통합
summary: 게이트웨이에서 OpenAI 호환 /v1/chat/completions HTTP 엔드포인트 노출
title: OpenAI 채팅 완료
x-i18n:
    generated_at: "2026-02-08T15:56:52Z"
    model: gtx
    provider: google-translate
    source_hash: 6f935777f489bff925a3bf18b1e4b7493f83ae7b1e581890092e5779af59b732
    source_path: gateway/openai-http-api.md
    workflow: 15
---

# OpenAI 채팅 완료(HTTP)

OpenClaw의 게이트웨이는 소규모 OpenAI 호환 채팅 완료 엔드포인트를 제공할 수 있습니다.

이 끝점은 **기본적으로 비활성화됨**. 먼저 구성에서 활성화하세요.

- `POST /v1/chat/completions`
- 게이트웨이와 동일한 포트(WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/v1/chat/completions`

내부적으로 요청은 일반 게이트웨이 에이전트 실행(동일한 코드 경로)으로 실행됩니다. `openclaw agent`) 라우팅/권한/구성이 게이트웨이와 일치합니다.

## 입증

게이트웨이 인증 구성을 사용합니다. 전달자 토큰 보내기:

- `Authorization: Bearer <token>`

참고:

- 언제 `gateway.auth.mode="token"`, 사용 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`).
- 언제 `gateway.auth.mode="password"`, 사용 `gateway.auth.password` (또는 `OPENCLAW_GATEWAY_PASSWORD`).

## 대리인 선택

사용자 정의 헤더가 필요하지 않습니다. OpenAI에서 에이전트 ID를 인코딩합니다. `model` 필드:

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별명)

또는 헤더로 특정 OpenClaw 에이전트를 타겟팅합니다.

- `x-openclaw-agent-id: <agentId>` (기본: `main`)

고급의:

- `x-openclaw-session-key: <sessionKey>` 세션 라우팅을 완전히 제어합니다.

## 엔드포인트 활성화

세트 `gateway.http.endpoints.chatCompletions.enabled` 에게 `true`:

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

세트 `gateway.http.endpoints.chatCompletions.enabled` 에게 `false`:

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

기본적으로 엔드포인트는 다음과 같습니다. **요청당 무국적** (매 호출마다 새 세션 키가 생성됩니다).

요청에 OpenAI가 포함된 경우 `user` 문자열을 사용하면 게이트웨이가 안정적인 세션 키를 파생하므로 반복 호출이 에이전트 세션을 공유할 수 있습니다.

## 스트리밍(SSE)

세트 `stream: true` 서버에서 보낸 이벤트(SSE)를 수신하려면 다음을 수행하세요.

- `Content-Type: text/event-stream`
- 각 이벤트 라인은 `data: <json>`
- 스트림은 다음으로 끝납니다. `data: [DONE]`

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
