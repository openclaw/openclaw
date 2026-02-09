---
summary: "CLI-referens för `openclaw agent` (skicka en agenttur via Gateway)"
read_when:
  - Du vill köra en agenttur från skript (valfritt leverera svar)
title: "agent"
---

# `openclaw agent`

Kör en agent sväng via Gateway (använd `--local` för inbäddad).
Använd `--agent <id>` för att rikta en konfigurerad agent direkt.

Relaterat:

- Agent send-verktyg: [Agent send](/tools/agent-send)

## Exempel

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
