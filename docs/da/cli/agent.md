---
summary: "CLI-reference for `openclaw agent` (send én agenttur via Gateway)"
read_when:
  - Du vil køre én agenttur fra scripts (valgfrit levere svar)
title: "agent"
---

# `openclaw agent`

Kør en agent tur via Gateway (brug `--local` for indlejret).
Brug `--agent <id>` for at målrette en konfigureret agent direkte.

Relateret:

- Agent send-værktøj: [Agent send](/tools/agent-send)

## Eksempler

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
