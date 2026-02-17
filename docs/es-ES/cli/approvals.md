---
summary: "Referencia CLI para `openclaw approvals` (aprobaciones de ejecución para gateway o hosts de nodo)"
read_when:
  - Quieres editar aprobaciones de ejecución desde el CLI
  - Necesitas gestionar listas de permitidos en gateway o hosts de nodo
title: "approvals"
---

# `openclaw approvals`

Gestionar aprobaciones de ejecución para el **host local**, **host del gateway**, o un **host de nodo**.
Por defecto, los comandos apuntan al archivo de aprobaciones local en disco. Usa `--gateway` para apuntar al gateway, o `--node` para apuntar a un nodo específico.

Relacionado:

- Aprobaciones de ejecución: [Aprobaciones de ejecución](/es-ES/tools/exec-approvals)
- Nodos: [Nodos](/es-ES/nodes)

## Comandos comunes

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Reemplazar aprobaciones desde un archivo

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Ayudantes de lista de permitidos

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notas

- `--node` usa el mismo resolvedor que `openclaw nodes` (id, nombre, ip, o prefijo de id).
- `--agent` por defecto es `"*"`, que aplica a todos los agentes.
- El host de nodo debe anunciar `system.execApprovals.get/set` (app de macOS o host de nodo sin interfaz).
- Los archivos de aprobaciones se almacenan por host en `~/.openclaw/exec-approvals.json`.
