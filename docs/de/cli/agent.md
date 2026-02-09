---
summary: "CLI-Referenz für `openclaw agent` (einen Agent-Zug über das Gateway senden)"
read_when:
  - Sie möchten einen Agent-Zug aus Skripten ausführen (optional Antwort zustellen)
title: "Agent"
---

# `openclaw agent`

Führen Sie einen Agent-Zug über das Gateway aus (verwenden Sie `--local` für eingebettete Nutzung).
Verwenden Sie `--agent <id>`, um einen konfigurierten Agent direkt anzusprechen.

Verwandt:

- Agent send tool: [Agent send](/tools/agent-send)

## Beispiele

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
