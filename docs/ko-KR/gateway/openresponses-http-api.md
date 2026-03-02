---
summary: "게이트웨이에서 OpenResponses 호환 /v1/responses HTTP 끝점 노출"
read_when:
  - OpenResponses API를 사용하는 클라이언트 통합
  - 항목 기반 입력, 클라이언트 도구 호출 또는 SSE 이벤트 원하기
title: "OpenResponses API"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: gateway/openresponses-http-api.md
  workflow: 15
---

# OpenResponses API(HTTP)

OpenClaw의 게이트웨이는 OpenResponses 호환 `POST /v1/responses` 끝점을 제공할 수 있습니다.

이 끝점은 **기본적으로 비활성화됩니다**. 먼저 설정에서 활성화합니다.

- `POST /v1/responses`
- 게이트웨이와 동일한 포트(WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/v1/responses`

엔진 후드에서 요청은 정상 게이트웨이 에이전트 실행(`openclaw agent`와 동일한 코드 경로)으로 실행되므로 라우팅/권한/설정이 게이트웨이와 일치합니다.

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

커스텀 헤더가 필요하지 않습니다: OpenResponses `model` 필드에 에이전트 id를 인코딩합니다:

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별칭)

또는 헤더로 특정 OpenClaw 에이전트를 대상으로 합니다:

- `x-openclaw-agent-id: <agentId>` (기본값: `main`)

고급:

- `x-openclaw-session-key: <sessionKey>` 세션 라우팅을 완전히 제어합니다.

## 끝점 활성화

`gateway.http.endpoints.responses.enabled`를 `true`로 설정합니다:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## 세션 동작

기본적으로 끝점은 **요청별 상태 비저장**(새 세션 키가 생성되고 호출됨).

요청에 OpenResponses `user` 문자열이 포함되어 있으면 게이트웨이가 안정적인 세션 키를 파생하므로 반복 호출이 에이전트 세션을 공유할 수 있습니다.

## 요청 형태(지원)

요청은 항목 기반 입력과 함께 OpenResponses API를 따릅니다. 현재 지원:

- `input`: 문자열 또는 항목 객체 배열.
- `instructions`: 시스템 프롬프트에 병합.
- `tools`: 클라이언트 도구 정의(함수 도구).
- `tool_choice`: 클라이언트 도구 필터 또는 필요.
- `stream`: SSE 스트리밍 활성화.
- `max_output_tokens`: 최선의 노력 출력 제한.
- `user`: 안정적인 세션 라우팅.

현재 **무시됨**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## 항목(입력)

### `message`

역할: `system`, `developer`, `user`, `assistant`.

- `system` 및 `developer`는 시스템 프롬프트에 추가됩니다.
- 가장 최근 `user` 또는 `function_call_output` 항목이 "현재 메시지"가 됩니다.
- 이전 사용자/어시스턴트 메시지는 컨텍스트의 이력으로 포함됩니다.

### `function_call_output`(차례 기반 도구)

도구 결과를 모델로 다시 보냅니다:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

## 도구(클라이언트 측 함수 도구)

`tools: [{ type: "function", function: { name, description?, parameters? } }]`로 도구를 제공합니다.

에이전트가 도구를 호출하기로 결정하면 응답이 `function_call` 출력 항목을 반환합니다.
그런 다음 `function_call_output`이 포함된 후속 요청을 보낸 다음 차례를 계속합니다.

## 이미지(`input_image`)

Base64 또는 URL 소스를 지원합니다:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

허용된 MIME 유형(현재): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
최대 크기(현재): 10MB.

## 파일(`input_file`)

Base64 또는 URL 소스를 지원합니다:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

허용된 MIME 유형(현재): `text/plain`, `text/markdown`, `text/html`, `text/csv`, `application/json`, `application/pdf`.

최대 크기(현재): 5MB.

현재 동작:

- 파일 컨텐츠는 디코딩되고 사용자 메시지가 아닌 **시스템 프롬프트**에 추가되므로 일시적입니다(세션 이력에 지속되지 않음).
- PDF는 텍스트에 대해 구문 분석됩니다. 적은 텍스트가 발견되면 첫 페이지가 이미지로 래스터화되고 모델로 전달됩니다.

## 예제

비스트리밍:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

스트리밍:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
