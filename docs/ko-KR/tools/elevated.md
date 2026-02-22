---
summary: "Elevated exec mode and /elevated directives"
read_when:
  - Elevated 모드 기본값, 허용 목록 또는 슬래시 명령어 동작을 조정할 때
title: "Elevated Mode"
---

# Elevated Mode (/elevated directives)

## What it does

- `/elevated on`은 게이트웨이 호스트에서 실행되며 exec 승인을 유지합니다(또는 `/elevated ask`와 동일합니다).
- `/elevated full`은 게이트웨이 호스트에서 **실행**되고 exec를 자동 승인합니다(exec 승인을 건너뜁니다).
- `/elevated ask`은 게이트웨이 호스트에서 실행되지만 exec 승인을 유지합니다(또는 `/elevated on`과 동일합니다).
- `on`/`ask`는 `exec.security=full`을 강제하지 **않습니다**; 구성된 보안/질의 정책은 여전히 적용됩니다.
- 에이전트가 **샌드박스 격리**될 때만 동작을 변경합니다(그렇지 않으면 exec가 이미 호스트에서 실행됩니다).
- 지시문의 형식: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- `on|off|ask|full`만 허용됩니다; 그 외의 입력은 힌트를 반환하고 상태를 변경하지 않습니다.

## What it controls (and what it doesn’t)

- **사용 가능성 게이트**: `tools.elevated`는 전역 기초입니다. `agents.list[].tools.elevated`는 에이전트별로 추가로 승격을 제한할 수 있습니다(둘 다 허용해야 합니다).
- **세션별 상태**: `/elevated on|off|ask|full`은 현재 세션 키의 승격 수준을 설정합니다.
- **인라인 지시문**: 메시지 내의 `/elevated on|ask|full`은 해당 메시지에만 적용됩니다.
- **그룹**: 그룹 채팅에서는 에이전트가 언급될 때만 승격 지시문이 인식됩니다. 언급 요구사항을 우회하는 명령어 전용 메시지는 언급된 것으로 처리됩니다.
- **호스트 실행**: 승격은 게이트웨이 호스트에서 `exec`를 강제하며; `full`은 여기에 `security=full`도 설정합니다.
- **승인들**: `full`은 exec 승인을 건너뛰며; `on`/`ask`는 허용 목록/질의 규칙이 요구할 때 이를 준수합니다.
- **샌드박스 격리되지 않은 에이전트들**: 위치에 대한 작동 없음; 차단, 로깅 및 상태에만 영향을 줍니다.
- **도구 정책 여전히 적용**: 도구 정책에 의해 `exec`가 거부되면 승격을 사용할 수 없습니다.
- **`/exec`과 분리됨**: `/exec`는 인증된 발신자에 대해 세션 기본값을 조정하며 승격이 필요하지 않습니다.

## Resolution order

1. 메시지의 인라인 지시문 (해당 메시지에만 적용).
2. 세션 오버라이드 (지시문 전용 메시지를 보내 설정).
3. 글로벌 기본값 (구성의 `agents.defaults.elevatedDefault`).

## Setting a session default

- 지시문만 포함된 메시지를 전송합니다 (공백 허용), 예: `/elevated full`.
- 확인 응답이 전송됩니다 (`Elevated mode set to full...` / `Elevated mode disabled.`).
- 승급된 접근이 비활성화되었거나 발신자가 승인된 허용 목록에 없을 경우, 지시문은 실행 가능한 오류와 함께 응답하며 세션 상태를 변경하지 않습니다.
- `/elevated` (또는 `/elevated:`)를 인수 없이 보내서 현재 승급 수준을 확인할 수 있습니다.

## Availability + allowlists

- 기능 게이트: `tools.elevated.enabled` (설정이 허용하더라도 기본적으로 비활성화 가능).
- 발신자 허용 목록: `tools.elevated.allowFrom`으로 프로바이더별 허용 목록 (예: `discord`, `whatsapp`).
- 에이전트별 게이트: `agents.list[].tools.elevated.enabled` (선택적; 추가로 제한할 수만 있음).
- 에이전트별 허용 목록: `agents.list[].tools.elevated.allowFrom` (선택적; 설정 시 발신자는 전역 및 에이전트별 허용 목록에 모두 일치해야 함).
- Discord 대체: `tools.elevated.allowFrom.discord`가 생략되면 `channels.discord.allowFrom` 목록이 대체로 사용됩니다 (레거시: `channels.discord.dm.allowFrom`). `tools.elevated.allowFrom.discord` (빈 배열이라도)로 덮어씌울 수 있습니다. 에이전트별 허용 목록은 대체를 사용하지 **않습니다**.
- 모든 게이트가 통과해야 하며, 그렇지 않으면 승급이 사용 불가능으로 처리됩니다.

## Logging + status

- 승격된 exec 호출은 정보 수준으로 기록됩니다.
- 세션 상태에는 승급 모드가 포함됩니다 (예: `elevated=ask`, `elevated=full`).