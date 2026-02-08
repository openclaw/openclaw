---
summary: "CLI-Referenz für `openclaw skills` (list/info/check) und die Eignung von Skills"
read_when:
  - Sie möchten sehen, welche Skills verfügbar und einsatzbereit sind
  - Sie möchten fehlende Binaries/Umgebungsvariablen/Konfigurationen für Skills debuggen
title: "Skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:40Z
---

# `openclaw skills`

Untersuchen Sie Skills (gebündelt + Workspace + verwaltete Overrides) und sehen Sie, was einsatzfähig ist bzw. welche Anforderungen fehlen.

Verwandt:

- Skills-System: [Skills](/tools/skills)
- Skills-Konfiguration: [Skills config](/tools/skills-config)
- ClawHub-Installationen: [ClawHub](/tools/clawhub)

## Befehle

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
