---
summary: "한 번의 에이전트 차례를 Gateway 를 통해 전송하기 위한 CLI 참조"
read_when:
  - 스크립트에서 한 번의 에이전트 차례를 실행하려고 할 때 (선택적으로 회신 전달)
title: "agent"
---

# `openclaw agent`

Gateway 를 통해 에이전트 차례를 실행합니다 (임베드된 경우 `--local` 사용).
구성된 에이전트를 직접 대상으로 하려면 `--agent <id>` 를 사용합니다.

관련 사항:

- 에이전트 전송 도구: [Agent send](/tools/agent-send)

## 예시

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/agent.md
workflow: 15
