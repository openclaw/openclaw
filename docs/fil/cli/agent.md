---
summary: "Sanggunian ng CLI para sa `openclaw agent` (magpadala ng isang agent turn sa pamamagitan ng Gateway)"
read_when:
  - Gusto mong magpatakbo ng isang agent turn mula sa mga script (opsyonal na ihatid ang tugon)
title: "agent"
---

# `openclaw agent`

26. Patakbuhin ang isang agent turn sa pamamagitan ng Gateway (gamitin ang `--local` para sa embedded).
27. Gamitin ang `--agent <id>` upang direktang i-target ang isang naka-configure na agent.

Kaugnay:

- Tool ng Agent send: [Agent send](/tools/agent-send)

## Mga halimbawa

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
