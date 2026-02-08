---
summary: "CLI-referentie voor `openclaw agent` (verzend één agentbeurt via de Gateway)"
read_when:
  - Je wilt vanuit scripts één agentbeurt uitvoeren (optioneel het antwoord afleveren)
title: "agent"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:07Z
---

# `openclaw agent`

Voer één agentbeurt uit via de Gateway (gebruik `--local` voor embedded).
Gebruik `--agent <id>` om direct een geconfigureerde agent aan te spreken.

Gerelateerd:

- Agent send tool: [Agent send](/tools/agent-send)

## Voorbeelden

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
