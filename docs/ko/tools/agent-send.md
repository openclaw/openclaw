---
summary: "직접 `openclaw agent` CLI 실행 (선택적 전달 포함)"
read_when:
  - 에이전트 CLI 엔트리포인트를 추가하거나 수정할 때
title: "Agent Send"
---

# `openclaw agent` (직접 에이전트 실행)

`openclaw agent` 는 인바운드 채팅 메시지 없이 단일 에이전트 턴을 실행합니다.
기본적으로 **Gateway(게이트웨이)** 를 **통과** 하며, 현재 머신의 내장
런타임을 강제하려면 `--local` 를 추가하십시오.

## 동작

- 필수: `--message <text>`
- 세션 선택:
  - `--to <dest>` 가 세션 키를 파생합니다 (그룹/채널 대상은 격리를 유지하며, 다이렉트 채팅은 `main` 로 병합됨), **또는**
  - `--session-id <id>` 가 id 로 기존 세션을 재사용합니다, **또는**
  - `--agent <id>` 가 구성된 에이전트를 직접 대상으로 지정합니다 (해당 에이전트의 `main` 세션 키 사용)
- 일반 인바운드 응답과 동일한 내장 에이전트 런타임을 실행합니다.
- Thinking/verbose 플래그는 세션 스토어에 유지됩니다.
- 출력:
  - 기본값: 응답 텍스트 출력 (`MEDIA:<url>` 라인 포함)
  - `--json`: 구조화된 페이로드 + 메타데이터 출력
- `--deliver` + `--channel` 로 채널로의 선택적 전달 (대상 형식은 `openclaw message --target` 와 일치).
- 세션을 변경하지 않고 전달을 재정의하려면 `--reply-channel`/`--reply-to`/`--reply-account` 를 사용하십시오.

Gateway(게이트웨이) 에 도달할 수 없는 경우, CLI 는 내장 로컬 실행으로 **폴백** 합니다.

## Examples

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## 플래그

- `--local`: 로컬에서 실행 (셸에 모델 프로바이더 API 키 필요)
- `--deliver`: 선택한 채널로 응답 전송
- `--channel`: 전달 채널 (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, 기본값: `whatsapp`)
- `--reply-to`: 전달 대상 재정의
- `--reply-channel`: 전달 채널 재정의
- `--reply-account`: 전달 계정 id 재정의
- `--thinking <off|minimal|low|medium|high|xhigh>`: thinking 레벨 유지 (GPT-5.2 + Codex 모델만 해당)
- `--verbose <on|full|off>`: verbose 레벨 유지
- `--timeout <seconds>`: 에이전트 타임아웃 재정의
- `--json`: 구조화된 JSON 출력
