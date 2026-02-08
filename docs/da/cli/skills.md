---
summary: "CLI-reference for `openclaw skills` (list/info/check) og kvalificering af Skills"
read_when:
  - Du vil se, hvilke Skills der er tilgængelige og klar til at køre
  - Du vil fejlfinde manglende binære filer/miljøvariabler/konfiguration for Skills
title: "Skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:59Z
---

# `openclaw skills`

Inspicér Skills (bundtede + workspace + administrerede overrides) og se, hvad der er kvalificeret vs. manglende krav.

Relateret:

- Skills-system: [Skills](/tools/skills)
- Skills-konfiguration: [Skills config](/tools/skills-config)
- ClawHub-installationer: [ClawHub](/tools/clawhub)

## Commands

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
