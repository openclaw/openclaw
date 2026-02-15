---
summary: "Reference: provider-specific transcript sanitization and repair rules"
read_when:
  - You are debugging provider request rejections tied to transcript shape
  - You are changing transcript sanitization or tool-call repair logic
  - You are investigating tool-call id mismatches across providers
title: "Transcript Hygiene"
x-i18n:
  source_hash: c4e78fddada1116e129c12239e80e020cb4b2c4a792f188744fbc49d41877300
---

# 성적 증명서 위생(제공자 수정)

이 문서에서는 실행 전 기록에 적용되는 **공급업체별 수정 사항**에 대해 설명합니다.
(건물 모델 컨텍스트). 이는 엄격한 기준을 충족하는 데 사용되는 **인메모리** 조정입니다.
공급자 요구 사항. 이러한 위생 단계에서는 저장된 JSONL 기록을 다시 작성하지 **않습니다**
디스크에; 그러나 별도의 세션 파일 복구 단계는 잘못된 JSONL 파일을 다시 작성할 수 있습니다.
세션이 로드되기 전에 잘못된 줄을 삭제합니다. 수리가 되면 원래의
파일은 세션 파일과 함께 백업됩니다.

범위에는 다음이 포함됩니다.

- 도구 호출 ID 삭제
- 도구 호출 입력 검증
- 도구 결과 페어링 복구
- 차례 확인 / 주문
- 생각 서명 정리
- 이미지 페이로드 삭제
- 사용자 입력 출처 태깅(세션 간 라우팅 프롬프트용)

성적표 저장 세부정보가 필요한 경우 다음을 참조하세요.

- [/참조/세션 관리-압축](/reference/session-management-compaction)

---

## 이것이 실행되는 곳

모든 성적표 위생은 내장된 실행기에 중앙 집중화됩니다.

- 정책 선택 : `src/agents/transcript-policy.ts`
- 살균/수리 적용 : `src/agents/pi-embedded-runner/google.ts` 내 `sanitizeSessionHistory`

정책은 `provider`, `modelApi` 및 `modelId`를 사용하여 적용할 항목을 결정합니다.

기록 위생과 별도로 세션 파일은 로드 전에 복구됩니다(필요한 경우).

- `repairSessionFileIfNeeded` in `src/agents/session-file-repair.ts`
- `run/attempt.ts` 및 `compact.ts`에서 호출됨(내장형 러너)

---

## 전역 규칙: 이미지 삭제

이미지 페이로드는 크기로 인해 공급자 측 거부를 방지하기 위해 항상 삭제됩니다.
제한(대형 base64 이미지 축소/재압축).

구현:

- `sanitizeSessionMessagesImages` in `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` in `src/agents/tool-images.ts`

---

## 전역 규칙: 잘못된 도구 호출

`input` 및 `arguments`가 모두 누락된 보조 도구 호출 블록이 삭제됩니다.
모델 컨텍스트가 구축되기 전. 이를 통해 공급자가 부분적으로 거부하는 것을 방지할 수 있습니다.
지속적인 도구 호출(예: 비율 제한 실패 후)

구현:

- `sanitizeToolCallInputs` `src/agents/session-transcript-repair.ts`
- `src/agents/pi-embedded-runner/google.ts`의 `sanitizeSessionHistory`에 적용됨

---

## 전역 규칙: 세션 간 입력 출처

에이전트가 `sessions_send`를 통해 다른 세션에 프롬프트를 보내는 경우(포함
에이전트 간 응답/알림 단계), OpenClaw는 다음을 통해 생성된 사용자 차례를 유지합니다.

- `message.provenance.kind = "inter_session"`

이 메타데이터는 기록 추가 시 작성되며 역할을 변경하지 않습니다.
(`role: "user"`는 공급자 호환성을 위해 남아 있습니다.) 성적표 독자는 다음을 사용할 수 있습니다.
이는 라우팅된 내부 프롬프트를 최종 사용자가 작성한 지침으로 취급하지 않도록 하기 위한 것입니다.

컨텍스트 재구축 중에 OpenClaw는 짧은 `[Inter-session message]` 앞에도 추가합니다.
모델이 사용자와 사용자를 구별할 수 있도록 해당 사용자에 대한 마커가 메모리 내로 전환됩니다.
외부 최종 사용자 지침.

---

## 공급자 매트릭스(현재 동작)

**OpenAI / OpenAI 코덱스**

- 이미지 삭제만 가능합니다.
- 모델을 OpenAI Responses/Codex로 전환할 때 분리된 추론 서명(다음 콘텐츠 블록이 없는 독립형 추론 항목)을 삭제합니다.
- 도구 호출 ID를 삭제하지 않습니다.
- 도구 결과 페어링 복구가 없습니다.
- 차례 확인이나 순서 변경이 없습니다.
- 합성 도구 결과가 없습니다.
- 생각 서명 제거가 없습니다.

**Google(제너레이티브 AI/Gemini CLI/반중력)**

- 도구 호출 ID 삭제: 엄격한 영숫자.
- 도구 결과 페어링 복구 및 합성 도구 결과.
- 회전 확인(쌍둥이형 회전 교대).
- Google 차례 순서 수정(기록이 어시스턴트로 시작하는 경우 작은 사용자 부트스트랩 추가).
- 반중력 클로드: 사고 시그니처를 표준화합니다. 서명되지 않은 사고 블록을 삭제하십시오.

**인류적/Minimax(인류적 호환)**

- 도구 결과 페어링 복구 및 합성 도구 결과.
- 턴 검증(엄격한 교대를 충족시키기 위해 연속적인 사용자 턴을 병합)

**Mistral(모델 ID 기반 감지 포함)**

- 도구 호출 ID 삭제: strict9(영숫자 길이 9).

**오픈라우터 Gemini**

- 사고 서명 정리: base64가 아닌 `thought_signature` 값을 제거합니다(base64 유지).

**그 외 모든 것**

- 이미지 삭제만 가능합니다.

---

## 과거 동작(2026.1.22 이전)

2026.1.22 릴리스 이전에 OpenClaw는 여러 계층의 성적표 위생을 적용했습니다.

- **transcript-sanitize 확장**은 모든 컨텍스트 빌드에서 실행되었으며 다음을 수행할 수 있습니다.
  - 수리 도구 사용/결과 페어링.
  - 도구 호출 ID를 삭제합니다(`_`/`-`를 유지하는 엄격하지 않은 모드 포함).
- 실행자는 또한 중복된 작업을 수행하는 공급자별 정리 작업을 수행했습니다.
- 다음을 포함하여 공급자 정책 외부에서 추가 변형이 발생했습니다.
  - 지속성 전에 보조 텍스트에서 `<final>` 태그를 제거합니다.
  - 빈 조수를 삭제하는 오류가 발생합니다.
  - 도구 호출 후 보조 콘텐츠 다듬기.

이러한 복잡성으로 인해 공급자 간 회귀가 발생했습니다(특히 `openai-responses`
`call_id|fc_id` 페어링). 2026.1.22 정리로 확장이 제거되고 중앙 집중화되었습니다.
실행기의 로직을 실행하고 OpenAI를 이미지 삭제 이상의 **노터치**로 만들었습니다.
