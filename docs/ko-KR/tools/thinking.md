---
summary: "/think + /verbose 지시어 구문과 모델 추론에 미치는 영향"
read_when:
  - 사고 또는 상세 지시어 구문 분석 또는 기본값 조정
title: "Thinking Levels"
---

# Thinking Levels (/think 지시어)

## 수행 기능

- 모든 수신 본문에서 인라인 지시어: `/t <level>`, `/think:<level>`, 또는 `/thinking <level>`.
- 수준(별칭): `off | minimal | low | medium | high | xhigh` (GPT-5.2 + Codex 모델에서만 사용 가능)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (최대 예산)
  - xhigh → “ultrathink+” (GPT-5.2 + Codex 모델에서만 사용 가능)
  - `x-high`, `x_high`, `extra-high`, `extra high`, `extra_high`는 `xhigh`에 매핑됩니다.
  - `highest`, `max`는 `high`에 매핑됩니다.
- 프로바이더 참고 사항:
  - Z.AI(`zai/*`)는 이진 사고(`on`/`off`)만 지원합니다. `off`가 아닌 모든 수준은 `on`으로 취급됩니다(`low`로 매핑됩니다).

## 해결 순서

1. 메시지의 인라인 지시어(해당 메시지에만 적용).
2. 세션 재정의(지시어만 포함된 메시지를 보내 설정).
3. 전역 기본값(`agents.defaults.thinkingDefault` 설정).
4. 대체: 추론 가능한 모델의 경우 low; 그렇지 않으면 off.

## 세션 기본값 설정

- 지시어만 포함된 메시지를 보냅니다(공백 허용), 예: `/think:medium` 또는 `/t high`.
- 현재 세션 동안 유효합니다(기본적으로 발신자별); `/think:off` 또는 세션 유휴 상태 초기화로 해제됩니다.
- 확인 답장이 전송됩니다(`Thinking level set to high.` / `Thinking disabled.`). 수준이 잘못된 경우(예: `/thinking big`), 명령이 힌트와 함께 거부되고 세션 상태는 변경되지 않습니다.
- `/think` (또는 `/think:`)로 인자를 제공하지 않고 보내 현재 사고 수준을 확인합니다.

## 에이전트별 적용

- **Embedded Pi**: 결정된 수준이 인프로세스 Pi 에이전트 런타임으로 전달됩니다.

## 상세 지시어 (/verbose 또는 /v)

- 수준: `on` (minimal) | `full` | `off` (기본값).
- 지시어만 포함된 메시지가 세션 상세를 토글하고 `Verbose logging enabled.` / `Verbose logging disabled.`로 응답합니다; 잘못된 수준은 상태를 변경하지 않고 힌트를 반환합니다.
- `/verbose off`는 명시적인 세션 재정의를 저장합니다; `inherit`를 선택하여 세션 UI를 통해 초기화합니다.
- 인라인 지시어는 해당 메시지에만 영향을 미칩니다; 그렇지 않으면 세션/전역 기본값이 적용됩니다.
- `/verbose` (또는 `/verbose:`)로 인자를 제공하지 않고 보내 현재 상세 수준을 확인합니다.
- 상세가 켜져 있을 때, 구조화된 도구 결과를 발행하는 에이전트(Pi, 다른 JSON 에이전트)는 사용 가능한 경우 각 도구 호출을 자체 메타데이터 전용 메시지로 되돌려 보냅니다(경로/명령). 이 도구 요약은 각 도구가 시작되면 즉시 전송됩니다(별도의 버블), 스트리밍 델타로는 아니며.
- 상세가 `full`인 경우, 도구 출력도 완료 후 전달됩니다(별개 버블, 안전한 길이로 잘림). 실행 중에 `/verbose on|full|off`를 토글하면 후속 도구 버블이 새로운 설정을 존중합니다.

## 추론 가시성 (/reasoning)

- 수준: `on|off|stream`.
- 지시어만 포함된 메시지가 답글에 사고 블록을 표시할지 여부를 토글합니다.
- 활성화된 경우, 추론은 **별도의 메시지**로 `Reasoning:`으로 접두어를 붙여 전송합니다.
- `stream` (Telegram 전용): 답변이 생성되는 동안 Telegram 초안 버블로 추론을 스트리밍한 후, 최종 답변을 추론 없이 전송합니다.
- 별칭: `/reason`.
- `/reasoning` (또는 `/reasoning:`)으로 인자를 제공하지 않고 보내 현재 추론 수준을 확인합니다.

## 관련

- [Elevated mode](/ko-KR/tools/elevated)에 문서가 있습니다.

## 하트비트

- 하트비트 프로브 본문은 구성된 하트비트 프롬프트입니다(기본값: `HEARTBEAT.md를 읽으십시오(작업 공간 컨텍스트). 엄격하게 따르세요. 이전 채팅의 오래된 작업을 추론하거나 반복하지 마세요. 주의할 필요가 없는 경우 HEARTBEAT_OK로 응답하세요.`). 하트비트 메시지의 인라인 지시어는 평소대로 적용됩니다(하지만 하트비트로 세션 기본값 변경을 피하세요).
- 하트비트 전달은 기본적으로 최종 페이로드로 제한됩니다. 별도의 `Reasoning:` 메시지도 전송하도록 하려면 `agents.defaults.heartbeat.includeReasoning: true` 또는 개별 에이전트 `agents.list[].heartbeat.includeReasoning: true`를 설정합니다.

## 웹 채팅 UI

- 웹 채팅 사고 선택기는 페이지 로드 시 수신 세션 저장소/설정에서 세션에 저장된 수준을 반영합니다.
- 다른 수준을 선택하면 다음 메시지에만 적용됩니다 (`thinkingOnce`); 전송 후 선택기는 저장된 세션 수준으로 되돌아옵니다.
- 세션 기본값을 변경하려면 `/think:<level>` 지시어를 전송합니다(이전과 같이); 다음 새로고침 후 선택기에反영됩니다.