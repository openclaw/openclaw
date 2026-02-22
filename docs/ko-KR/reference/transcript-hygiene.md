---
summary: "레퍼런스: 프로바이더별 트랜스크립트 위생 및 복구 규칙"
read_when:
  - 트랜스크립트 모양과 관련된 프로바이더 요청 거부를 디버깅하는 경우
  - 트랜스크립트 위생 또는 도구 호출 복구 로직을 변경하는 경우
  - 프로바이더 간 도구 호출 ID 불일치를 조사하는 경우
title: "트랜스크립트 위생"
---

# 트랜스크립트 위생 (프로바이더 수정)

이 문서는 실행 전 트랜스크립트에 적용되는 **프로바이더별 수정 사항**을 설명합니다 (모델 컨텍스트 빌드). 이러한 수정은 엄격한 프로바이더 요구 사항을 만족시키기 위해 **메모리 내**에서 조정됩니다. 이러한 위생 단계는 저장된 JSONL 트랜스크립트를 디스크에서 다시 쓰지 않습니다. 그러나 별도의 세션 파일 복구 단계가 있을 경우 잘못된 JSONL 파일을 세션이 로드되기 전에 무효한 줄을 제거하여 복구할 수 있습니다. 복구가 발생하면 원본 파일이 세션 파일과 함께 백업됩니다.

범위에는 다음이 포함됩니다:

- 도구 호출 ID 정리
- 도구 호출 입력 검증
- 도구 결과 페어링 복구
- 턴 검증 / 순서 조정
- 생각 서명 정리
- 이미지 페이로드 정리
- 사용자 입력 출처 태깅 (세션 간 라우팅된 프롬프트)

트랜스크립트 저장 세부사항이 필요하면 다음을 참조하십시오:

- [/reference/session-management-compaction](/ko-KR/reference/session-management-compaction)

---

## 실행 장소

모든 트랜스크립트 위생은 임베디드 러너에 중앙 집중화되어 있습니다:

- 정책 선택: `src/agents/transcript-policy.ts`
- 위생/복구 적용: `src/agents/pi-embedded-runner/google.ts`의 `sanitizeSessionHistory`

정책은 `provider`, `modelApi`, `modelId`를 사용하여 적용할 항목을 결정합니다.

트랜스크립트 위생과는 별도로 필요시 세션 파일은 로드 전에 복구됩니다:

- `src/agents/session-file-repair.ts`의 `repairSessionFileIfNeeded`
- `run/attempt.ts` 및 `compact.ts` (임베디드 러너)에서 호출

---

## 전역 규칙: 이미지 정리

이미지 페이로드는 항상 크기 제한으로 인한 프로바이더 측 거부를 방지하기 위해 정리됩니다 (초과 크기 base64 이미지를 축소/재압축).

이것은 또한 비전 지원 모델의 이미지 기반 토큰 압력을 제어하는 데 도움이 됩니다.
낮은 최대 차원은 일반적으로 토큰 사용량을 줄이고, 높은 차원은 세부 사항을 보존합니다.

구현:

- `src/agents/pi-embedded-helpers/images.ts`의 `sanitizeSessionMessagesImages`
- `src/agents/tool-images.ts`의 `sanitizeContentBlocksImages`
- 최대 이미지 크기는 `agents.defaults.imageMaxDimensionPx`를 통해 구성 가능합니다 (기본값: `1200`).

---

## 전역 규칙: 잘못된 도구 호출

`input`과 `arguments`가 모두 없는 도우미 도구 호출 블록은 모델 컨텍스트가 빌드되기 전에 제거됩니다. 이는 부분적으로 유지된 도구 호출로 인한 프로바이더 거부를 방지합니다(예: 속도 제한 실패 후).

구현:

- `src/agents/session-transcript-repair.ts`의 `sanitizeToolCallInputs`
- `src/agents/pi-embedded-runner/google.ts`의 `sanitizeSessionHistory`에서 적용

---

## 전역 규칙: 세션 간 입력 출처

에이전트가 `sessions_send`를 통해 다른 세션으로 프롬프트를 보낼 때 (에이전트 간 답장/알림 단계 포함), OpenClaw는 생성된 사용자 턴을 다음과 함께 유지합니다:

- `message.provenance.kind = "inter_session"`

이 메타데이터는 트랜스크립트 첨부 시점에 기록되며 역할을 변경하지 않습니다 (`role: "user"`는 프로바이더 호환성을 위해 유지). 트랜스크립트 리더는 라우팅된 내부 프롬프트를 최종 사용자 작성 지침으로 간주하지 않기 위해 이를 사용할 수 있습니다.

컨텍스트 재구성 시, OpenClaw는 이러한 사용자 턴 앞에 짧은 `[Inter-session message]` 마커를 메모리 내에 추가하여 모델이 외부 End-user 지침과 구별할 수 있도록 합니다.

---

## 프로바이더 매트릭스 (현재 동작)

**OpenAI / OpenAI Codex**

- 이미지 정리만.
- OpenAI 응답/Codex 트랜스크립트에 대해서 고아된 추론 서명 제외 (뒤에 콘텐츠 블록이 없는 독립형 추론 항목).
- 도구 호출 ID 정리 없음.
- 도구 결과 페어링 복구 없음.
- 턴 검증 또는 순서 조정 없음.
- 합성 도구 결과 없음.
- 생각 서명 제거 없음.

**Google (Generative AI / Gemini CLI / Antigravity)**

- 도구 호출 ID 정리: 엄격한 알파벳/숫자.
- 도구 결과 페어링 복구 및 합성 도구 결과.
- 턴 검증 (Gemini 스타일 턴 교차).
- Google 턴 순서 조정 (히스토리 시작이 도우미일 경우 작은 사용자 부트스트랩 선행).
- Antigravity Claude: 생각 서명 표준화; 서명 없는 생각 블록 제외.

**Anthropic / Minimax (Anthropic-compatible)**

- 도구 결과 페어링 복구 및 합성 도구 결과.
- 턴 검증 (연속된 사용자 턴 병합하여 엄격한 교대 만족).

**Mistral (모델 ID 기반 탐지 포함)**

- 도구 호출 ID 정리: strict9 (알파벳/숫자 길이 9).

**OpenRouter Gemini**

- 생각 서명 정리: base64가 아닌 `thought_signature` 값 제거 (base64 유지).

**기타 전부**

- 이미지 정리만.

---

## 이전 동작 (2026.1.22 이전)

2026.1.22 출시 이전에는 OpenClaw가 여러 레이어의 트랜스크립트 위생을 적용했습니다:

- **트랜스크립트-정리 확장**이 모든 컨텍스트 빌드에서 실행되었으며 다음을 수행할 수 있었습니다:
  - 도구 사용/결과 페어링 복구.
  - 도구 호출 ID 정리 (비엄격 모드를 포함하여 `_`/`-`를 유지).
- 러너는 또한 프로바이더별 정리를 수행했으며, 이는 작업을 중복시켰습니다.
- 프로바이더 정책 외부에서 추가 변형이 발생했으며, 이에 포함되는 것은:
  - 유지 전에 도우미 텍스트에서 `<final>` 태그 제거.
  - 비어 있는 도우미 오류 턴 삭제.
  - 도구 호출 후 도우미 콘텐츠 트림.

이 복잡성은 프로바이더 간 퇴행을 일으켰습니다 (특히 `openai-responses` `call_id|fc_id` 페어링). 2026.1.22 정리는 확장을 제거하고 논리를 러너에 중앙 집중화하며, OpenAI를 이미지 정리 외에는 **노터치**로 만들었습니다.