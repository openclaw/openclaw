---
summary: "Gateway에서 OpenResponses와 호환되는 /v1/responses HTTP 엔드포인트를 노출합니다."
read_when:
  - OpenResponses API를 사용하는 클라이언트와 통합할 때
  - 항목 기반 입력, 클라이언트 도구 호출 또는 SSE 이벤트가 필요할 때
title: "OpenResponses API"
---

# OpenResponses API (HTTP)

OpenClaw의 게이트웨이는 OpenResponses와 호환되는 `POST /v1/responses` 엔드포인트를 제공합니다.

이 엔드포인트는 **기본적으로 비활성화되어 있습니다**. 설정에서 먼저 활성화해야 합니다.

- `POST /v1/responses`
- 게이트웨이와 동일한 포트 (WS + HTTP 멀티플렉스): `http://<gateway-host>:<port>/v1/responses`

내부적으로, 요청은 일반적인 게이트웨이 에이전트 실행으로 실행됩니다 (`openclaw agent`와 동일한 코드 경로), 따라서 라우팅/권한/설정이 게이트웨이와 일치합니다.

## 인증

게이트웨이 인증 구성을 사용합니다. 베어러 토큰을 전송합니다:

- `Authorization: Bearer <token>`

참고사항:

- `gateway.auth.mode="token"`일 때, `gateway.auth.token`(또는 `OPENCLAW_GATEWAY_TOKEN`)을 사용합니다.
- `gateway.auth.mode="password"`일 때, `gateway.auth.password`(또는 `OPENCLAW_GATEWAY_PASSWORD`)을 사용합니다.
- `gateway.auth.rateLimit`이 설정되고 인증 실패 횟수가 많을 경우, 엔드포인트는 `429`와 `Retry-After`를 반환합니다.

## 에이전트 선택하기

젠더 헤더가 필요하지 않습니다: 에이전트 ID를 OpenResponses `model` 필드에 인코딩합니다:

- `model: "openclaw:<agentId>"` (예: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (별칭)

또는 헤더로 특정 OpenClaw 에이전트를 타겟으로 합니다:

- `x-openclaw-agent-id: <agentId>` (기본: `main`)

고급 설정:

- `x-openclaw-session-key: <sessionKey>`로 세션 라우팅을 완전히 제어합니다.

## 엔드포인트 활성화

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

## 엔드포인트 비활성화

`gateway.http.endpoints.responses.enabled`를 `false`로 설정합니다:

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

기본적으로 엔드포인트는 **요청별로 무상태**입니다 (각 호출마다 새로운 세션 키가 생성됩니다).

요청에 OpenResponses `user` 문자열이 포함되어 있으면, 게이트웨이는 이를 기반으로 안정적인 세션 키를 유도하여 반복 호출이 에이전트 세션을 공유할 수 있습니다.

## 요청 형식 (지원)

요청은 항목 기반 입력을 가진 OpenResponses API를 따릅니다. 현재 지원:

- `input`: 문자열 또는 항목 객체의 배열.
- `instructions`: 시스템 프롬프트에 병합됩니다.
- `tools`: 클라이언트 도구 정의 (함수 도구).
- `tool_choice`: 클라이언트 도구 필터링 또는 필요.
- `stream`: SSE 스트리밍 활성화.
- `max_output_tokens`: 최선의 노력으로 출력 제한 (프로바이더 종속).
- `user`: 안정적인 세션 라우팅.

수락되지만 **현재 무시됨**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## 항목 (입력)

### `message`

역할: `system`, `developer`, `user`, `assistant`.

- `system` 및 `developer`는 시스템 프롬프트에 추가됩니다.
- 가장 최신 `user` 또는 `function_call_output` 항목이 "현재 메시지"가 됩니다.
- 초기 사용자/assistant 메시지는 컨텍스트를 위한 히스토리로 포함됩니다.

### `function_call_output` (턴 기반 도구)

도구 결과를 모델에 다시 전송합니다:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning`과 `item_reference`

스키마 호환성을 위해 수락되지만 프롬프트를 구성할 때 무시됩니다.

## 도구 (클라이언트 측 함수 도구)

도구를 `tools: [{ type: "function", function: { name, description?, parameters? } }]`와 함께 제공합니다.

에이전트가 도구를 호출하기로 결정하면, 응답은 `function_call` 출력 항목을 반환합니다.
그 후 `function_call_output`과 함께 후속 요청을 전송하여 턴을 계속합니다.

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

- 파일 내용은 **시스템 프롬프트**에 디코딩되어 추가되며, 사용자 메시지에 추가되지 않으므로 일시적입니다 (세션 기록에 보존되지 않음).
- PDF는 텍스트로 변환됩니다. 텍스트가 거의 없는 경우 첫 페이지가 이미지로 레스터화되어 모델에 전달됩니다.

PDF 파싱은 Node 호환 `pdfjs-dist` 레거시 빌드를 사용합니다 (작업자 없음). 최신 PDF.js 빌드는 브라우저 작업자/DOM 전역을 기대하므로 게이트웨이에서 사용되지 않습니다.

URL 가져오기 기본값:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- `maxUrlParts`: `8` (요청당 총 URL 기반 `input_file` + `input_image` 부분)
- 요청은 보호됩니다 (DNS 해석, 프라이빗 IP 차단, 리다이렉션 제한, 타임아웃).
- 입력 유형별로 호스트 이름 허용 목록을 지원합니다 (`files.urlAllowlist`, `images.urlAllowlist`).
  - 정확한 호스트: `"cdn.example.com"`
  - 와일드카드 하위 도메인: `"*.assets.example.com"` (정점 일치 안됨)

## 파일 + 이미지 제한 (설정)

기본값은 `gateway.http.endpoints.responses`에서 조정할 수 있습니다:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          maxUrlParts: 8,
          files: {
            allowUrl: true,
            urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
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
            urlAllowlist: ["images.example.com"],
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
- `maxUrlParts`: 8
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

보안 주의사항:

- URL 허용 목록은 가져오기 및 리다이렉션 홉에서 시행됩니다.
- 호스트 이름을 허용 목록에 추가해도 프라이빗/내부 IP 차단을 우회하지 않습니다.
- 인터넷에 노출된 게이트웨이의 경우, 애플리케이션 수준 보호 외에 네트워크 출입 통제를 적용하십시오.
  [보안](/ko-KR/gateway/security)을 참조하세요.

## 스트리밍 (SSE)

`stream: true`를 설정하여 Server-Sent Events (SSE)를 수신합니다:

- `Content-Type: text/event-stream`
- 각 이벤트 라인은 `event: <type>` 및 `data: <json>`
- 스트림은 `data: [DONE]`으로 끝납니다.

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
- `response.failed` (오류 시)

## 사용량

근본적인 프로바이더가 토큰 수를 보고할 때 `usage`가 채워집니다.

## 오류

오류는 다음과 같은 JSON 객체를 사용합니다:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

일반적인 경우:

- `401` 누락/잘못된 인증
- `400` 잘못된 요청 본문
- `405` 잘못된 메소드

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