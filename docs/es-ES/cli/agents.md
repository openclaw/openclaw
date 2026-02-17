---
summary: "Referencia CLI para `openclaw agents` (listar/añadir/eliminar/establecer identidad)"
read_when:
  - Quieres múltiples agentes aislados (espacios de trabajo + enrutamiento + autenticación)
title: "agents"
---

# `openclaw agents`

Gestionar agentes aislados (espacios de trabajo + autenticación + enrutamiento).

Relacionado:

- Enrutamiento multi-agente: [Enrutamiento Multi-Agente](/es-ES/concepts/multi-agent)
- Espacio de trabajo del agente: [Espacio de trabajo del agente](/es-ES/concepts/agent-workspace)

## Ejemplos

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## Archivos de identidad

Cada espacio de trabajo del agente puede incluir un `IDENTITY.md` en la raíz del espacio de trabajo:

- Ruta de ejemplo: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` lee desde la raíz del espacio de trabajo (o un `--identity-file` explícito)

Las rutas de avatar se resuelven en relación con la raíz del espacio de trabajo.

## Establecer identidad

`set-identity` escribe campos en `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (ruta relativa al espacio de trabajo, URL http(s), o URI de datos)

Cargar desde `IDENTITY.md`:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

Sobrescribir campos explícitamente:

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

Ejemplo de configuración:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
