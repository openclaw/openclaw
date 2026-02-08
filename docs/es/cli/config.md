---
summary: "Referencia de la CLI para `openclaw config` (obtener/establecer/quitar valores de configuración)"
read_when:
  - Quiere leer o editar la configuración de forma no interactiva
title: "config"
x-i18n:
  source_path: cli/config.md
  source_hash: d60a35f5330f22bc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:46Z
---

# `openclaw config`

Ayudas de configuración: obtener/establecer/quitar valores por ruta. Ejecútelo sin un subcomando para abrir
el asistente de configuración (igual que `openclaw configure`).

## Ejemplos

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Rutas

Las rutas usan notación de punto o de corchetes:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Use el índice de la lista de agentes para dirigirse a un agente específico:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Valores

Los valores se analizan como JSON5 cuando es posible; de lo contrario se tratan como cadenas.
Use `--json` para exigir el análisis JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Reinicie el Gateway después de realizar ediciones.
