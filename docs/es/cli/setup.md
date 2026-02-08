---
summary: "Referencia de la CLI para `openclaw setup` (inicializar configuración + espacio de trabajo)"
read_when:
  - Está realizando la configuración inicial sin el asistente completo de onboarding
  - Quiere establecer la ruta predeterminada del espacio de trabajo
title: "configuración"
x-i18n:
  source_path: cli/setup.md
  source_hash: 7f3fc8b246924edf
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:03Z
---

# `openclaw setup`

Inicialice `~/.openclaw/openclaw.json` y el espacio de trabajo del agente.

Relacionado:

- Primeros pasos: [Primeros pasos](/start/getting-started)
- Asistente: [Onboarding](/start/onboarding)

## Ejemplos

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

Para ejecutar el asistente mediante setup:

```bash
openclaw setup --wizard
```
