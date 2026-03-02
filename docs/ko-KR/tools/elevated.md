---
summary: "높은 실행 모드 및 /elevated 지시문"
read_when:
  - 높은 모드 기본값, 허용 목록 또는 슬래시 커맨드 동작을 조정할 때
title: "높은 모드"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: tools/elevated.md
workflow: 15
---

# 높은 모드(/elevated 지시문)

## 작동 방식

- `/elevated on`은 Gateway 호스트에서 실행되며 실행 승인을 유지합니다(`/elevated ask`와 동일).
- `/elevated full`은 Gateway 호스트에서 실행되며 실행 승인을 **자동 승인합니다**(실행 승인을 건너뜀).
- `/elevated ask`는 Gateway 호스트에서 실행되지만 실행 승인을 유지합니다(`/elevated on`과 동일).
- `on`/`ask`는 `exec.security=full`을 강제하지 않습니다; 구성된 보안/물어보기 정책이 여전히 적용됩니다.
- 에이전트가 **샌드박스된** 경우에만 동작을 변경합니다(그렇지 않으면 exec는 이미 호스트에서 실행됨).
- 지시문 형식: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- `on|off|ask|full`만 수락됨; 다른 모든 것은 힌트를 반환하고 상태를 변경하지 않습니다.

## 제어 대상(및 제어 대상 아님)

- **가용성 제어**: `tools.elevated`는 전역 기준선입니다. `agents.list[].tools.elevated`는 에이전트별로 높은 모드를 추가로 제한할 수 있습니다(둘 다 허용해야 함).
- **세션당 상태**: `/elevated on|off|ask|full`은 현재 세션 키에 대한 높은 모드 레벨을 설정합니다.
- **인라인 지시문**: 메시지 내 `/elevated on|ask|full`은 해당 메시지에만 적용됩니다.
- **그룹**: 그룹 채팅에서 높은 모드 지시문은 에이전트가 언급될 때만 적용됩니다. 언급 요구 사항을 우회하는 커맨드 전용 메시지는 언급된 것으로 처리됩니다.
- **호스트 실행**: 높은 모드는 `exec`을 Gateway 호스트로 강제합니다; `full`은 또한 `security=full`을 설정합니다.
- **승인**: `full`은 실행 승인을 건너뜀; `on`/`ask`는 허용 목록/물어보기 규칙이 필요할 때 승인을 준수합니다.
- **샌드박스 해제된 에이전트**: 위치에 대해 no-op; 제어만 영향합니다.
- **도구 정책이 여전히 적용됩니다**: `exec`이 도구 정책에 의해 거부되면 높은 모드를 사용할 수 없습니다.
- **`/exec`과 별도**: `/exec`은 권한 있는 발신자의 세션 기본값을 조정하며 높은 모드가 필요하지 않습니다.

## 해결 순서

1. 메시지의 인라인 지시문(해당 메시지에만 적용).
2. 세션 오버라이드(지시문 전용 메시지로 설정).
3. 전역 기본값(구성의 `agents.defaults.elevatedDefault`).

## 세션 기본값 설정

- **지시문만**인 메시지를 보냅니다(공백 허용), 예: `/elevated full`.
- 확인 회신이 전송됩니다(`Elevated mode set to full...` / `Elevated mode disabled.`).
- 높은 모드 액세스가 비활성화되거나 발신자가 승인된 허용 목록에 있지 않으면 지시문은 실행 가능한 오류로 회신하고 세션 상태를 변경하지 않습니다.
- 현재 높은 모드 레벨을 보려면 `/elevated`(또는 `/elevated:`) 인수 없이 보냅니다.

## 가용성 + 허용 목록

- 기능 제어: `tools.elevated.enabled`(기본값 구성을 통해 꺼질 수 있음).
- 발신자 허용 목록: `tools.elevated.allowFrom`과 제공자별 허용 목록(예: `discord`, `whatsapp`).
- 접두어 없는 허용 목록 항목은 발신자 범위 ID 값(`SenderId`, `SenderE164`, `From`)만 일치합니다; 수신자 라우팅 필드는 높은 모드 인증에 절대 사용되지 않습니다.
- 변경 가능한 발신자 메타데이터는 명시적 접두어가 필요합니다:
  - `name:<value>`는 `SenderName` 일치.
  - `username:<value>`는 `SenderUsername` 일치.
  - `tag:<value>`는 `SenderTag` 일치.
  - `id:<value>`, `from:<value>`, `e164:<value>`는 명시적 ID 대상용으로 사용 가능.
- 에이전트별 제어: `agents.list[].tools.elevated.enabled`(선택 사항; 추가로 제한만 가능).
- 에이전트별 허용 목록: `agents.list[].tools.elevated.allowFrom`(선택 사항; 설정된 경우 발신자는 전역 + 에이전트별 허용 목록 모두와 일치해야 함).
- Discord 폴백: `tools.elevated.allowFrom.discord`가 생략된 경우 `channels.discord.allowFrom` 목록이 폴백으로 사용됩니다(레거시: `channels.discord.dm.allowFrom`). `tools.elevated.allowFrom.discord`를 설정(빈 `[]`이더라도)하여 오버라이드합니다. 에이전트별 허용 목록은 폴백을 사용하지 **않습니다**.
- 모든 제어가 통과해야 함; 그렇지 않으면 높은 모드는 사용할 수 없는 것으로 처리됩니다.

## 로깅 + 상태

- 높은 실행 호출은 정보 레벨에서 로깅됩니다.
- 세션 상태는 높은 모드(예: `elevated=ask`, `elevated=full`)를 포함합니다.
