---
summary: "Direct `openclaw agent` CLI runs (with optional delivery)"
read_when:
  - Adding or modifying the agent CLI entrypoint
title: "Agent Send"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/tools/agent-send.md
workflow: 15
---

# `openclaw agent` (direct agent runs)

`openclaw agent` 명령은 인바운드 채팅 메시지 없이 단일 agent 턴을 실행합니다.
기본적으로 **Gateway 를 통해** 실행되며, `--local` 플래그를 추가하여 현재 머신의 임베디드
런타임을 강제할 수 있습니다.

## Behavior

- 필수: `--message <text>`
- Session 선택:
  - `--to <dest>` - session key 유도 (그룹/채널 타겟은 격리 유지; 직접 채팅은 `main` 으로 축소), **또는**
  - `--session-id <id>` - 기존 session ID 재사용, **또는**
  - `--agent <id>` - 설정된 agent 직접 타겟 (해당 agent 의 `main` session key 사용)
- 인바운드 답변과 동일한 임베디드 agent 런타임 실행
- Thinking/verbose 플래그는 session 저장소에 유지됨
- 출력:
  - 기본: 답변 텍스트 출력 (plus `MEDIA:<url>` 라인)
  - `--json`: 구조화된 페이로드 + 메타데이터 출력
- `--deliver` + `--channel` 으로 채널에 다시 배송 가능 (타겟 형식은 `openclaw message --target` 과 일치)
- `--reply-channel`/`--reply-to`/`--reply-account` 를 사용하여 session 변경 없이 배송 재정의

Gateway 에 연결할 수 없으면, CLI 는 **fallback** 하여 로컬 임베디드 실행을 수행합니다.

## Examples

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Flags

- `--local`: 로컬 실행 (shell 에서 model provider API 키 필요)
- `--deliver`: 선택한 채널에 답변 전송
- `--channel`: 배송 채널 (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, 기본값: `whatsapp`)
- `--reply-to`: 배송 타겟 재정의
- `--reply-channel`: 배송 채널 재정의
- `--reply-account`: 배송 계정 id 재정의
- `--thinking <off|minimal|low|medium|high|xhigh>`: thinking 수준 유지 (GPT-5.2 + Codex 모델만)
- `--verbose <on|full|off>`: verbose 수준 유지
- `--timeout <seconds>`: agent timeout 재정의
- `--json`: 구조화된 JSON 출력
