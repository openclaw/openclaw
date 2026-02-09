---
summary: "Referencia de la CLI para `openclaw approvals` (aprobaciones de ejecución para hosts del Gateway o de nodo)"
read_when:
  - Quiere editar aprobaciones de ejecución desde la CLI
  - Necesita administrar listas de permitidos en hosts del Gateway o de nodo
title: "aprobaciones"
---

# `openclaw approvals`

Administre aprobaciones de ejecución para el **host local**, el **host del Gateway** o un **host de nodo**.
De forma predeterminada, los comandos apuntan al archivo de aprobaciones local en disco. Use `--gateway` para apuntar al Gateway, o `--node` para apuntar a un nodo específico.

Relacionado:

- Aprobaciones de ejecución: [Exec approvals](/tools/exec-approvals)
- Nodos: [Nodes](/nodes)

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

- `--node` usa el mismo resolvedor que `openclaw nodes` (id, nombre, ip o prefijo de id).
- `--agent` se establece de forma predeterminada en `"*"`, lo que se aplica a todos los agentes.
- El host de nodo debe anunciar `system.execApprovals.get/set` (aplicación de macOS o host de nodo sin interfaz).
- Los archivos de aprobaciones se almacenan por host en `~/.openclaw/exec-approvals.json`.
