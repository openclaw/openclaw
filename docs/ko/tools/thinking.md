---
summary: " /think + /verbose에 대한 지시자 구문과 모델 추론에 미치는 영향"
read_when:
  - 사고 방식 또는 장황한 지시문 파싱이나 기본값 조정
title: "사고 수준"
---

# 사고 수준 (/think 지시자)

## 무엇을 하는가

- 모든 인바운드 본문에 포함될 수 있는 인라인 지시자: `/t <level>`, `/think:<level>`, 또는 `/thinking <level>`.
- 수준 (별칭): `off | minimal | low | medium | high | xhigh` (GPT-5.2 + Codex 모델 전용)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (최대 예산)
  - xhigh → “ultrathink+” (GPT-5.2 + Codex 모델 전용)
  - `x-high`, `x_high`, `extra-high`, `extra high`, 및 `extra_high`는 `xhigh`에 매핑됩니다.
  - `highest`, `max`는 `high`에 매핑됩니다.
- 프로바이더 참고:
  - Z.AI (`zai/*`)는 이진 사고(`on`/`off`)만 지원합니다. `off`가 아닌 모든 수준은 `on`로 처리됩니다(`low`에 매핑).

## 해석 순서

1. 메시지의 인라인 지시자 (해당 메시지에만 적용).
2. 세션 오버라이드 (지시자만 있는 메시지를 전송하여 설정).
3. 전역 기본값 (구성의 `agents.defaults.thinkingDefault`).
4. 폴백: 추론 가능한 모델은 low, 그 외에는 off.

## 세션 기본값 설정

- 지시자 **만** 포함된 메시지를 전송합니다(공백 허용). 예: `/think:medium` 또는 `/t high`.
- 이는 현재 세션에 유지됩니다(기본적으로 발신자별). `/think:off` 또는 세션 유휴 리셋으로 해제됩니다.
- 확인 응답이 전송됩니다(`Thinking level set to high.` / `Thinking disabled.`). 수준이 유효하지 않으면(예: `/thinking big`), 힌트와 함께 명령이 거부되며 세션 상태는 변경되지 않습니다.
- 인수 없이 `/think` (또는 `/think:`)를 보내면 현재 사고 수준을 확인할 수 있습니다.

## 에이전트 적용

- **임베디드 Pi**: 해석된 수준이 인프로세스 Pi 에이전트 런타임으로 전달됩니다.

## 상세 지시자 (/verbose 또는 /v)

- 수준: `on` (minimal) | `full` | `off` (기본값).
- 지시자만 있는 메시지는 세션 상세 표시를 토글하고 `Verbose logging enabled.` / `Verbose logging disabled.`로 응답합니다. 유효하지 않은 수준은 상태를 변경하지 않고 힌트를 반환합니다.
- `/verbose off`는 명시적인 세션 오버라이드를 저장합니다. 세션 UI에서 `inherit`를 선택하여 해제할 수 있습니다.
- 인라인 지시자는 해당 메시지에만 영향을 미치며, 그 외에는 세션/전역 기본값이 적용됩니다.
- 인수 없이 `/verbose` (또는 `/verbose:`)를 보내면 현재 상세 수준을 확인할 수 있습니다.
- 상세가 켜져 있으면, 구조화된 도구 결과를 내보내는 에이전트(Pi, 기타 JSON 에이전트)는 각 도구 호출을 자체 메타데이터 전용 메시지로 반환하며, 가능한 경우 `<emoji> <tool-name>: <arg>` (경로/명령) 접두사를 붙입니다. 이러한 도구 요약은 각 도구가 시작되는 즉시(개별 버블) 전송되며, 스트리밍 델타로 전송되지 않습니다.
- 상세가 `full`인 경우, 도구 출력은 완료 후에도 전달됩니다(별도 버블, 안전한 길이로 절단). 실행 중에 `/verbose on|full|off`를 토글하면 이후 도구 버블은 새로운 설정을 따릅니다.

## 추론 가시성 (/reasoning)

- 수준: `on|off|stream`.
- 지시자만 있는 메시지는 응답에서 사고 블록 표시 여부를 토글합니다.
- 활성화되면 추론은 **별도의 메시지**로 전송되며 `Reasoning:` 접두사가 붙습니다.
- `stream` (Telegram 전용): 응답이 생성되는 동안 추론을 Telegram 초안 버블로 스트리밍한 뒤, 추론 없이 최종 답변을 전송합니다.
- 별칭: `/reason`.
- 인수 없이 `/reasoning` (또는 `/reasoning:`)를 보내면 현재 추론 수준을 확인할 수 있습니다.

## 관련

- Elevated 모드 문서는 [Elevated mode](/tools/elevated)에 있습니다.

## 하트비트

- 하트비트 프로브 본문은 구성된 하트비트 프롬프트입니다(기본값: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). 하트비트 메시지의 인라인 지시자는 평소와 같이 적용됩니다(단, 하트비트로 세션 기본값을 변경하는 것은 피하십시오).
- 하트비트 전송은 기본적으로 최종 페이로드만 전송합니다. 별도의 `Reasoning:` 메시지도 전송하려면(가능한 경우), `agents.defaults.heartbeat.includeReasoning: true` 또는 에이전트별 `agents.list[].heartbeat.includeReasoning: true`를 설정하십시오.

## 웹 채팅 UI

- 웹 채팅 사고 선택기는 페이지 로드 시 인바운드 세션 저장소/구성에 저장된 세션 수준을 반영합니다.
- 다른 수준을 선택하면 다음 메시지에만 적용됩니다(`thinkingOnce`). 전송 후 선택기는 저장된 세션 수준으로 되돌아갑니다.
- 세션 기본값을 변경하려면 이전과 같이 `/think:<level>` 지시자를 전송하십시오. 다음 새로고침 이후 선택기에 반영됩니다.
