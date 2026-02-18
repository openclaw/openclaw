---
summary: "`openclaw agent` CLI 참조 (게이트웨이를 통해 하나의 에이전트 턴 전송)"
read_when:
  - 스크립트에서 하나의 에이전트 턴을 실행하고자 할 때 (선택적으로 응답 전송)
title: "에이전트"
---

# `openclaw agent`

게이트웨이를 통해 에이전트 턴을 실행합니다 (`--local`을 사용하여 임베디드로 실행 가능).
`--agent <id>`를 사용하여 설정된 에이전트를 직접 대상으로 지정할 수 있습니다.

관련 항목:

- 에이전트 전송 도구: [에이전트 전송](/tools/agent-send)

## 예시

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
