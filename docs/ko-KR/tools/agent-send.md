---
summary: "직접 `openclaw agent` CLI 실행 (선택적 전달 포함)"
read_when:
  - 에이전트 CLI 엔트리포인트 추가 또는 수정 시
title: "Agent Send"
---

# `openclaw agent` (직접 에이전트 실행)

`openclaw agent`는 수신 채팅 메시지가 필요 없이 단일 에이전트 턴을 실행합니다.
기본적으로 **게이트웨이를 통해** 실행되며, `--local`을 추가해 현재 머신에서 내장 런타임을 강제할 수 있습니다.

## 동작

- 필수: `--message <text>`
- 세션 선택:
  - `--to <dest>`는 세션 키를 유도합니다 (그룹/채널 대상은 격리를 유지하며, 직접 채팅은 `main`으로 통합됨), **또는**
  - `--session-id <id>`는 ID로 기존 세션을 재사용하고, **또는**
  - `--agent <id>`는 설정된 에이전트를 직접 타겟팅합니다 (해당 에이전트의 `main` 세션 키를 사용)
- 일반적인 수신 응답과 동일한 내장 에이전트 런타임을 실행합니다.
- 사고/상세 플래그는 세션 저장소에 지속됩니다.
- 출력:
  - 기본: 응답 텍스트를 출력 (그리고 `MEDIA:<url>` 줄)
  - `--json`: 구조화된 페이로드 + 메타데이터 출력
- `--deliver` + `--channel`로 채널로 선택적 전달 가능 (`openclaw message --target`과 일치하는 대상 양식).
- 세션을 변경하지 않고 전달을 덮어쓰려면 `--reply-channel`/`--reply-to`/`--reply-account`를 사용합니다.

게이트웨이에 접근할 수 없으면 CLI는 **로컬 내장 실행으로 대체**됩니다.

## 예시

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## 플래그

- `--local`: 로컬에서 실행 (모델 프로바이더 API 키가 쉘에 필요)
- `--deliver`: 선택한 채널로 응답 전송
- `--channel`: 전달 채널 (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, 기본: `whatsapp`)
- `--reply-to`: 전달 대상 덮어쓰기
- `--reply-channel`: 전달 채널 덮어쓰기
- `--reply-account`: 전달 계정 ID 덮어쓰기
- `--thinking <off|minimal|low|medium|high|xhigh>`: 사고 수준 지속 (GPT-5.2 + Codex 모델 전용)
- `--verbose <on|full|off>`: 상세 수준 지속
- `--timeout <seconds>`: 에이전트 타임아웃 덮어쓰기
- `--json`: 구조화된 JSON 출력
