---
summary: "Referencia CLI para `openclaw config` (obtener/establecer/desestablecer valores de configuración)"
read_when:
  - Quieres leer o editar la configuración de forma no interactiva
title: "config"
---

# `openclaw config`

Ayudantes de configuración: obtener/establecer/desestablecer valores por ruta. Ejecuta sin un subcomando para abrir
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

Las rutas usan notación de punto o corchetes:

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Usa el índice de la lista de agentes para apuntar a un agente específico:

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Valores

Los valores se analizan como JSON5 cuando es posible; de lo contrario se tratan como cadenas.
Usa `--json` para requerir análisis JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Reinicia el gateway después de las ediciones.
