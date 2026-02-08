---
read_when:
    - 스크립트에서 하나의 에이전트 차례를 실행하려고 합니다(선택적으로 응답 전달).
summary: '`openclaw agent`에 대한 CLI 참조(게이트웨이를 통해 하나의 에이전트 차례 보내기)'
title: 대리인
x-i18n:
    generated_at: "2026-02-08T15:52:02Z"
    model: gtx
    provider: google-translate
    source_hash: dcf12fb94e207c68645f58235792596d65afecf8216b8f9ab3acb01e03b50a33
    source_path: cli/agent.md
    workflow: 15
---

# `openclaw agent`

게이트웨이를 통해 에이전트 차례를 실행합니다(사용 `--local` 임베디드용).
사용 `--agent <id>` 구성된 에이전트를 직접 대상으로 지정합니다.

관련된:

- 에이전트 전송 도구: [에이전트 보내기](/tools/agent-send)

## 예

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
