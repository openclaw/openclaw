---
summary: "참고: 프로바이더별 트랜스크립트 정화 및 복구 규칙"
read_when:
  - 트랜스크립트 형태와 관련된 프로바이더 요청 거부를 디버깅할 때
  - 25. 당신은 전사본 정제나 도구 호출 복구 로직을 변경하고 있다
  - 프로바이더 간 도구 호출 id 불일치를 조사할 때
title: "트랜스크립트 위생"
---

# 트랜스크립트 위생 (프로바이더 보정)

이 문서는 실행 전에 트랜스크립트에 적용되는 **프로바이더별 수정 사항**을 설명합니다
(모델 컨텍스트를 구성할 때). 이는 엄격한 프로바이더 요구 사항을 충족하기 위해 사용하는
**메모리 내** 조정입니다. 이러한 위생 단계는 디스크에 저장된 JSONL 트랜스크립트를
재작성하지 **않습니다**. 다만 별도의 세션 파일 복구 단계에서는 세션을 로드하기 전에
잘못된 JSONL 파일에서 유효하지 않은 라인을 삭제하여 재작성할 수 있습니다. 복구가
발생하면 원본 파일은 세션 파일 옆에 백업됩니다.

범위에는 다음이 포함됩니다:

- 도구 호출 id 정화
- 도구 호출 입력 검증
- 도구 결과 페어링 복구
- 턴 검증 / 순서 정렬
- 사고 서명 정리
- 이미지 페이로드 정화

트랜스크립트 저장소 세부 정보가 필요하면 다음을 참고하십시오:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## 실행 위치

모든 트랜스크립트 위생 처리는 임베디드 러너에 중앙화되어 있습니다:

- 정책 선택: `src/agents/transcript-policy.ts`
- 정화/복구 적용: `sanitizeSessionHistory` ( `src/agents/pi-embedded-runner/google.ts` 내)

정책은 `provider`, `modelApi`, `modelId`를 사용하여 무엇을 적용할지 결정합니다.

트랜스크립트 위생과는 별도로, 세션 파일은 로드 전에 (필요한 경우) 복구됩니다:

- `repairSessionFileIfNeeded` ( `src/agents/session-file-repair.ts` 내)
- `run/attempt.ts` 및 `compact.ts`에서 호출됨 (임베디드 러너)

---

## 전역 규칙: 이미지 정화

이미지 페이로드는 크기 제한으로 인한 프로바이더 측 거부를 방지하기 위해 항상 정화됩니다
(과도하게 큰 base64 이미지를 다운스케일/재압축).

구현:

- `sanitizeSessionMessagesImages` ( `src/agents/pi-embedded-helpers/images.ts` 내)
- `sanitizeContentBlocksImages` ( `src/agents/tool-images.ts` 내)

---

## 전역 규칙: 잘못된 도구 호출

`input`와 `arguments`가 모두 누락된 어시스턴트 도구 호출 블록은
모델 컨텍스트가 구성되기 전에 삭제됩니다. 이는 부분적으로만
영속화된 도구 호출(예: 레이트 리밋 실패 이후)로 인한 프로바이더 거부를 방지합니다.

구현:

- `sanitizeToolCallInputs` ( `src/agents/session-transcript-repair.ts` 내)
- `sanitizeSessionHistory` ( `src/agents/pi-embedded-runner/google.ts` 내)에서 적용됨

---

## 프로바이더 매트릭스 (현재 동작)

**OpenAI / OpenAI Codex**

- 이미지 정화만 수행.
- OpenAI Responses/Codex로 모델을 전환할 때, 고아가 된 추론 서명(뒤따르는 콘텐츠 블록이 없는 독립적인 추론 항목)을 제거.
- 도구 호출 id 정화 없음.
- 도구 결과 페어링 복구 없음.
- 턴 검증 또는 재정렬 없음.
- 합성 도구 결과 없음.
- 사고 서명 제거 없음.

**Google (Generative AI / Gemini CLI / Antigravity)**

- 도구 호출 id 정화: 엄격한 영숫자.
- 도구 결과 페어링 복구 및 합성 도구 결과.
- 턴 검증(Gemini 스타일 턴 교대).
- Google 턴 순서 보정(히스토리가 어시스턴트로 시작하는 경우 아주 작은 사용자 부트스트랩을 앞에 추가).
- Antigravity Claude: 사고 서명 정규화, 서명되지 않은 사고 블록 제거.

**Anthropic / Minimax (Anthropic 호환)**

- 도구 결과 페어링 복구 및 합성 도구 결과.
- 턴 검증(엄격한 교대를 만족하기 위해 연속된 사용자 턴을 병합).

**Mistral (모델 id 기반 감지 포함)**

- 도구 호출 id 정화: strict9 (길이 9의 영숫자).

**OpenRouter Gemini**

- 사고 서명 정리: base64가 아닌 `thought_signature` 값 제거(base64는 유지).

**기타 모든 경우**

- 이미지 정화만 수행.

---

## 과거 동작 (2026.1.22 이전)

2026.1.22 릴리스 이전에는 OpenClaw가 여러 계층의 트랜스크립트 위생 처리를 적용했습니다:

- **트랜스크립트 정화 확장**이 모든 컨텍스트 빌드에서 실행되며 다음을 수행할 수 있었습니다:
  - 도구 사용/결과 페어링 복구.
  - 도구 호출 id 정화(`_`/`-`를 보존하는 비엄격 모드 포함).
- 러너 또한 프로바이더별 정화를 수행하여 작업이 중복되었습니다.
- 프로바이더 정책 외부에서도 추가 변이가 발생했으며, 예를 들면 다음과 같습니다:
  - 영속화 전에 어시스턴트 텍스트에서 `<final>` 태그 제거.
  - 비어 있는 어시스턴트 오류 턴 삭제.
  - 도구 호출 이후 어시스턴트 콘텐츠 트리밍.

이러한 복잡성은 프로바이더 간 회귀를 야기했습니다(특히 `openai-responses`
`call_id|fc_id` 페어링). 2026.1.22 정리는 확장을 제거하고,
로직을 러너에 중앙화했으며, OpenAI를 이미지 정화를 제외하고 **무개입**으로 만들었습니다.
