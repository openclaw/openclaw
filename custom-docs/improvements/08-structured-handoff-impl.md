# #8 구조화된 핸드오프 페이로드 — 구현 기록

> 구현일: 2026-02-19
> 상태: Phase 1-4 완료

---

## 변경된 파일

### 신규 생성

| 파일                                          | LOC  | 설명                                                                                    |
| --------------------------------------------- | ---- | --------------------------------------------------------------------------------------- |
| `src/agents/tools/a2a-payload-types.ts`       | ~95  | 4가지 페이로드 인터페이스 + A2APayload 유니온 타입                                      |
| `src/agents/tools/a2a-payload-parser.ts`      | ~240 | parseA2APayload, validateA2APayload, buildPayloadSummary, mapPayloadTypeToMessageIntent |
| `src/agents/tools/a2a-payload-parser.test.ts` | ~330 | 42 tests — 파싱, 검증, 요약, 인텐트 매핑                                                |

### 수정된 파일

| 파일                                         | 변경 내용                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/agents/tools/sessions-send-tool.ts`     | `payloadJson` TypeBox 파라미터 추가, parseA2APayload 호출, 컨텍스트 빌더 + A2A 플로우에 전달 |
| `src/agents/tools/sessions-send-helpers.ts`  | `buildAgentToAgentMessageContext`에 `payload` 파라미터 추가, 구조화 요약 삽입                |
| `src/agents/tools/sessions-send-tool.a2a.ts` | `payloadType`/`payloadJson` 파라미터, A2A_SEND 이벤트에 포함, 인텐트 분류 단축               |
| `src/agents/tools/a2a-job-orchestrator.ts`   | `payloadType`/`payloadJson` 패스스루 (CreateA2AJobFlowParams → startJobFlow → runFlowDirect) |

---

## 설계 문서와의 차이

1. **Zod/TypeBox 스키마 미사용**: 설계 문서는 Zod 또는 TypeBox로 페이로드 스키마를 정의할 것을 제안했으나, 순수 TypeScript 런타임 검증으로 구현. 이유: 추가 의존성 없이 동일한 효과를 달성하며, 기존 코드베이스의 TypeBox 사용은 도구 스키마에 국한됨.

2. **이벤트 타입 인터페이스 미수정**: 설계 문서는 `event-types.ts`에 `A2ASendEvent`, `A2AResponseEvent` 인터페이스를 수정할 것을 제안했으나, 실제 코드베이스에서는 이벤트가 `Record<string, unknown>` 형태의 `data` 객체로 전달되어 타입 정의 변경이 불필요. 대신 `sessions-send-tool.a2a.ts`의 이벤트 발행 코드에 `payloadType`/`payloadJson` 필드를 직접 추가.

3. **인텐트 분류기 함수 시그니처 미변경**: 설계 문서는 `classifyA2AIntent`에 payload 파라미터를 추가할 것을 제안했으나, 실제 인텐트 분류기는 `classifyMessageIntent`로 순수 문자열 기반. 대신 A2A 플로우에서 payload 존재 시 분류기 자체를 건너뛰는 방식으로 구현 (confidence=1.0).

---

## 운영 영향

- **역호환**: `payloadJson` 파라미터는 완전히 선택적. 기존 A2A 플로우는 payload=null로 동작하며 기존 동작 변경 없음.
- **이벤트 로그**: A2A_SEND 이벤트에 `payloadType`/`payloadJson` 필드가 추가됨. Task-Monitor는 동적 data 객체를 사용하므로 자동으로 표시.
- **인텐트 분류 최적화**: 구조화 페이로드 제공 시 LLM 기반 인텐트 추론을 건너뛰어 정확도 1.0 + 추가 LLM 호출 절약.

---

## 테스트 결과

- `a2a-payload-parser.test.ts`: 42 tests 통과
- `a2a-intent-classifier.test.ts`: 31/32 pass (1 pre-existing failure)
- `sessions-send-helpers.context.test.ts`: 9 tests 통과
- `a2a-job-orchestrator.test.ts`: 8 tests 통과
- TypeScript `--noEmit`: 변경 파일 에러 없음

---

## 페이로드 타입 요약

| 타입              | 용도                  | 필수 필드                          | 인텐트 매핑   |
| ----------------- | --------------------- | ---------------------------------- | ------------- |
| `task_delegation` | 에이전트 간 작업 위임 | taskId, taskTitle, taskDescription | collaboration |
| `status_report`   | 작업 진행 보고        | taskId, status                     | result_report |
| `question`        | 명확화 요청           | questionId, question               | question      |
| `answer`          | 질문 응답             | questionId, answer                 | notification  |

---

_구현일: 2026-02-19_
