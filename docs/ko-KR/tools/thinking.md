---
summary: "/think, /fast, /verbose 및 추론 가시성을 위한 디렉티브 구문"
read_when:
  - 사고, 빠른 모드 또는 상세 디렉티브 파싱이나 기본값을 조정할 때
title: "사고 수준"
x-i18n:
  source_path: docs/tools/thinking.md
---

# 사고 수준 (/think 디렉티브)

## 기능

- 모든 인바운드 본문의 인라인 디렉티브: `/t <level>`, `/think:<level>`, 또는 `/thinking <level>`.
- 수준 (별칭): `off | minimal | low | medium | high | xhigh | adaptive`
  - minimal → "think"
  - low → "think hard"
  - medium → "think harder"
  - high → "ultrathink" (최대 예산)
  - xhigh → "ultrathink+" (GPT-5.2 + Codex 모델 전용)
  - adaptive → 프로바이더 관리 적응형 추론 예산 (Anthropic Claude 4.6 모델 패밀리 지원)
  - `x-high`, `x_high`, `extra-high`, `extra high`, `extra_high`는 `xhigh`에 매핑됩니다.
  - `highest`, `max`는 `high`에 매핑됩니다.
- 프로바이더 참고:
  - Anthropic Claude 4.6 모델은 명시적 사고 수준이 설정되지 않으면 기본적으로 `adaptive`입니다.
  - Z.AI (`zai/*`) 는 바이너리 사고 (`on`/`off`) 만 지원합니다. `off`가 아닌 모든 수준은 `on` (mapped to `low`) 으로 처리됩니다.
  - Moonshot (`moonshot/*`) 은 `/think off`를 `thinking: { type: "disabled" }`로, `off`가 아닌 모든 수준을 `thinking: { type: "enabled" }`로 매핑합니다.

## 해결 순서

1. 메시지의 인라인 디렉티브 (해당 메시지에만 적용).
2. 세션 재정의 (디렉티브 전용 메시지 전송으로 설정).
3. 에이전트별 기본값 (설정의 `agents.list[].thinkingDefault`).
4. 전역 기본값 (설정의 `agents.defaults.thinkingDefault`).
5. 폴백: Anthropic Claude 4.6 모델은 `adaptive`, 다른 추론 가능 모델은 `low`, 그 외 `off`.

## 세션 기본값 설정

- 디렉티브**만** 있는 메시지를 보냅니다 (공백 허용), 예: `/think:medium` 또는 `/t high`.
- 현재 세션에 유지됩니다 (기본적으로 발신자별); `/think:off` 또는 세션 유휴 리셋으로 초기화됩니다.
- 확인 답변이 전송됩니다 (`Thinking level set to high.` / `Thinking disabled.`). 수준이 유효하지 않으면 (예: `/thinking big`), 명령이 힌트와 함께 거부되고 세션 상태는 변경되지 않습니다.
- 인수 없이 `/think` (또는 `/think:`) 를 보내면 현재 사고 수준을 확인합니다.

## 빠른 모드 (/fast)

- 수준: `on|off`.
- 디렉티브 전용 메시지는 세션 빠른 모드 재정의를 토글하고 `Fast mode enabled.` / `Fast mode disabled.`로 답변합니다.
- 모드 없이 `/fast` (또는 `/fast status`) 를 보내면 현재 유효 빠른 모드 상태를 확인합니다.
- OpenClaw 은 다음 순서로 빠른 모드를 해결합니다:
  1. 인라인/디렉티브 전용 `/fast on|off`
  2. 세션 재정의
  3. 에이전트별 기본값 (`agents.list[].fastModeDefault`)
  4. 모델별 설정: `agents.defaults.models["<provider>/<model>"].params.fastMode`
  5. 폴백: `off`

## 상세 디렉티브 (/verbose 또는 /v)

- 수준: `on` (최소) | `full` | `off` (기본값).
- 디렉티브 전용 메시지는 세션 상세 모드를 토글하고 `Verbose logging enabled.` / `Verbose logging disabled.`로 답변합니다; 유효하지 않은 수준은 상태를 변경하지 않고 힌트를 반환합니다.
- 상세 모드가 켜져 있으면 구조화된 도구 결과를 출력하는 에이전트 (Pi, 기타 JSON 에이전트) 가 각 도구 호출을 자체 메타데이터 전용 메시지로 다시 보내며, 사용 가능한 경우 `<emoji> <tool-name>: <arg>`가 접두사로 붙습니다 (path/command).

## 추론 가시성 (/reasoning)

- 수준: `on|off|stream`.
- 디렉티브 전용 메시지는 사고 블록이 답변에 표시되는지 토글합니다.
- 활성화되면 추론이 `Reasoning:` 접두사가 붙은 **별도 메시지**로 전송됩니다.
- `stream` (Telegram 전용): 답변 생성 중 Telegram 드래프트 버블에 추론을 스트리밍한 다음 추론 없이 최종 답변을 보냅니다.
- 별칭: `/reason`.

## 관련 문서

- Elevated 모드 문서는 [Elevated 모드](/tools/elevated)에 있습니다.

## 하트비트

- 하트비트 프로브 본문은 구성된 하트비트 프롬프트입니다 (기본값: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). 하트비트 메시지의 인라인 디렉티브는 평소처럼 적용됩니다 (하트비트에서 세션 기본값을 변경하는 것은 피하세요).
- 하트비트 전달은 기본적으로 최종 페이로드만입니다. 별도의 `Reasoning:` 메시지 (사용 가능한 경우) 도 보내려면 `agents.defaults.heartbeat.includeReasoning: true` 또는 에이전트별 `agents.list[].heartbeat.includeReasoning: true`를 설정합니다.

## 웹 채팅 UI

- 웹 채팅 사고 선택기는 페이지 로드 시 인바운드 세션 저장소/설정에서 세션의 저장된 수준을 미러링합니다.
- 다른 수준을 선택하면 다음 메시지에만 적용됩니다 (`thinkingOnce`); 전송 후 선택기는 저장된 세션 수준으로 되돌아갑니다.
- 세션 기본값을 변경하려면 `/think:<level>` 디렉티브를 보냅니다 (이전과 동일); 선택기는 다음 새로고침 후 이를 반영합니다.
