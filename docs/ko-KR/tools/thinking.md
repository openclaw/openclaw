---
summary: "Directive syntax for /think + /verbose and how they affect model reasoning"
read_when:
  - Adjusting thinking or verbose directive parsing or defaults
title: "Thinking Levels"
x-i18n:
  source_hash: 0ae614147675be3278482a115926fc5f5977cfa5027617ea91500e86a3bdf9db
---

# 사고 수준 (/think 지시문)

## 기능

- 인바운드 본문의 인라인 지시문: `/t <level>`, `/think:<level>` 또는 `/thinking <level>`.
- 레벨(별칭): `off | minimal | low | medium | high | xhigh` (GPT-5.2 + Codex 모델만 해당)
  - 최소한의 → “생각하다”
  - 낮음 → “열심히 생각하세요”
  - 중간 → “더 열심히 생각하세요”
  - 높음 → "울트라씽크"(최대 예산)
  - xhigh → “ultrathink+” (GPT-5.2 + Codex 모델만 해당)
  - `x-high`, `x_high`, `extra-high`, `extra high`, `extra_high`는 `xhigh`에 매핑됩니다.
  - `highest`, `max`를 `high`에 매핑합니다.
- 제공업체 참고사항:
  - Z.AI(`zai/*`)는 이진적 사고(`on`/`off`)만 지원합니다. `off`가 아닌 레벨은 `on`로 처리됩니다(`low`에 매핑됨).

## 해결 순서

1. 메시지에 대한 인라인 지시어(해당 메시지에만 적용됨)
2. 세션 재정의(지시문 전용 메시지를 전송하여 설정)
3. 전역 기본값(구성의 `agents.defaults.thinkingDefault`).
4. 대체(fallback): 추론 가능 모델의 경우 낮음; 그렇지 않으면 꺼집니다.

## 세션 기본값 설정

- 지시어 **만** 있는 메시지를 보냅니다(공백 허용). 예: `/think:medium` 또는 `/t high`.
- 이는 현재 세션에 적용됩니다(기본적으로 발신자별). `/think:off` 또는 세션 유휴 재설정으로 지워졌습니다.
- 확인 응답이 전송됩니다(`Thinking level set to high.` / `Thinking disabled.`). 레벨이 유효하지 않은 경우(예: `/thinking big`) 힌트와 함께 명령이 거부되고 세션 상태는 변경되지 않은 상태로 유지됩니다.
- 현재 사고 수준을 확인하려면 인수 없이 `/think` (또는 `/think:`)를 전송하세요.

## 대리인 신청

- **임베디드 Pi**: 해결된 수준이 프로세스 내 Pi 에이전트 런타임으로 전달됩니다.

## 자세한 지시문 (/verbose 또는 /v)

- 레벨: `on` (최소) | `full` | `off` (기본값).
- 지시문 전용 메시지는 세션 상세 정보를 전환하고 `Verbose logging enabled.` / `Verbose logging disabled.`에 응답합니다. 잘못된 수준은 상태를 변경하지 않고 힌트를 반환합니다.
- `/verbose off`는 명시적인 세션 재정의를 저장합니다. `inherit`를 선택하여 세션 UI를 통해 이를 지웁니다.
- 인라인 지시문은 해당 메시지에만 영향을 미칩니다. 그렇지 않으면 세션/전역 기본값이 적용됩니다.
- 현재 상세 수준을 보려면 인수 없이 `/verbose`(또는 `/verbose:`)를 보냅니다.
- verbose가 켜져 있으면 구조화된 도구 결과를 내보내는 에이전트(Pi, 기타 JSON 에이전트)는 사용 가능한 경우(경로/명령) `<emoji> <tool-name>: <arg>` 접두사가 붙은 자체 메타데이터 전용 메시지로 각 도구 콜백을 보냅니다. 이러한 도구 요약은 스트리밍 델타가 아닌 각 도구가 시작되자마자(별도의 버블) 전송됩니다.
- verbose가 `full`인 경우 도구 출력도 완료 후 전달됩니다(별도의 버블, 안전한 길이로 잘림). 실행이 진행 중인 동안 `/verbose on|full|off`를 전환하면 후속 도구 풍선이 새 설정을 따릅니다.

## 추론 가시성 (/reasoning)

- 레벨: `on|off|stream`.
- 지시문 전용 메시지는 생각 블록이 응답에 표시되는지 여부를 전환합니다.
- 활성화되면 추론은 `Reasoning:`라는 접두어가 붙은 **별도의 메시지**로 전송됩니다.
- `stream` (텔레그램에만 해당): 답변이 생성되는 동안 텔레그램 초안 버블에 추론을 스트리밍한 다음 추론 없이 최종 답변을 보냅니다.
- 별칭: `/reason`.
- 현재 추론 수준을 확인하려면 인수 없이 `/reasoning` (또는 `/reasoning:`)를 보냅니다.

## 관련

- 승격 모드 문서는 [승격 모드](/tools/elevated)에 있습니다.

## 심장박동

- 하트비트 프로브 본문은 구성된 하트비트 프롬프트입니다(기본값: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). 하트비트 메시지의 인라인 지시문은 평소와 같이 적용됩니다(그러나 하트비트에서 세션 기본값을 변경하지 마십시오).
- 하트비트 전달은 기본적으로 최종 페이로드에만 적용됩니다. 별도의 `Reasoning:` 메시지(사용 가능한 경우)도 보내려면 `agents.defaults.heartbeat.includeReasoning: true` 또는 에이전트별 `agents.list[].heartbeat.includeReasoning: true`를 설정하세요.

## 웹 채팅 UI

- 웹 채팅 사고 선택기는 페이지가 로드될 때 인바운드 세션 저장소/구성에서 세션의 저장된 수준을 미러링합니다.
- 다른 레벨 선택은 다음 메시지에만 적용됩니다(`thinkingOnce`). 전송 후 선택기는 저장된 세션 수준으로 다시 돌아갑니다.
- 세션 기본값을 변경하려면 `/think:<level>` 지시문을 보냅니다(이전과 동일). 선택기는 다음 번 다시 로드 후에 이를 반영합니다.
