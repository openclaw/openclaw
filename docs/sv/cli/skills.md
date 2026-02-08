---
summary: "CLI-referens för `openclaw skills` (list/info/check) och behörighet för Skills"
read_when:
  - Du vill se vilka Skills som är tillgängliga och redo att köras
  - Du vill felsöka saknade binärer/miljövariabler/konfig för Skills
title: "Skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:48Z
---

# `openclaw skills`

Inspektera Skills (paketerade + arbetsyta + hanterade åsidosättningar) och se vad som är behörigt jämfört med saknade krav.

Relaterat:

- Skills-system: [Skills](/tools/skills)
- Skills-konfig: [Skills config](/tools/skills-config)
- ClawHub-installationer: [ClawHub](/tools/clawhub)

## Kommandon

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
