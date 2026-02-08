---
read_when:
    - 성적표 형태와 관련된 공급자 요청 거부를 디버깅하고 있습니다.
    - 성적표 삭제 또는 도구 호출 복구 논리를 변경하고 있습니다.
    - 제공업체 간 도구 호출 ID 불일치를 조사 중입니다.
summary: '참고: 제공업체별 성적표 삭제 및 복구 규칙'
title: 성적표 위생
x-i18n:
    generated_at: "2026-02-08T16:04:53Z"
    model: gtx
    provider: google-translate
    source_hash: 43ed460827d514a8d23172c298985f37457d54e795dc6a47935c03a2591ca73b
    source_path: reference/transcript-hygiene.md
    workflow: 15
---

# 성적 증명서 위생(제공자 수정)

이 문서에서는 다음을 설명합니다. **공급자별 수정 사항** 실행 전 성적표에 적용
(건물 모델 컨텍스트). 이들은 **메모리 내** 엄격한 기준을 충족하기 위해 사용되는 조정
공급자 요구 사항. 이러한 위생 단계는 **~ 아니다** 저장된 JSONL 성적표를 다시 작성합니다.
디스크에; 그러나 별도의 세션 파일 복구 단계는 잘못된 JSONL 파일을 다시 작성할 수 있습니다.
세션이 로드되기 전에 잘못된 줄을 삭제합니다. 수리가 되면 원래의
파일은 세션 파일과 함께 백업됩니다.

범위에는 다음이 포함됩니다.

- 도구 호출 ID 삭제
- 도구 호출 입력 검증
- 도구 결과 페어링 복구
- 차례 확인/주문
- 생각 서명 정리
- 이미지 페이로드 삭제

성적표 저장 세부정보가 필요한 경우 다음을 참조하세요.

- [/참조/세션 관리-압축](/reference/session-management-compaction)

---

## 이것이 실행되는 곳

모든 성적표 위생은 내장된 실행기에 중앙 집중화됩니다.

- 정책 선택: `src/agents/transcript-policy.ts`
- 살균/수리 신청: `sanitizeSessionHistory` ~에 `src/agents/pi-embedded-runner/google.ts`

정책은 다음을 사용합니다. `provider`, `modelApi`, 그리고 `modelId` 무엇을 적용할지 결정합니다.

기록 위생과 별도로 세션 파일은 로드 전에 복구됩니다(필요한 경우).

- `repairSessionFileIfNeeded` ~에 `src/agents/session-file-repair.ts`
- 다음에서 호출됨 `run/attempt.ts` 그리고 `compact.ts` (내장형 러너)

---

## 전역 규칙: 이미지 삭제

이미지 페이로드는 크기로 인해 공급자 측 거부를 방지하기 위해 항상 삭제됩니다.
제한(대형 base64 이미지 축소/재압축).

구현:

- `sanitizeSessionMessagesImages` ~에 `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` ~에 `src/agents/tool-images.ts`

---

## 전역 규칙: 잘못된 도구 호출

둘 다 누락된 보조 도구 호출 블록 `input` 그리고 `arguments` 떨어졌다
모델 컨텍스트가 구축되기 전. 이를 통해 공급자가 부분적으로 거부하는 것을 방지할 수 있습니다.
지속적인 도구 호출(예: 비율 제한 실패 후)

구현:

- `sanitizeToolCallInputs` ~에 `src/agents/session-transcript-repair.ts`
- 적용 대상 `sanitizeSessionHistory` ~에 `src/agents/pi-embedded-runner/google.ts`

---

## 공급자 매트릭스(현재 동작)

**OpenAI / OpenAI 코덱스**

- 이미지 삭제만 가능합니다.
- 모델이 OpenAI Responses/Codex로 전환되면 분리된 추론 서명(다음 콘텐츠 블록이 없는 독립형 추론 항목)을 삭제합니다.
- 도구 호출 ID 삭제가 없습니다.
- 도구 결과 페어링 복구가 없습니다.
- 차례 확인이나 재정렬이 없습니다.
- 합성 도구 결과가 없습니다.
- 생각 서명 제거가 없습니다.

**Google(제너레이티브 AI/Gemini CLI/반중력)**

- 도구 호출 ID 삭제: 엄격한 영숫자.
- 도구 결과 페어링 복구 및 합성 도구 결과.
- 회전 검증(쌍둥이형 회전 교대).
- Google 차례 순서 수정(기록이 어시스턴트로 시작되는 경우 작은 사용자 부트스트랩 추가)
- 반중력 클로드(Antigravity Claude): 사고 시그니처를 표준화합니다. 서명되지 않은 사고 블록을 삭제하십시오.

**Anthropic / Minimax (안트로픽 호환)**

- 도구 결과 페어링 복구 및 합성 도구 결과.
- 턴 검증(엄격한 교대를 충족시키기 위해 연속적인 사용자 턴을 병합)

**Mistral(모델 ID 기반 감지 포함)**

- 도구 호출 ID 삭제: strict9(영숫자 길이 9).

**오픈라우터 제미니**

- 생각 서명 정리: non-base64 제거 `thought_signature` 값(base64 유지).

**그 밖의 모든 것**

- 이미지 삭제만 가능합니다.

---

## 과거 행동(2026.1.22 이전)

2026.1.22 릴리스 이전에 OpenClaw는 여러 계층의 성적표 위생을 적용했습니다.

- 에이 **성적 증명서 삭제 확장 프로그램** 모든 컨텍스트 빌드에서 실행되었으며 다음을 수행할 수 있었습니다.
  - 수리 도구 사용/결과 페어링.
  - 도구 호출 ID를 삭제합니다(보존되는 비엄격 모드 포함). `_`/`-`).
- 또한 실행기는 작업을 중복하는 공급자별 정리 작업도 수행했습니다.
- 다음을 포함하여 공급자 정책 외부에서 추가 변형이 발생했습니다.
  - 스트리핑 `<final>` 지속성 이전에 보조 텍스트의 태그.
  - 빈 어시스턴트 삭제 오류가 발생합니다.
  - 도구 호출 후 어시스턴트 콘텐츠 다듬기.

이러한 복잡성으로 인해 공급자 간 회귀가 발생했습니다(특히 `openai-responses`
`call_id|fc_id` 편성). 2026.1.22 정리로 확장이 제거되고 중앙 집중화되었습니다.
러너에서 로직을 실행하고 OpenAI를 만들었습니다. **노터치** 이미지 삭제 그 이상.
