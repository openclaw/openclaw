---
summary: "Elevated exec 모드와 /elevated 지시문"
read_when:
  - Elevated 모드 기본값, 허용 목록, 또는 슬래시 명령 동작을 조정할 때
title: "Elevated 모드"
---

# Elevated 모드 (/elevated 지시문)

## 무엇을 하는가

- `/elevated on` 는 게이트웨이 호스트에서 실행되며 exec 승인( `/elevated ask` 와 동일)을 유지합니다.
- `/elevated full` 는 게이트웨이 호스트에서 실행되며 exec 를 자동 승인합니다(exec 승인을 건너뜁니다).
- `/elevated ask` 는 게이트웨이 호스트에서 실행되지만 exec 승인을 유지합니다( `/elevated on` 와 동일).
- `on`/`ask` 는 `exec.security=full` 를 **강제하지 않습니다**; 구성된 보안/질문 정책이 그대로 적용됩니다.
- 에이전트가 **샌드박스화된** 경우에만 동작을 변경합니다(그 외에는 exec 가 이미 호스트에서 실행됩니다).
- 지시문 형식: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- `on|off|ask|full` 만 허용되며, 그 외에는 힌트를 반환하고 상태를 변경하지 않습니다.

## 제어하는 것(및 제어하지 않는 것)

- **가용성 게이트**: `tools.elevated` 는 전역 기준선입니다. `agents.list[].tools.elevated` 는 에이전트별로 elevated 를 추가로 제한할 수 있습니다(둘 다 허용되어야 함).
- **세션별 상태**: `/elevated on|off|ask|full` 는 현재 세션 키에 대한 elevated 수준을 설정합니다.
- **인라인 지시문**: 메시지 안의 `/elevated on|ask|full` 는 해당 메시지에만 적용됩니다.
- **그룹**: 그룹 채팅에서는 에이전트가 멘션된 경우에만 elevated 지시문이 적용됩니다. 멘션 요구 사항을 우회하는 명령 전용 메시지는 멘션된 것으로 처리됩니다.
- **호스트 실행**: elevated 는 `exec` 를 게이트웨이 호스트로 강제하며, `full` 는 `security=full` 도 설정합니다.
- **승인**: `full` 는 exec 승인을 건너뜁니다; `on`/`ask` 는 허용 목록/질문 규칙이 요구하는 경우 이를 준수합니다.
- **비샌드박스 에이전트**: 위치에 대해서는 무효이며, 게이팅·로깅·상태에만 영향을 줍니다.
- **도구 정책은 계속 적용됨**: `exec` 가 도구 정책에 의해 거부되면 elevated 를 사용할 수 없습니다.
- **`/exec` 와는 별개**: `/exec` 는 승인된 발신자에 대한 세션별 기본값을 조정하며 elevated 가 필요하지 않습니다.

## 해석 순서

1. 메시지의 인라인 지시문(해당 메시지에만 적용).
2. 세션 재정의(지시문만 있는 메시지를 전송하여 설정).
3. 전역 기본값(구성의 `agents.defaults.elevatedDefault`).

## 세션 기본값 설정

- 지시문만 있는 메시지를 전송합니다(공백 허용). 예: `/elevated full`.
- 확인 응답이 전송됩니다(`Elevated mode set to full...` / `Elevated mode disabled.`).
- elevated 접근이 비활성화되어 있거나 발신자가 승인된 허용 목록에 없으면, 지시문은 실행 가능한 오류를 반환하고 세션 상태를 변경하지 않습니다.
- 현재 elevated 수준을 보려면 인자 없이 `/elevated`(또는 `/elevated:`) 를 전송합니다.

## 가용성 + 허용 목록

- 기능 게이트: `tools.elevated.enabled`(코드가 지원하더라도 구성으로 기본값을 끌 수 있음).
- 발신자 허용 목록: `tools.elevated.allowFrom` 및 프로바이더별 허용 목록(예: `discord`, `whatsapp`).
- 에이전트별 게이트: `agents.list[].tools.elevated.enabled`(선택 사항; 추가로 제한만 가능).
- 에이전트별 허용 목록: `agents.list[].tools.elevated.allowFrom`(선택 사항; 설정된 경우 발신자는 전역 + 에이전트별 허용 목록 **모두**와 일치해야 함).
- Discord 대체 규칙: `tools.elevated.allowFrom.discord` 가 생략되면 `channels.discord.dm.allowFrom` 목록이 대체로 사용됩니다. 이를 재정의하려면 `tools.elevated.allowFrom.discord`(심지어 `[]`) 를 설정하십시오. 에이전트별 허용 목록에는 대체 규칙이 적용되지 않습니다.
- 모든 게이트를 통과해야 하며, 그렇지 않으면 elevated 는 사용 불가로 처리됩니다.

## 로깅 + 상태

- Elevated exec 호출은 info 레벨로 로깅됩니다.
- 세션 상태에는 elevated 모드가 포함됩니다(예: `elevated=ask`, `elevated=full`).
