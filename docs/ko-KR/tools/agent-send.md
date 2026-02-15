---
summary: "Direct `openclaw agent` CLI runs (with optional delivery)"
read_when:
  - Adding or modifying the agent CLI entrypoint
title: "Agent Send"
x-i18n:
  source_hash: a84d6a304333eebe155da2bf24cf5fc0482022a0a48ab34aa1465cd6e667022d
---

# `openclaw agent` (직접 에이전트 실행)

`openclaw agent`는 인바운드 채팅 메시지 없이 단일 에이전트 차례를 실행합니다.
기본적으로 **게이트웨이를 통해** 이동합니다. 강제로 삽입하려면 `--local`를 추가하세요.
현재 머신의 런타임.

## 행동

- 필수 : `--message <text>`
- 세션 선택:
  - `--to <dest>`는 세션 키를 파생합니다(그룹/채널 대상은 격리를 유지하고 직접 채팅은 `main`으로 축소됨), **또는**
  - `--session-id <id>`는 ID로 기존 세션을 재사용합니다. **또는**
  - `--agent <id>`는 구성된 에이전트를 직접 대상으로 지정합니다(해당 에이전트의 `main` 세션 키 사용).
- 일반 인바운드 응답과 동일한 포함된 에이전트 런타임을 실행합니다.
- Thinking/verbose 플래그는 세션 저장소에 유지됩니다.
- 출력:
  - 기본값: 응답 텍스트(+ `MEDIA:<url>` 행)를 인쇄합니다.
  - `--json`: 구조화된 페이로드 + 메타데이터를 인쇄합니다.
- `--deliver` + `--channel`를 사용하여 채널로 다시 전달하는 선택적 전달(대상 형식은 `openclaw message --target`와 일치).
- 세션을 변경하지 않고 전달을 무시하려면 `--reply-channel`/`--reply-to`/`--reply-account`를 사용하십시오.

게이트웨이에 연결할 수 없는 경우 CLI는 내장된 로컬 실행으로 **폴백**됩니다.

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
- `--channel`: 전달 채널(`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, 기본값: `whatsapp`)
- `--reply-to`: 배송 목표 무시
- `--reply-channel`: 전달 채널 재정의
- `--reply-account` : 배송 계좌 ID 재정의
- `--thinking <off|minimal|low|medium|high|xhigh>`: 지속적인 사고 수준 (GPT-5.2 + Codex 모델에만 해당)
- `--verbose <on|full|off>`: 자세한 수준 유지
- `--timeout <seconds>`: 에이전트 시간 초과 무시
- `--json`: 구조화된 JSON을 출력합니다.
