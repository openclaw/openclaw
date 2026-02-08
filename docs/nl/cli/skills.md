---
summary: "CLI-referentie voor `openclaw skills` (list/info/check) en geschiktheid van Skills"
read_when:
  - Je wilt zien welke Skills beschikbaar zijn en klaar om te draaien
  - Je wilt ontbrekende binaries/omgevingsvariabelen/configuratie voor Skills debuggen
title: "skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:08Z
---

# `openclaw skills`

Inspecteer Skills (gebundeld + werkruimte + beheerde overrides) en zie wat geschikt is versus ontbrekende vereisten.

Gerelateerd:

- Skills-systeem: [Skills](/tools/skills)
- Skills-config: [Skills config](/tools/skills-config)
- ClawHub-installaties: [ClawHub](/tools/clawhub)

## Opdrachten

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
