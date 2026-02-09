---
summary: "Use OpenCode Zen (modelos curados) con OpenClaw"
read_when:
  - Quiere OpenCode Zen para el acceso a modelos
  - Quiere una lista curada de modelos amigables para la codificación
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen es una **lista curada de modelos** recomendados por el equipo de OpenCode para agentes de codificación.
Es una ruta opcional y alojada de acceso a modelos que usa una clave de API y el proveedor `opencode`.
Actualmente, Zen está en beta.

## Configuración de la CLI

```bash
openclaw onboard --auth-choice opencode-zen
# or non-interactive
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

## Fragmento de configuración

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Notas

- `OPENCODE_ZEN_API_KEY` también es compatible.
- Usted inicia sesión en Zen, agrega los detalles de facturación y copia su clave de API.
- OpenCode Zen factura por solicitud; consulte el panel de OpenCode para obtener detalles.
