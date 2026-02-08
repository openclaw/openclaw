---
summary: "CLI-reference for `openclaw agent` (send én agenttur via Gateway)"
read_when:
  - Du vil køre én agenttur fra scripts (valgfrit levere svar)
title: "agent"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:54Z
---

# `openclaw agent`

Kør en agenttur via Gateway (brug `--local` for embedded).
Brug `--agent <id>` til at målrette en konfigureret agent direkte.

Relateret:

- Agent send-værktøj: [Agent send](/tools/agent-send)

## Eksempler

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
