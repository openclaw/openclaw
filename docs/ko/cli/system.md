---
read_when:
    - 크론 작업을 생성하지 않고 시스템 이벤트를 대기열에 추가하고 싶습니다.
    - 하트비트를 활성화하거나 비활성화해야 합니다.
    - 시스템 존재 항목을 검사하고 싶습니다.
summary: '`openclaw system`에 대한 CLI 참조(시스템 이벤트, 하트비트, 존재)'
title: 체계
x-i18n:
    generated_at: "2026-02-08T15:51:16Z"
    model: gtx
    provider: google-translate
    source_hash: 36ae5dbdec327f5a32f7ef44bdc1f161bad69868de62f5071bb4d25a71bfdfe9
    source_path: cli/system.md
    workflow: 15
---

# `openclaw system`

게이트웨이용 시스템 수준 도우미: 시스템 이벤트 대기열에 추가, 하트비트 제어,
현재 상태를 확인하세요.

## 일반적인 명령

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

시스템 이벤트를 대기열에 추가합니다. **기본** 세션. 다음 심장 박동이 주입됩니다
그것을 `System:` 프롬프트의 줄. 사용 `--mode now` 심장박동을 일으키기 위해
즉시; `next-heartbeat` 다음 예정된 틱을 기다립니다.

플래그:

- `--text <text>`: 필수 시스템 이벤트 텍스트입니다.
- `--mode <mode>`: `now` 또는 `next-heartbeat` (기본).
- `--json`: 기계가 읽을 수 있는 출력.

## `system heartbeat last|enable|disable`

하트비트 제어:

- `last`: 마지막 하트비트 이벤트를 표시합니다.
- `enable`: 하트비트를 다시 켭니다(비활성화된 경우 사용).
- `disable`: 심장박동을 일시중지합니다.

플래그:

- `--json`: 기계가 읽을 수 있는 출력.

## `system presence`

게이트웨이가 알고 있는 현재 시스템 존재 항목(노드,
인스턴스 및 유사한 상태 줄).

플래그:

- `--json`: 기계가 읽을 수 있는 출력.

## 메모

- 현재 구성(로컬 또는 원격)에서 연결할 수 있는 실행 중인 게이트웨이가 필요합니다.
- 시스템 이벤트는 일시적이며 다시 시작해도 지속되지 않습니다.
