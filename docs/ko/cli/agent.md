---
summary: "`openclaw agent`에 대한 CLI 참조 (Gateway(게이트웨이)를 통해 하나의 에이전트 턴을 전송)"
read_when:
  - 스크립트에서 하나의 에이전트 턴을 실행하려는 경우 (선택적으로 응답 전달)
title: "에이전트"
---

# `openclaw agent`

Gateway(게이트웨이)를 통해 에이전트 턴을 실행합니다 (임베디드의 경우 `--local` 사용).
구성된 에이전트를 직접 대상으로 지정하려면 `--agent <id>`를 사용하십시오.

관련 항목:

- Agent send 도구: [Agent send](/tools/agent-send)

## 예제

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
