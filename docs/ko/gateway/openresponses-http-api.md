---
read_when:
    - OpenResponses API를 사용하는 클라이언트 통합
    - 항목 기반 입력, 클라이언트 도구 호출 또는 SSE 이벤트를 원합니다.
summary: 게이트웨이에서 OpenResponses 호환 /v1/responses HTTP 엔드포인트 노출
title: 오픈응답 API
x-i18n:
    generated_at: "2026-02-08T15:54:43Z"
    model: gtx
    provider: google-translate
    source_hash: 0597714837f8b210c38eeef53561894220c1473e54c56a5c69984847685d518c
    source_path: gateway/openresponses-http-api.md
    workflow: 15
---

# OpenResponse API(HTTP)

OpenClaw의 게이트웨이는 OpenResponses 호환 서비스를 제공할 수 있습니다. `POST /v1/responses` 끝점.

이 끝점은 **기본적으로 비활성화됨**. 먼저 구성에서 활성화하세요.

- `POST /v1/responses`
- 게이트웨이와 동일한 포트(WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/v1/responses`

내부적으로 요청은 일반 게이트웨이 에이전트 실행(동일한 코드 경로)으로 실행됩니다.
`openclaw agent`) 라우팅/권한/구성이 게이트웨이와 일치합니다.

## 입증

게이트웨이 인증 구성을 사용합니다. 전달자 토큰 보내기:

- `Authorization: Bearer <token>`

참고:

- 언제 `gateway.auth.mode="token"`, 사용 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`).
- 언제 `gateway.auth.mode="password"`, 사용 `gateway.auth.password` (또는 `OPENCLAW_GATEWAY_PASSWORD`).

## 대리인 선택

사용자 정의 헤더가 필요하지 않습니다. OpenResponses에서 에이전트 ID를 인코딩합니다. `model` 필드:

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별명)

또는 헤더로 특정 OpenClaw 에이전트를 타겟팅합니다.

- `x-openclaw-agent-id: <agentId>` (기본: `main`)

고급의:

- `x-openclaw-session-key: <sessionKey>` 세션 라우팅을 완전히 제어합니다.

## 엔드포인트 활성화

세트 `gateway.http.endpoints.responses.enabled` 에게 `true`:

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

## 엔드포인트 비활성화

세트 `gateway.http.endpoints.responses.enabled` 에게 `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## 세션 동작

기본적으로 엔드포인트는 다음과 같습니다. **요청당 무국적** (매 호출마다 새 세션 키가 생성됩니다).

요청에 OpenResponses가 포함된 경우 `user` 문자열이면 게이트웨이는 안정적인 세션 키를 파생합니다.
반복 통화가 에이전트 세션을 공유할 수 있도록 합니다.

## 요청 형태(지원됨)

요청은 항목 기반 입력을 사용하는 OpenResponses API를 따릅니다. 현재 지원:

- `input`: 항목 개체의 문자열 또는 배열입니다.
- `instructions`: 시스템 프롬프트에 병합되었습니다.
- `tools`: 클라이언트 도구 정의(기능 도구).
- `tool_choice`: 클라이언트 도구를 필터링하거나 요구합니다.
- `stream`: SSE 스트리밍을 활성화합니다.
- `max_output_tokens`: 최선의 출력 제한(공급자에 따라 다름)
- `user`: 안정적인 세션 라우팅.

받아들여졌지만 **현재 무시됨**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## 항목(입력)

### `message`

역할: `system`, `developer`, `user`, `assistant`.

- `system` 그리고 `developer` 시스템 프롬프트에 추가됩니다.
- 가장 최근의 `user` 또는 `function_call_output` 항목이 '현재 메시지'가 됩니다.
- 이전 사용자/보조 메시지는 컨텍스트 기록으로 포함됩니다.

### `function_call_output` (턴 기반 도구)

도구 결과를 모델로 다시 보냅니다.

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` 그리고 `item_reference`

스키마 호환성을 위해 허용되지만 프롬프트를 작성할 때는 무시됩니다.

## 도구(클라이언트측 기능 도구)

도구 제공 `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

에이전트가 도구를 호출하기로 결정하면 응답은 `function_call` 출력 항목.
그런 다음 다음과 같이 후속 요청을 보냅니다. `function_call_output` 차례를 계속합니다.

## 이미지(`input_image`)

base64 또는 URL 소스를 지원합니다:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

허용되는 MIME 유형(현재): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
최대 크기(현재): 10MB.

## 파일(`input_file`)

base64 또는 URL 소스를 지원합니다:

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

허용되는 MIME 유형(현재): `text/plain`, `text/markdown`, `text/html`, `text/csv`, 
`application/json`, `application/pdf`.

최대 크기(현재): 5MB.

현재 동작:

- 파일 내용이 디코딩되어 **시스템 프롬프트**, 사용자 메시지가 아닌,
  따라서 일시적으로 유지됩니다(세션 기록에 지속되지 않음).
- PDF는 텍스트로 구문 분석됩니다. 텍스트가 거의 발견되지 않으면 첫 번째 페이지가 래스터화됩니다.
  이미지로 변환하여 모델에 전달합니다.

PDF 구문 분석은 노드 친화적인 방법을 사용합니다. `pdfjs-dist` 레거시 빌드(작업자 없음). 현대
PDF.js 빌드에는 브라우저 작업자/DOM 전역이 필요하므로 게이트웨이에서는 사용되지 않습니다.

URL 가져오기 기본값:

- `files.allowUrl`:`true`
- `images.allowUrl`:`true`
- 요청은 보호됩니다(DNS 확인, 개인 IP 차단, 리디렉션 제한, 시간 초과).

## 파일 + 이미지 제한(구성)

기본값은 다음에서 조정할 수 있습니다. `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

생략 시 기본값:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200,000
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10초
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10초

## 스트리밍(SSE)

세트 `stream: true` 서버에서 보낸 이벤트(SSE)를 수신하려면 다음을 수행하세요.

- `Content-Type: text/event-stream`
- 각 이벤트 라인은 `event: <type>` 그리고 `data: <json>`
- 스트림은 다음으로 끝납니다. `data: [DONE]`

현재 발생하는 이벤트 유형:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (오류 발생 시)

## 용법

`usage` 기본 공급자가 토큰 수를 보고할 때 채워집니다.

## 오류

오류는 다음과 같은 JSON 객체를 사용합니다.

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

일반적인 경우:

- `401` 누락/잘못된 인증
- `400` 잘못된 요청 본문
- `405` 잘못된 방법

## 예

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
