---
summary: "`openclaw system` (시스템 이벤트, 하트비트, 존재) CLI 참조"
read_when:
  - 크론 작업을 생성하지 않고 시스템 이벤트를 대기열에 추가하고 싶을 때
  - 하트비트를 활성화 또는 비활성화해야 할 때
  - 시스템 존재 항목을 검사하고 싶을 때
title: "system"
---

# `openclaw system`

게이트웨이를 위한 시스템 수준 도우미: 시스템 이벤트를 대기열에 추가하고 하트비트를 제어하며 존재를 조회합니다.

## 일반적인 명령어

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

**메인** 세션에 시스템 이벤트를 대기열에 추가합니다. 다음 하트비트는 이 이벤트를 `System:` 라인으로 프롬프트에 주입합니다. `--mode now`를 사용하여 하트비트를 즉시 트리거하거나 `next-heartbeat`로 다음 예약된 틱을 기다립니다.

플래그:

- `--text <text>`: 필수 시스템 이벤트 텍스트.
- `--mode <mode>`: `now` 또는 기본값인 `next-heartbeat`.
- `--json`: 기계가 읽을 수 있는 출력.

## `system heartbeat last|enable|disable`

하트비트 제어:

- `last`: 마지막 하트비트 이벤트를 표시합니다.
- `enable`: 하트비트를 다시 활성화합니다 (비활성화된 경우 사용).
- `disable`: 하트비트를 일시 중지합니다.

플래그:

- `--json`: 기계가 읽을 수 있는 출력.

## `system presence`

게이트웨이가 알고 있는 현재 시스템 존재 항목 (노드, 인스턴스, 유사 상태 라인)을 나열합니다.

플래그:

- `--json`: 기계가 읽을 수 있는 출력.

## 주의사항

- 현재 설정에 의해 접근 가능한 실행 중인 게이트웨이가 필요합니다 (로컬 또는 원격).
- 시스템 이벤트는 임시적이며 재시작 후에는 유지되지 않습니다.
