---
summary: "Referencia de la CLI para `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Usted está gestionando nodos emparejados (cámaras, pantalla, lienzo)
  - Necesita aprobar solicitudes o invocar comandos de nodos
title: "nodes"
---

# `openclaw nodes`

Gestione nodos emparejados (dispositivos) e invoque capacidades de nodos.

Relacionado:

- Descripción general de nodos: [Nodes](/nodes)
- Cámara: [Camera nodes](/nodes/camera)
- Imágenes: [Image nodes](/nodes/images)

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

`nodes list` imprime tablas de pendientes/emparejados. Las filas emparejadas incluyen la antigüedad de la conexión más reciente (Last Connect).
Use `--connected` para mostrar solo los nodos conectados actualmente. Use `--last-connected <duration>` para
filtrar a nodos que se conectaron dentro de una duración (p. ej., `24h`, `7d`).

## Invocar / ejecutar

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Indicadores de invocación:

- `--params <json>`: cadena de objeto JSON (valor predeterminado `{}`).
- `--invoke-timeout <ms>`: tiempo de espera de invocación del nodo (valor predeterminado `15000`).
- `--idempotency-key <key>`: clave de idempotencia opcional.

### Ejec-estilo por defecto

`nodes run` refleja el comportamiento exec del modelo (valores predeterminados + aprobaciones):

- Lee `tools.exec.*` (más las anulaciones de `agents.list[].tools.exec.*`).
- Usa aprobaciones de exec (`exec.approval.request`) antes de invocar `system.run`.
- `--node` puede omitirse cuando se establece `tools.exec.node`.
- Requiere un nodo que anuncie `system.run` (aplicación complementaria de macOS o host de nodo sin interfaz).

Indicadores:

- `--cwd <path>`: directorio de trabajo.
- `--env <key=val>`: anulación de variables de entorno (repetible).
- `--command-timeout <ms>`: tiempo de espera del comando.
- `--invoke-timeout <ms>`: tiempo de espera de invocación del nodo (valor predeterminado `30000`).
- `--needs-screen-recording`: requiere permiso de grabación de pantalla.
- `--raw <command>`: ejecutar una cadena de shell (`/bin/sh -lc` o `cmd.exe /c`).
- `--agent <id>`: aprobaciones/listas de permitidos con alcance de agente (predetermina al agente configurado).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: anulaciones.
