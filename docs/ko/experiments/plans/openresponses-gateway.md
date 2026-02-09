---
summary: "계획: OpenResponses /v1/responses 엔드포인트를 추가하고 Chat Completions 를 깔끔하게 사용 중단"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway 계획"
---

# OpenResponses Gateway 통합 계획

## 컨텍스트

OpenClaw Gateway 는 현재 최소한의 OpenAI 호환 Chat Completions 엔드포인트를
`/v1/chat/completions` 에서 노출합니다 ([OpenAI Chat Completions](/gateway/openai-http-api) 참고).

Open Responses 는 OpenAI Responses API 를 기반으로 한 개방형 추론 표준입니다. 이는
에이전트 중심 워크플로를 위해 설계되었으며, 아이템 기반 입력과 의미적 스트리밍 이벤트를 사용합니다. OpenResponses
사양은 `/v1/responses` 을 정의하며, `/v1/chat/completions` 가 아닙니다.

## 목표

- OpenResponses 의미론을 준수하는 `/v1/responses` 엔드포인트를 추가합니다.
- Chat Completions 를 비활성화하기 쉽고, 궁극적으로 제거할 수 있는 호환성 레이어로 유지합니다.
- 분리되고 재사용 가능한 스키마로 검증 및 파싱을 표준화합니다.

## Non-goals

- 1차 단계에서 OpenResponses 전체 기능 동등성 (이미지, 파일, 호스티드 도구).
- 내부 에이전트 실행 로직 또는 도구 오케스트레이션 교체.
- 1차 단계 동안 기존 `/v1/chat/completions` 동작 변경.

## 연구 요약

출처: OpenResponses OpenAPI, OpenResponses 사양 사이트, Hugging Face 블로그 게시물.

추출된 핵심 사항:

- `POST /v1/responses` 는 `model`, `input` (문자열 또는
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens`, 그리고
  `max_tool_calls` 와 같은 `CreateResponseBody` 필드를 허용합니다.
- `ItemParam` 은 다음의 판별된 유니언입니다:
  - 역할이 `system`, `developer`, `user`, `assistant` 인 `message` 아이템
  - `function_call` 및 `function_call_output`
  - `reasoning`
  - `item_reference`
- 성공적인 응답은 `object: "response"`, `status`, 그리고
  `output` 아이템을 포함하는 `ResponseResource` 을 반환합니다.
- 스트리밍은 다음과 같은 의미적 이벤트를 사용합니다:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- 사양 요구 사항:
  - `Content-Type: text/event-stream`
  - `event:` 은 JSON `type` 필드와 일치해야 합니다
  - 종료 이벤트는 리터럴 `[DONE]` 이어야 합니다
- 추론 아이템은 `content`, `encrypted_content`, 그리고 `summary` 을 노출할 수 있습니다.
- HF 예제에는 요청에 `OpenResponses-Version: latest` (선택적 헤더) 가 포함됩니다.

## 제안 아키텍처

- Zod 스키마만 포함하는 `src/gateway/open-responses.schema.ts` 을 추가합니다 (Gateway import 없음).
- `/v1/responses` 을 위한 `src/gateway/openresponses-http.ts` (또는 `open-responses-http.ts`) 를 추가합니다.
- 레거시 호환성 어댑터로서 `src/gateway/openai-http.ts` 를 그대로 유지합니다.
- 설정 `gateway.http.endpoints.responses.enabled` 을 추가합니다 (기본값 `false`).
- `gateway.http.endpoints.chatCompletions.enabled` 를 독립적으로 유지하고, 두 엔드포인트를
  각각 토글할 수 있도록 합니다.
- Chat Completions 가 활성화되어 있을 때 레거시 상태를 알리는 시작 경고를 출력합니다.

## Chat Completions 사용 중단 경로

- 엄격한 모듈 경계를 유지합니다: responses 와 chat completions 간에 스키마 타입을 공유하지 않습니다.
- Chat Completions 를 설정을 통한 옵트인 방식으로 만들어 코드 변경 없이 비활성화할 수 있도록 합니다.
- `/v1/responses` 이 안정화되면 문서에서 Chat Completions 를 레거시로 표시합니다.
- 선택적 향후 단계: 제거 경로를 단순화하기 위해 Chat Completions 요청을 Responses 핸들러로 매핑합니다.

## 1단계 지원 서브셋

- `input` 을 문자열 또는 메시지 역할과 `function_call_output` 을 포함한 `ItemParam[]` 으로 허용합니다.
- system 및 developer 메시지를 `extraSystemPrompt` 으로 추출합니다.
- 에이전트 실행을 위한 현재 메시지로 가장 최근의 `user` 또는 `function_call_output` 를 사용합니다.
- 지원되지 않는 콘텐츠 파트 (이미지/파일) 는 `invalid_request_error` 으로 거부합니다.
- `output_text` 콘텐츠를 가진 단일 assistant 메시지를 반환합니다.
- 토큰 회계가 연결될 때까지 값이 0 인 `usage` 를 반환합니다.

## 검증 전략 (SDK 없음)

- 지원되는 서브셋에 대해 Zod 스키마를 구현합니다:
  - `CreateResponseBody`
  - `ItemParam` + 메시지 콘텐츠 파트 유니언
  - `ResponseResource`
  - Gateway 에서 사용되는 스트리밍 이벤트 형태
- 스키마를 단일 분리 모듈에 유지하여 드리프트를 방지하고 향후 코드 생성이 가능하도록 합니다.

## 스트리밍 구현 (1단계)

- `event:` 및 `data:` 을 모두 포함하는 SSE 라인.
- 필수 시퀀스 (최소 기능):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (필요에 따라 반복)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## 테스트 및 검증 계획

- `/v1/responses` 에 대한 e2e 커버리지를 추가합니다:
  - 인증 필요
  - 비스트림 응답 형태
  - 스트림 이벤트 순서 및 `[DONE]`
  - 헤더와 `user` 를 사용한 세션 라우팅
- `src/gateway/openai-http.e2e.test.ts` 는 변경하지 않습니다.
- 수동: `stream: true` 로 `/v1/responses` 에 curl 을 실행하고 이벤트 순서와 종료
  `[DONE]` 를 검증합니다.

## 문서 업데이트 (후속)

- `/v1/responses` 사용법과 예제를 위한 새 문서 페이지를 추가합니다.
- `/gateway/openai-http-api` 를 레거시 노트와 `/v1/responses` 에 대한 포인터로 업데이트합니다.
