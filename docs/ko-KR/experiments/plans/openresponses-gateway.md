---
summary: "Plan: Add OpenResponses /v1/responses endpoint and deprecate chat completions cleanly"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway Plan"
x-i18n:
  source_hash: 71a22c48397507d1648b40766a3153e420c54f2a2d5186d07e51eb3d12e4636a
---

# OpenResponses 게이트웨이 통합 계획

## 컨텍스트

OpenClaw Gateway는 현재 최소한의 OpenAI 호환 채팅 완료 엔드포인트를 공개합니다.
`/v1/chat/completions` ([OpenAI 채팅 완료](/gateway/openai-http-api) 참조).

Open Responses는 OpenAI Responses API를 기반으로 하는 개방형 추론 표준입니다. 디자인되었습니다
에이전트 워크플로우를 위해 항목 기반 입력과 시맨틱 스트리밍 이벤트를 사용합니다. OpenResponses
spec은 `/v1/chat/completions`가 아닌 `/v1/responses`를 정의합니다.

## 목표

- OpenResponses 의미 체계를 준수하는 `/v1/responses` 엔드포인트를 추가합니다.
- 쉽게 비활성화하고 결국 제거할 수 있는 호환성 레이어로 채팅 완료를 유지합니다.
- 격리되고 재사용 가능한 스키마를 사용하여 유효성 검사 및 구문 분석을 표준화합니다.

## 논골

- 첫 번째 단계(이미지, 파일, 호스팅 도구)에서 전체 OpenResponse 기능 패리티를 제공합니다.
- 내부 에이전트 실행 논리 또는 도구 조정을 대체합니다.
- 첫 번째 단계에서 기존 `/v1/chat/completions` 동작을 변경합니다.

## 연구 요약

출처: OpenResponses OpenAPI, OpenResponses 사양 사이트 및 Hugging Face 블로그 게시물.

추출된 핵심 내용:

- `POST /v1/responses`는 `model`, `input`와 같은 `CreateResponseBody` 필드를 허용합니다(문자열 또는
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` 및
  `max_tool_calls`.
- `ItemParam`는 다음의 차별적 결합입니다.
  - `message` 역할이 있는 아이템 `system`, `developer`, `user`, `assistant`
  - `function_call` 및 `function_call_output`
  - `reasoning`
  - `item_reference`
- 성공적인 응답은 `object: "response"`, `status`와 함께 `ResponseResource`를 반환합니다.
  `output` 아이템.
- 스트리밍은 다음과 같은 의미 이벤트를 사용합니다.
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- 사양에는 다음이 필요합니다.
  - `Content-Type: text/event-stream`
  - `event:`는 JSON `type` 필드와 일치해야 합니다.
  - 터미널 이벤트는 리터럴이어야 합니다. `[DONE]`
- 추론 아이템은 `content`, `encrypted_content`, `summary`를 노출시킬 수 있습니다.
- HF 예시에는 요청에 `OpenResponses-Version: latest`가 포함됩니다(선택적 헤더).

## 제안된 아키텍처

- Zod 스키마만 포함하는 `src/gateway/open-responses.schema.ts`를 추가합니다(게이트웨이 가져오기 없음).
- `/v1/responses`에 `src/gateway/openresponses-http.ts`(또는 `open-responses-http.ts`)를 추가합니다.
- `src/gateway/openai-http.ts`를 레거시 호환 어댑터로 그대로 유지하세요.
- 구성 `gateway.http.endpoints.responses.enabled`(기본값 `false`)을 추가합니다.
- `gateway.http.endpoints.chatCompletions.enabled`를 독립적으로 유지하세요. 두 끝점 모두 허용
  별도로 전환되었습니다.
- 레거시 상태를 알리기 위해 채팅 완료가 활성화되면 시작 경고를 표시합니다.

## 채팅 완료 지원 중단 경로

- 엄격한 모듈 경계를 유지합니다. 응답과 채팅 완료 간에 공유 스키마 유형이 없습니다.
- 구성을 통해 채팅 완료가 옵트인되도록 하여 코드 변경 없이 비활성화할 수 있습니다.
- `/v1/responses`가 안정화되면 채팅 완료를 레거시로 표시하도록 문서를 업데이트하세요.
- 선택적 향후 단계: 더 간단하게 채팅 완료 요청을 응답 핸들러에 매핑합니다.
  제거 경로.

## 1단계 지원 하위 집합

- `input`를 문자열로 수락하거나 `ItemParam[]`를 메시지 역할과 `function_call_output`로 수락합니다.
- 시스템 및 개발자 메시지를 `extraSystemPrompt`로 추출합니다.
- 에이전트 실행에 대한 현재 메시지로 가장 최근의 `user` 또는 `function_call_output`를 사용합니다.
- 지원되지 않는 콘텐츠 부분(이미지/파일)을 `invalid_request_error`로 거부합니다.
- `output_text` 내용을 포함하는 단일 도우미 메시지를 반환합니다.
- 토큰 계정이 연결될 때까지 값이 0인 `usage`를 반환합니다.

## 검증 전략(SDK 없음)

- 지원되는 하위 집합에 대해 Zod 스키마를 구현합니다.
  - `CreateResponseBody`
  - `ItemParam` + 메시지 내용 부분 조합
  - `ResponseResource`
  - 게이트웨이에서 사용되는 스트리밍 이벤트 형태
- 드리프트를 방지하고 향후 코드 생성을 허용하려면 격리된 단일 모듈에 스키마를 유지하세요.

## 스트리밍 구현(1단계)

- `event:` 및 `data:`가 모두 포함된 SSE 라인.
- 필수 순서(최소 실행 가능):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (필요에 따라 반복)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## 테스트 및 검증 계획

- `/v1/responses`에 대한 e2e 적용 범위 추가:
  - 인증이 필요합니다
  - 비스트림 응답 형태
  - 스트림 이벤트 주문 및 `[DONE]`
  - 헤더 및 `user`를 사용한 세션 라우팅
- `src/gateway/openai-http.e2e.test.ts`를 변경하지 않고 유지하세요.
- 수동: `stream: true`를 사용하여 `/v1/responses`로 컬링하고 이벤트 순서 및 터미널을 확인합니다.
  `[DONE]`.

## 문서 업데이트(후속 조치)

- `/v1/responses` 사용법 및 예시에 대한 새 문서 페이지를 추가합니다.
- 레거시 메모와 `/v1/responses`에 대한 포인터로 `/gateway/openai-http-api`를 업데이트합니다.
