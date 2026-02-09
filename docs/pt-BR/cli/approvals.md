---
summary: "Referência da CLI para `openclaw approvals` (aprovações de execução para hosts do gateway ou de nó)"
read_when:
  - Você quer editar aprovações de execução pela CLI
  - Você precisa gerenciar listas de permissões em hosts do gateway ou de nó
title: "aprovações"
---

# `openclaw approvals`

Gerencie aprovações de execução para o **host local**, **host do gateway** ou um **host de nó**.
Por padrão, os comandos direcionam o arquivo de aprovações local no disco. Use `--gateway` para direcionar o gateway ou `--node` para direcionar um nó específico.

Relacionado:

- Aprovações de execução: [Exec approvals](/tools/exec-approvals)
- Nós: [Nodes](/nodes)

## Comandos comuns

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
```

## Substituir aprovações a partir de um arquivo

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

## Auxiliares de lista de permissões

```bash
openclaw approvals allowlist add "~/Projects/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notas

- `--node` usa o mesmo resolvedor que `openclaw nodes` (id, nome, ip ou prefixo de id).
- `--agent` tem como padrão `"*"`, que se aplica a todos os agentes.
- O host de nó deve anunciar `system.execApprovals.get/set` (aplicativo macOS ou host de nó headless).
- Os arquivos de aprovações são armazenados por host em `~/.openclaw/exec-approvals.json`.
