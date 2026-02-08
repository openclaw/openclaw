---
summary: "Sanggunian ng CLI para sa `openclaw agent` (magpadala ng isang agent turn sa pamamagitan ng Gateway)"
read_when:
  - Gusto mong magpatakbo ng isang agent turn mula sa mga script (opsyonal na ihatid ang tugon)
title: "agent"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:18Z
---

# `openclaw agent`

Magpatakbo ng isang agent turn sa pamamagitan ng Gateway (gamitin ang `--local` para sa embedded).
Gamitin ang `--agent <id>` para direktang i-target ang isang naka-configure na agent.

Kaugnay:

- Tool ng Agent send: [Agent send](/tools/agent-send)

## Mga halimbawa

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
