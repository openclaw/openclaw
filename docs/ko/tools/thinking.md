---
read_when:
    - 사고 또는 장황한 지시어 구문 분석 또는 기본값 조정
summary: /think + /verbose에 대한 지시문 구문 및 모델 추론에 미치는 영향
title: 사고 수준
x-i18n:
    generated_at: "2026-02-08T16:12:18Z"
    model: gtx
    provider: google-translate
    source_hash: 0ae614147675be3278482a115926fc5f5977cfa5027617ea91500e86a3bdf9db
    source_path: tools/thinking.md
    workflow: 15
---

# 사고 수준(/think 지시어)

## 기능

- 모든 인바운드 본문의 인라인 지시어: `/t <level>`, `/think:<level>`, 또는 `/thinking <level>`.
- 레벨(별칭): `off | minimal | low | medium | high | xhigh` (GPT-5.2 + Codex 모델만 해당)
  - 최소한의 → “생각하다”
  - 낮음 → "열심히 생각해"
  - 중간 → “더 열심히 생각해 보세요”
  - 높음 → '울트라씽크'(최대 예산)
  - xhigh → “ultrathink+”(GPT-5.2 + Codex 모델만 해당)
  - `x-high`, `x_high`, `extra-high`, `extra high`, 그리고 `extra_high` 매핑하다 `xhigh`.
  - `highest`, `max` 매핑하다 `high`.
- 제공자 참고사항:
  - Z.AI(`zai/*`)는 이진적 사고만 지원합니다(`on`/`off`). 비-`off` 수준으로 취급됩니다. `on` (매핑됨 `low`).

## 해결 순서

1. 메시지에 대한 인라인 지시어(해당 메시지에만 적용됨)
2. 세션 재정의(지시문 전용 메시지를 전송하여 설정)
3. 전역 기본값(`agents.defaults.thinkingDefault` 구성).
4. 폴백: 추론 가능 모델의 경우 낮음; 그렇지 않으면 꺼집니다.

## 세션 기본값 설정

- 다음과 같은 메시지를 보내세요. **오직** 지시문(공백 허용), 예: `/think:medium` 또는 `/t high`.
- 이는 현재 세션에 적용됩니다(기본적으로 발신자별). 다음에 의해 삭제됨 `/think:off` 또는 세션 유휴 재설정.
- 확인 답장이 전송되었습니다(`Thinking level set to high.`/`Thinking disabled.`). 레벨이 유효하지 않은 경우(예: `/thinking big`), 명령은 힌트와 함께 거부되고 세션 상태는 변경되지 않은 상태로 유지됩니다.
- 보내다 `/think` (또는 `/think:`) 현재 사고 수준을 확인하기 위한 논쟁이 없습니다.

## 대리인 신청

- **임베디드 파이**: 해결된 수준이 프로세스 내 Pi 에이전트 런타임으로 전달됩니다.

## 자세한 지시문(/verbose 또는 /v)

- 레벨: `on` (최소) | `full` | `off` (기본).
- 지시문 전용 메시지는 세션 상세 정보 및 응답을 전환합니다. `Verbose logging enabled.`/`Verbose logging disabled.`; 잘못된 수준은 상태를 변경하지 않고 힌트를 반환합니다.
- `/verbose off` 명시적인 세션 재정의를 저장합니다. 다음을 선택하여 세션 UI를 통해 지우십시오. `inherit`.
- 인라인 지시문은 해당 메시지에만 영향을 미칩니다. 그렇지 않으면 세션/전역 기본값이 적용됩니다.
- 보내다 `/verbose` (또는 `/verbose:`) 현재 자세한 수준을 보려면 인수가 없습니다.
- verbose가 켜져 있으면 구조화된 도구 결과를 내보내는 에이전트(Pi, 기타 JSON 에이전트)는 접두사가 붙은 자체 메타데이터 전용 메시지로 각 도구 콜백을 보냅니다. `<emoji> <tool-name>: <arg>` 사용 가능한 경우(경로/명령). 이러한 도구 요약은 스트리밍 델타가 아닌 각 도구가 시작되자마자(별도의 거품) 전송됩니다.
- 장황한 경우 `full`, 도구 출력도 완료 후 전달됩니다(별도의 버블, 안전한 길이로 잘림). 토글하면 `/verbose on|full|off` 실행이 진행 중인 동안 후속 도구 버블은 새 설정을 따릅니다.

## 추론 가시성(/reasoning)

- 레벨: `on|off|stream`.
- 지시문 전용 메시지는 생각 블록이 응답에 표시되는지 여부를 전환합니다.
- 활성화되면 추론이 다음과 같이 전송됩니다. **별도의 메시지** 접두사가 붙은 `Reasoning:`.
- `stream` (텔레그램만 해당): 답변이 생성되는 동안 추론을 텔레그램 초안 버블로 스트리밍한 다음 추론 없이 최종 답변을 보냅니다.
- 별명: `/reason`.
- 보내다 `/reasoning` (또는 `/reasoning:`) 현재 추론 수준을 확인하기 위한 인수가 없습니다.

## 관련된

- 승격 모드 문서는 다음 위치에 있습니다. [승격 모드](/tools/elevated).

## 심장 박동

- 하트비트 프로브 본문은 구성된 하트비트 프롬프트입니다(기본값: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). 하트비트 메시지의 인라인 지시문은 평소와 같이 적용됩니다(그러나 하트비트에서 세션 기본값을 변경하지 마십시오).
- 하트비트 전달은 기본적으로 최종 페이로드에만 적용됩니다. 또한 별도로 보내려면 `Reasoning:` 메시지(사용 가능한 경우), 설정 `agents.defaults.heartbeat.includeReasoning: true` 또는 에이전트별 `agents.list[].heartbeat.includeReasoning: true`.

## 웹 채팅 UI

- 웹 채팅 사고 선택기는 페이지가 로드될 때 인바운드 세션 저장소/구성에서 세션의 저장된 수준을 미러링합니다.
- 다른 수준을 선택하면 다음 메시지에만 적용됩니다(`thinkingOnce`); 전송 후 선택기는 저장된 세션 수준으로 다시 돌아갑니다.
- 세션 기본값을 변경하려면 `/think:<level>` 지시문(이전과 동일); 선택기는 다음 번 다시 로드 후에 이를 반영합니다.
