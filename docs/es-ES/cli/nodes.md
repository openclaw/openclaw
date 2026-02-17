---
summary: "Referencia CLI para `openclaw nodes` (listar/estado/aprobar/invocar, cámara/lienzo/pantalla)"
read_when:
  - Estás gestionando nodos emparejados (cámaras, pantalla, lienzo)
  - Necesitas aprobar solicitudes o invocar comandos de nodo
title: "nodes"
---

# `openclaw nodes`

Gestionar nodos emparejados (dispositivos) e invocar capacidades de nodo.

Relacionado:

- Resumen de nodos: [Nodos](/es-ES/nodes)
- Cámara: [Nodos de cámara](/es-ES/nodes/camera)
- Imágenes: [Nodos de imagen](/es-ES/nodes/images)

Opciones comunes:

- `--url`, `--token`, `--timeout`, `--json`

## Comandos comunes

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` imprime tablas pendientes/emparejadas. Las filas emparejadas incluyen la edad de conexión más reciente (Last Connect).
Usa `--connected` para mostrar solo nodos actualmente conectados. Usa `--last-connected <duration>` para
filtrar a nodos que se conectaron dentro de una duración (ej. `24h`, `7d`).

## Invocar / ejecutar

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Flags de invocación:

- `--params <json>`: cadena de objeto JSON (predeterminado `{}`).
- `--invoke-timeout <ms>`: tiempo de espera de invocación de nodo (predeterminado `15000`).
- `--idempotency-key <key>`: clave de idempotencia opcional.

### Predeterminados estilo exec

`nodes run` refleja el comportamiento exec del modelo (predeterminados + aprobaciones):

- Lee `tools.exec.*` (más sobrescrituras `agents.list[].tools.exec.*`).
- Usa aprobaciones exec (`exec.approval.request`) antes de invocar `system.run`.
- `--node` puede omitirse cuando `tools.exec.node` está establecido.
- Requiere un nodo que anuncie `system.run` (app complementaria de macOS o host de nodo sin cabeza).

Flags:

- `--cwd <path>`: directorio de trabajo.
- `--env <key=val>`: sobrescritura de env (repetible). Nota: los hosts de nodo ignoran sobrescrituras de `PATH` (y `tools.exec.pathPrepend` no se aplica a hosts de nodo).
- `--command-timeout <ms>`: tiempo de espera del comando.
- `--invoke-timeout <ms>`: tiempo de espera de invocación de nodo (predeterminado `30000`).
- `--needs-screen-recording`: requiere permiso de grabación de pantalla.
- `--raw <command>`: ejecutar una cadena de shell (`/bin/sh -lc` o `cmd.exe /c`).
- `--agent <id>`: aprobaciones/listas de permitidos con ámbito de agente (predeterminado al agente configurado).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: sobrescrituras.
