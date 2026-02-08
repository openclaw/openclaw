---
last_updated: "2026-01-19"
owner: openclaw
status: draft
summary: '계획: OpenResponses /v1/responses 엔드포인트를 추가하고 채팅 완료를 완전히 중단합니다.'
title: OpenResponses 게이트웨이 계획
x-i18n:
    generated_at: "2026-02-08T15:54:33Z"
    model: gtx
    provider: google-translate
    source_hash: 71a22c48397507d1648b40766a3153e420c54f2a2d5186d07e51eb3d12e4636a
    source_path: experiments/plans/openresponses-gateway.md
    workflow: 15
---

# OpenResponses 게이트웨이 통합 계획

## 문맥

OpenClaw Gateway는 현재 최소한의 OpenAI 호환 채팅 완료 엔드포인트를 공개합니다.
`/v1/chat/completions` (보다 [OpenAI 채팅 완료](/gateway/openai-http-api)).

Open Responses는 OpenAI Responses API를 기반으로 하는 개방형 추론 표준입니다. 디자인되었습니다
에이전트 워크플로우를 위해 항목 기반 입력과 시맨틱 스트리밍 이벤트를 사용합니다. OpenResponses
사양은 정의합니다 `/v1/responses`, 아니다 `/v1/chat/completions`.

## 목표

- 추가 `/v1/responses` OpenResponse 의미 체계를 준수하는 엔드포인트입니다.
- 채팅 완료를 쉽게 비활성화하고 결국 제거할 수 있는 호환성 레이어로 유지하세요.
- 격리되고 재사용 가능한 스키마를 사용하여 검증 및 구문 분석을 표준화합니다.

## 논골

- 전체 OpenResponse는 첫 번째 단계(이미지, 파일, 호스팅 도구)에서 패리티 기능을 제공합니다.
- 내부 에이전트 실행 논리 또는 도구 조정을 대체합니다.
- 기존 변경 `/v1/chat/completions` 첫 번째 단계에서의 행동.

## 연구 요약

출처: OpenResponses OpenAPI, OpenResponses 사양 사이트 및 Hugging Face 블로그 게시물.

추출된 핵심 내용:

- `POST /v1/responses` 받아들인다 `CreateResponseBody` 같은 분야 `model`, `input` (문자열 또는
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens`, 그리고
  `max_tool_calls`.
- `ItemParam` 다음의 차별적인 조합입니다:
  - `message` 역할이 있는 항목 `system`, `developer`, `user`, `assistant`
  - `function_call` 그리고 `function_call_output`
  - `reasoning`
  - `item_reference`
- 성공적인 응답은 `ResponseResource` ~와 함께 `object: "response"`, `status`, 그리고
  `output` 항목.
- 스트리밍은 다음과 같은 의미론적 이벤트를 사용합니다.
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- 사양에는 다음이 필요합니다.
  - `Content-Type: text/event-stream`
  - `event:` JSON과 일치해야 합니다. `type` 필드
  - 터미널 이벤트는 문자 그대로여야 합니다. `[DONE]`
- 추론 항목이 노출될 수 있음 `content`, `encrypted_content`, 그리고`summary`.
- HF의 예는 다음과 같습니다 `OpenResponses-Version: latest` 요청(선택적 헤더).

## 제안된 아키텍처

- 추가하다 `src/gateway/open-responses.schema.ts` Zod 스키마만 포함합니다(게이트웨이 가져오기 없음).
- 추가하다 `src/gateway/openresponses-http.ts` (또는 `open-responses-http.ts`) 을 위한 `/v1/responses`.
- 유지하다 `src/gateway/openai-http.ts` 레거시 호환성 어댑터로 그대로 유지됩니다.
- 구성 추가 `gateway.http.endpoints.responses.enabled` (기본 `false`).
- 유지하다 `gateway.http.endpoints.chatCompletions.enabled` 독립적인; 두 끝점 모두 허용
  별도로 전환되었습니다.
- 레거시 상태를 알리기 위해 채팅 완료가 활성화되면 시작 경고를 표시합니다.

## 채팅 완료 지원 중단 경로

- 엄격한 모듈 경계를 유지합니다. 응답과 채팅 완료 간에 공유 스키마 유형이 없습니다.
- 코드 변경 없이 비활성화할 수 있도록 구성을 통해 채팅 완료를 옵트인으로 설정하세요.
- 채팅 완료를 레거시로 한 번 라벨링하도록 문서를 업데이트하세요. `/v1/responses` 안정적이다.
- 선택적 향후 단계: 더 간단한 작업을 위해 채팅 완료 요청을 응답 핸들러에 매핑합니다.
  제거 경로.

## 1단계 지원 하위 집합

- 수용하다 `input` 문자열로 또는 `ItemParam[]` 메시지 역할과 `function_call_output`.
- 시스템 및 개발자 메시지를 다음으로 추출합니다. `extraSystemPrompt`.
- 가장 최근의 것을 사용하세요 `user` 또는 `function_call_output` 에이전트에 대한 현재 메시지가 실행됩니다.
- 지원되지 않는 콘텐츠 부분(이미지/파일)을 거부합니다. `invalid_request_error`.
- 다음을 사용하여 단일 어시스턴트 메시지를 반환합니다. `output_text` 콘텐츠.
- 반품 `usage` 토큰 계정이 연결될 때까지 값이 0으로 설정됩니다.

## 검증 전략(SDK 없음)

- 지원되는 하위 집합에 대해 Zod 스키마를 구현합니다.
  - `CreateResponseBody`
  - `ItemParam` + 메시지 내용 부분 조합
  - `ResponseResource`
  - 게이트웨이에서 사용되는 스트리밍 이벤트 형태
- 드리프트를 방지하고 향후 코드 생성을 허용하려면 격리된 단일 모듈에 스키마를 유지하세요.

## 스트리밍 구현(1단계)

- 둘 다 포함하는 SSE 라인 `event:` 그리고 `data:`.
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

- 다음에 대한 e2e 적용 범위 추가 `/v1/responses`:
  - 인증이 필요합니다
  - 비스트림 응답 형태
  - 스트림 이벤트 주문 및 `[DONE]`
  - 헤더를 사용한 세션 라우팅 `user`
- 유지하다 `src/gateway/openai-http.e2e.test.ts` 변하지 않은.
- 수동: 컬링 `/v1/responses` ~와 함께 `stream: true` 이벤트 순서 및 터미널 확인
  `[DONE]`.

## 문서 업데이트(후속 조치)

- 다음에 대한 새 문서 페이지를 추가합니다. `/v1/responses` 사용법과 예시.
- 업데이트 `/gateway/openai-http-api` 레거시 메모 및 포인터 포함 `/v1/responses`.
