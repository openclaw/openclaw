---
summary: "Reference CLI pour `openclaw setup` (initialisation de la configuration + de l’espace de travail)"
read_when:
  - Vous effectuez une configuration de premier lancement sans l’assistant de prise en main complet
  - Vous souhaitez definir le chemin par defaut de l’espace de travail
title: "setup"
x-i18n:
  source_path: cli/setup.md
  source_hash: 7f3fc8b246924edf
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:58Z
---

# `openclaw setup`

Initialiser `~/.openclaw/openclaw.json` et l’espace de travail de l’agent.

Liens associes :

- Premiers pas : [Getting started](/start/getting-started)
- Assistant : [Onboarding](/start/onboarding)

## Exemples

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

Pour lancer l’assistant via setup :

```bash
openclaw setup --wizard
```
