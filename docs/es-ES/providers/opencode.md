---
summary: "Usa OpenCode Zen (modelos curados) con OpenClaw"
read_when:
  - Quieres OpenCode Zen para acceso a modelos
  - Quieres una lista curada de modelos amigables para codificación
title: "OpenCode Zen"
---

# OpenCode Zen

OpenCode Zen es una **lista curada de modelos** recomendados por el equipo de OpenCode para agentes de codificación.
Es una ruta opcional y hospedada de acceso a modelos que usa una clave de API y el proveedor `opencode`.
Zen está actualmente en beta.

## Configuración mediante CLI

```bash
openclaw onboard --auth-choice opencode-zen
# o no interactivo
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

- `OPENCODE_ZEN_API_KEY` también está soportado.
- Inicias sesión en Zen, agregas detalles de facturación y copias tu clave de API.
- OpenCode Zen factura por solicitud; consulta el panel de OpenCode para detalles.
