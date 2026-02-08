---
summary: "CLI-referens för `openclaw agent` (skicka en agenttur via Gateway)"
read_when:
  - Du vill köra en agenttur från skript (valfritt leverera svar)
title: "agent"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:34Z
---

# `openclaw agent`

Kör en agenttur via Gateway (använd `--local` för inbäddat).
Använd `--agent <id>` för att rikta in dig på en konfigurerad agent direkt.

Relaterat:

- Agent send-verktyg: [Agent send](/tools/agent-send)

## Exempel

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
