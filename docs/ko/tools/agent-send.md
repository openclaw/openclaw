---
read_when:
    - 에이전트 CLI 진입점 추가 또는 수정
summary: 직접 `openclaw agent` CLI 실행(선택적 전달 포함)
title: 에이전트 보내기
x-i18n:
    generated_at: "2026-02-08T16:02:54Z"
    model: gtx
    provider: google-translate
    source_hash: a84d6a304333eebe155da2bf24cf5fc0482022a0a48ab34aa1465cd6e667022d
    source_path: tools/agent-send.md
    workflow: 15
---

# `openclaw agent` (직접 에이전트가 실행됨)

`openclaw agent` 인바운드 채팅 메시지 없이 단일 에이전트 차례를 실행합니다.
기본적으로는 **게이트웨이를 통해**; 추가하다 `--local` 강제로 내장시키려고
현재 머신의 런타임.

## 행동

- 필수의: `--message <text>`
- 세션 선택:
  - `--to <dest>` 세션 키를 파생합니다(그룹/채널 대상은 격리를 유지하고 직접 채팅은 다음으로 축소됩니다). `main`), **또는**
  - `--session-id <id>` ID별로 기존 세션을 재사용합니다. **또는**
  - `--agent <id>` 구성된 에이전트를 직접 대상으로 지정합니다(해당 에이전트의 `main` 세션 키)
- 일반 인바운드 응답과 동일한 포함된 에이전트 런타임을 실행합니다.
- Thinking/verbose 플래그는 세션 저장소에 유지됩니다.
- 산출:
  - 기본값: 응답 텍스트를 인쇄합니다(+ `MEDIA:<url>` 윤곽)
  - `--json`: 구조화된 페이로드 + 메타데이터를 인쇄합니다.
- 선택적으로 채널로 다시 전달 `--deliver` + `--channel` (대상 형식이 일치함 `openclaw message --target`).
- 사용 `--reply-channel`/`--reply-to`/`--reply-account` 세션을 변경하지 않고 전달을 무시합니다.

게이트웨이에 연결할 수 없는 경우 CLI **뒤로 넘어지다** 임베디드 로컬 실행에.

## 예

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## 플래그

- `--local`: 로컬로 실행(셸에 모델 공급자 API 키가 필요함)
- `--deliver`: 선택한 채널로 응답을 보냅니다.
- `--channel`: 배송채널(`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, 기본: `whatsapp`)
- `--reply-to`: 배송 목표 재정의
- `--reply-channel`: 전달 채널 재정의
- `--reply-account`: 배송 계정 ID 재정의
- `--thinking <off|minimal|low|medium|high|xhigh>`: 지속적인 사고 수준(GPT-5.2 + Codex 모델만 해당)
- `--verbose <on|full|off>`: 자세한 수준 유지
- `--timeout <seconds>`: 에이전트 시간 초과 무시
- `--json`: 구조화된 JSON 출력
