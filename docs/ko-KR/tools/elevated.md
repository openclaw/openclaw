---
summary: "Elevated exec mode and /elevated directives"
read_when:
  - Adjusting elevated mode defaults, allowlists, or slash command behavior
title: "Elevated Mode"
x-i18n:
  source_hash: 83767a01609304026d145feb0aa0b0533e8cf8b16cd200f724d9e3e8cf2920c3
---

# 상승 모드 (/elevated 지시문)

## 기능

- `/elevated on`는 게이트웨이 호스트에서 실행되며 실행 승인을 유지합니다(`/elevated ask`와 동일).
- `/elevated full`는 게이트웨이 호스트에서 실행되고\*\* exec를 자동 승인합니다(exec 승인 건너뛰기).
- `/elevated ask`는 게이트웨이 호스트에서 실행되지만 실행 승인을 유지합니다(`/elevated on`와 동일).
- `on`/`ask` `exec.security=full`를 강요하지 **않습니다**; 구성된 보안/질문 정책이 계속 적용됩니다.
- 에이전트가 **샌드박스**된 경우에만 동작을 변경합니다(그렇지 않은 경우 exec가 이미 호스트에서 실행 중임).
- 지시문 형식: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- `on|off|ask|full`만 허용됩니다. 다른 어떤 것도 힌트를 반환하고 상태를 변경하지 않습니다.

## 제어하는 것과 제어하지 않는 것

- **가용성 게이트**: `tools.elevated`는 전역 기준입니다. `agents.list[].tools.elevated`는 에이전트당 상승을 추가로 제한할 수 있습니다(둘 다 허용해야 함).
- **세션별 상태**: `/elevated on|off|ask|full`는 현재 세션 키의 상승된 수준을 설정합니다.
- **인라인 지시어**: 메시지 내부의 `/elevated on|ask|full`는 해당 메시지에만 적용됩니다.
- **그룹**: 그룹 채팅에서는 상담원이 언급된 경우에만 승격된 지시가 적용됩니다. 멘션 요구 사항을 우회하는 명령 전용 메시지는 멘션된 것으로 처리됩니다.
- **호스트 실행**: 게이트웨이 호스트에 `exec`의 힘을 강화합니다. `full`는 `security=full`도 설정합니다.
- **승인**: `full`는 실행 승인을 건너뜁니다. `on`/`ask` 허용 목록/요청 규칙이 필요할 때 이를 존중합니다.
- **샌드박스 처리되지 않은 에이전트**: 위치에 대한 작업이 없습니다. 게이팅, 로깅 및 상태에만 영향을 미칩니다.
- **도구 정책은 계속 적용됩니다**: `exec`가 도구 정책에 의해 거부되면 승격된 도구를 사용할 수 없습니다.
- **`/exec`**와 별개: `/exec`는 승인된 발신자에 대한 세션별 기본값을 조정하며 승격이 필요하지 않습니다.

## 해결 순서

1. 메시지에 대한 인라인 지시어(해당 메시지에만 적용됨)
2. 세션 재정의(지시문 전용 메시지를 전송하여 설정)
3. 전역 기본값(구성의 `agents.defaults.elevatedDefault`).

## 세션 기본값 설정

- 지시어 **만** 있는 메시지를 보냅니다(공백 허용). 예: `/elevated full`.
- 확인 답변이 전송됩니다(`Elevated mode set to full...` / `Elevated mode disabled.`).
- 높은 액세스 권한이 비활성화되거나 보낸 사람이 승인된 허용 목록에 없는 경우 지시어는 실행 가능한 오류로 응답하고 세션 상태를 변경하지 않습니다.
- 현재 상승된 레벨을 보려면 인수 없이 `/elevated` (또는 `/elevated:`)를 전송하세요.

## 가용성 + 허용 목록

- 기능 게이트: `tools.elevated.enabled` (기본값은 코드가 지원하더라도 구성을 통해 끌 수 있습니다).
- 발신자 허용 목록: `tools.elevated.allowFrom` 제공자별 허용 목록 포함(예: `discord`, `whatsapp`).
- 에이전트별 게이트: `agents.list[].tools.elevated.enabled` (선택 사항, 추가 제한만 가능).
- 에이전트별 허용 목록: `agents.list[].tools.elevated.allowFrom` (선택 사항, 설정 시 발신자는 전역 + 에이전트별 허용 목록 **모두**와 일치해야 합니다).
- 디스코드 폴백: `tools.elevated.allowFrom.discord`를 생략하면 `channels.discord.dm.allowFrom` 목록이 폴백으로 사용됩니다. 재정의하려면 `tools.elevated.allowFrom.discord`(심지어 `[]`)를 설정하세요. 에이전트별 허용 목록은 대체를 사용하지 **않습니다**.
- 모든 게이트는 통과해야 합니다. 그렇지 않으면 상승된 항목은 사용할 수 없는 것으로 처리됩니다.

## 로깅 + 상태

- 상승된 exec 호출은 정보 수준에서 기록됩니다.
- 세션 상태에는 승격 모드가 포함됩니다(예: `elevated=ask`, `elevated=full`).
