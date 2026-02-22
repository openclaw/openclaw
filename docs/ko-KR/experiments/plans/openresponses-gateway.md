---
summary: "계획: OpenResponses /v1/responses 엔드포인트 추가 및 채팅 완성도 기능의 깔끔한 중단"
owner: "openclaw"
status: "초안"
last_updated: "2026-01-19"
title: "OpenResponses 게이트웨이 계획"
---

# OpenResponses 게이트웨이 통합 계획

## 컨텍스트

OpenClaw 게이트웨이는 현재 최소한의 OpenAI 호환 채팅 완성도 엔드포인트를 `/v1/chat/completions`에서 제공하고 있습니다 (참조: [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses는 OpenAI 응답 API에 기반한 열린 추론 표준입니다. 이는 에이전트 워크플로우에 적합하게 설계되었으며 항목 기반 입력과 의미적 스트리밍 이벤트를 사용합니다. OpenResponses 사양은 `/v1/responses`를 정의하며, `/v1/chat/completions`은 아닙니다.

## 목표

- OpenResponses 의미론을 따르는 `/v1/responses` 엔드포인트 추가.
- 채팅 완성도를 비활성화하기 쉽고 궁극적으로 제거할 수 있는 호환성 레이어로 유지.
- 격리되고 재사용 가능한 스키마를 통한 검증 및 파싱 표준화.

## 비목표

- 첫 번째 단계에서의 완전한 OpenResponses 기능 유사성 확보 (이미지, 파일, 호스팅된 도구).
- 내부 에이전트 실행 논리 또는 도구 오케스트레이션 교체.
- 첫 번째 단계 동안 기존 `/v1/chat/completions` 동작 변경.

## 연구 요약

출처: OpenResponses OpenAPI, OpenResponses 사양 사이트, 그리고 Hugging Face 블로그 포스트.

추출된 주요 포인트:

- `POST /v1/responses`는 `CreateResponseBody` 필드인 `model`, `input`(문자열 또는 `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens`, `max_tool_calls`를 수락합니다.
- `ItemParam`은 다음과 같은 구별된 유니온입니다:
  - `system`, `developer`, `user`, `assistant` 역할을 가진 `message` 항목
  - `function_call` 및 `function_call_output`
  - `reasoning`
  - `item_reference`
- 성공적인 응답은 `object: "response"`, `status`, `output` 항목이 포함된 `ResponseResource`를 반환합니다.
- 스트리밍은 다음과 같은 의미적 이벤트를 사용합니다:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- 사양 요구사항:
  - `Content-Type: text/event-stream`
  - `event:`는 JSON `type` 필드와 일치해야 함
  - 종료 이벤트는 문자 그대로 `[DONE]`이어야 함
- Reasoning 항목은 `content`, `encrypted_content`, `summary`를 노출할 수 있습니다.
- HF 예제에는 요청에 `OpenResponses-Version: latest`가 포함되어 있습니다 (선택적 헤더).

## 제안된 아키텍처

- Zod 스키마만 포함된 `src/gateway/open-responses.schema.ts` 추가 (게이트웨이 가져오기 없음).
- `/v1/responses`를 위한 `src/gateway/openresponses-http.ts` (또는 `open-responses-http.ts`) 추가.
- `src/gateway/openai-http.ts`를 레거시 호환성 어댑터로서 그대로 유지.
- `gateway.http.endpoints.responses.enabled` 설정 추가 (기본값 `false`).
- `gateway.http.endpoints.chatCompletions.enabled` 독립적으로 유지; 두 엔드포인트를 개별적으로 전환 가능하게 함.
- 채팅 완성도가 활성화되었을 때 시작 경고를 내보내어 레거시 상태를 신호.

## 채팅 완성도 중단 경로

- 엄격한 모듈 경계를 유지: 응답 및 채팅 완성도 간의 공유 스키마 유형 없음.
- 채팅 완성도를 구성으로 옵트인하여 코드 변경 없이 비활성화할 수 있도록 함.
- 문서를 업데이트하여 `/v1/responses`가 안정되면 채팅 완성도를 레거시로 레이블 지정.
- 선택적 향후 단계: 채팅 완성도 요청을 응답 핸들러로 매핑하여 더 단순한 제거 경로 마련.

## 1단계 지원 하위 집합

- 메시지 역할 및 `function_call_output`과 함께 문자열 또는 `ItemParam[]`로 `input` 수락.
- 시스템 및 개발자 메시지를 `extraSystemPrompt`로 추출.
- 에이전트 실행을 위한 현재 메시지로 최신 `user` 또는 `function_call_output` 사용.
- 지원되지 않는 콘텐츠 부분(이미지/파일)은 `invalid_request_error`로 거부.
- `output_text` 콘텐츠와 함께 단일 어시스턴트 메시지 반환.
- 토큰 계정 처리 전까지 값이 0인 `usage` 반환.

## 검증 전략 (SDK 없음)

- 다음에 대한 지원 하위 집합에 대해 Zod 스키마 구현:
  - `CreateResponseBody`
  - `ItemParam` + 메시지 콘텐츠 부분 유니온
  - `ResponseResource`
  - 게이트웨이에 사용되는 스트리밍 이벤트 형태
- 스키마를 단일 격리 모듈에 유지하여 드리프트를 방지하고 향후 코드 생성 허용.

## 스트리밍 구현 (1단계)

- `event:` 및 `data:`가 포함된 SSE 라인.
- 필수 순서 (최소 생존 가능):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (필요시 반복)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## 테스트 및 검증 계획

- `/v1/responses`에 대한 e2e 커버리지 추가:
  - 인증 필요
  - 비스트림 응답 형태
  - 스트림 이벤트 순서 및 `[DONE]`
  - 헤더 및 `user`와 세션 라우팅
- `src/gateway/openai-http.e2e.test.ts`는 변경 없이 유지.
- 수동: `stream: true`로 `/v1/responses`에 curl을 사용하여 이벤트 순서 및 종료 `[DONE]` 확인.

## 문서 업데이트 (후속 작업)

- `/v1/responses` 사용법 및 예제를 위한 새 문서 페이지 추가.
- `/gateway/openai-http-api`에 레거시 노트 및 `/v1/responses`로의 포인터 추가.
