---
summary: "Sanggunian ng CLI para sa `openclaw logs` (pag-tail ng mga log ng Gateway sa pamamagitan ng RPC)"
read_when:
  - Kailangan mong i-tail ang mga log ng Gateway nang remote (nang walang SSH)
  - Gusto mo ng mga linya ng log na JSON para sa tooling
title: "mga log"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:19Z
---

# `openclaw logs`

I-tail ang mga file log ng Gateway sa pamamagitan ng RPC (gumagana sa remote mode).

Kaugnay:

- Pangkalahatang-ideya ng Logging: [Logging](/logging)

## Mga halimbawa

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
