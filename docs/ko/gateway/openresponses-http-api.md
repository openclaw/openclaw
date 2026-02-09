---
summary: "Gateway에서 OpenResponses 호환 /v1/responses HTTP 엔드포인트를 노출합니다"
read_when:
  - OpenResponses API를 사용하는 클라이언트를 통합할 때
  - 아이템 기반 입력, 클라이언트 도구 호출 또는 SSE 이벤트가 필요할 때
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

OpenClaw의 Gateway는 OpenResponses 호환 `POST /v1/responses` 엔드포인트를 제공할 수 있습니다.

이 엔드포인트는 **기본적으로 비활성화되어 있습니다**. 먼저 설정에서 활성화하십시오.

- `POST /v1/responses`
- Gateway와 동일한 포트 (WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/v1/responses`

내부적으로 요청은 일반적인 Gateway 에이전트 실행으로 처리됩니다
(`openclaw agent`와 동일한 코드 경로), 따라서 라우팅/권한/구성은 Gateway와 동일하게 적용됩니다.

## 인증

Gateway 인증 구성을 사용합니다. Bearer 토큰을 전송하십시오:

- `Authorization: Bearer <token>`

참고:

- `gateway.auth.mode="token"`인 경우 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`)를 사용하십시오.
- `gateway.auth.mode="password"`인 경우 `gateway.auth.password` (또는 `OPENCLAW_GATEWAY_PASSWORD`)를 사용하십시오.

## 에이전트 선택

추가 헤더는 필요하지 않습니다. OpenResponses `model` 필드에 에이전트 ID를 인코딩하십시오:

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별칭)

또는 헤더로 특정 OpenClaw 에이전트를 지정할 수 있습니다:

- `x-openclaw-agent-id: <agentId>` (기본값: `main`)

고급:

- `x-openclaw-session-key: <sessionKey>`을 사용하여 세션 라우팅을 완전히 제어할 수 있습니다.

## 엔드포인트 활성화

`gateway.http.endpoints.responses.enabled`를 `true`로 설정하십시오:

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

`gateway.http.endpoints.responses.enabled`를 `false`로 설정하십시오:

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

기본적으로 이 엔드포인트는 **요청별 무상태(stateless)** 입니다 (호출마다 새로운 세션 키가 생성됩니다).

요청에 OpenResponses `user` 문자열이 포함된 경우, Gateway는 이를 기반으로 안정적인 세션 키를 생성하므로
반복 호출 시 동일한 에이전트 세션을 공유할 수 있습니다.

## 요청 형식 (지원됨)

요청은 아이템 기반 입력을 사용하는 OpenResponses API를 따릅니다. 현재 지원 사항은 다음과 같습니다:

- `input`: 문자열 또는 아이템 객체 배열.
- `instructions`: 시스템 프롬프트에 병합됩니다.
- `tools`: 클라이언트 도구 정의 (함수 도구).
- `tool_choice`: 클라이언트 도구를 필터링하거나 필수로 지정합니다.
- `stream`: SSE 스트리밍을 활성화합니다.
- `max_output_tokens`: 최선 노력 방식의 출력 제한 (프로바이더 의존).
- `user`: 안정적인 세션 라우팅.

허용되지만 **현재 무시됨**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (입력)

### `message`

역할: `system`, `developer`, `user`, `assistant`.

- `system` 및 `developer`는 시스템 프롬프트에 추가됩니다.
- 가장 최근의 `user` 또는 `function_call_output` 아이템이 “현재 메시지”가 됩니다.
- 이전 사용자/어시스턴트 메시지는 컨텍스트를 위한 히스토리로 포함됩니다.

### `function_call_output` (턴 기반 도구)

모델에 도구 결과를 다시 전달합니다:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` 및 `item_reference`

스키마 호환성을 위해 허용되지만 프롬프트를 구성할 때는 무시됩니다.

## 도구 (클라이언트 측 함수 도구)

`tools: [{ type: "function", function: { name, description?, parameters? } }]`로 도구를 제공합니다.

에이전트가 도구 호출을 결정하면, 응답은 `function_call` 출력 아이템을 반환합니다.
이후 턴을 계속하려면 `function_call_output`로 후속 요청을 보내십시오.

## 이미지 (`input_image`)

base64 또는 URL 소스를 지원합니다:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

허용되는 MIME 유형 (현재): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
최대 크기 (현재): 10MB.

## 파일 (`input_file`)

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

허용되는 MIME 유형 (현재): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

최대 크기 (현재): 5MB.

현재 동작:

- 파일 콘텐츠는 디코딩되어 사용자 메시지가 아니라 **시스템 프롬프트**에 추가되므로,
  세션 히스토리에 저장되지 않고 일시적으로 유지됩니다.
- PDF는 텍스트를 파싱합니다. 텍스트가 거의 없는 경우, 첫 페이지들을 래스터화하여
  이미지로 변환한 뒤 모델에 전달합니다.

PDF 파싱은 Node 친화적인 `pdfjs-dist` 레거시 빌드를 사용합니다 (워커 없음). 최신
PDF.js 빌드는 브라우저 워커/DOM 전역을 기대하므로 Gateway에서는 사용하지 않습니다.

URL 가져오기 기본값:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- 요청은 보호됩니다 (DNS 해석, 사설 IP 차단, 리다이렉트 제한, 타임아웃).

## 파일 + 이미지 제한 (구성)

기본값은 `gateway.http.endpoints.responses` 아래에서 조정할 수 있습니다:

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
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## 스트리밍 (SSE)

Server-Sent Events (SSE)를 수신하려면 `stream: true`를 설정하십시오:

- `Content-Type: text/event-stream`
- 각 이벤트 라인은 `event: <type>` 및 `data: <json>`입니다
- 스트림은 `data: [DONE]`로 종료됩니다

현재 전송되는 이벤트 유형:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (오류 시)

## 사용량

기본 프로바이더가 토큰 수를 보고하는 경우 `usage`가 채워집니다.

## 오류

오류는 다음과 같은 JSON 객체를 사용합니다:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

일반적인 경우:

- `401` 누락되었거나 잘못된 인증
- `400` 잘못된 요청 본문
- `405` 잘못된 메서드

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
