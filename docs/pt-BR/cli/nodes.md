---
summary: "Referência da CLI para `openclaw nodes` (listar/status/aprovar/invocar, câmera/canvas/tela)"
read_when:
  - Você está gerenciando nodes pareados (câmeras, tela, canvas)
  - Você precisa aprovar solicitações ou invocar comandos de nodes
title: "nodes"
---

# `openclaw nodes`

Gerencie nodes (dispositivos) pareados e invoque capacidades de nodes.

Relacionados:

- Visão geral de Nodes: [Nodes](/nodes)
- Câmera: [Camera nodes](/nodes/camera)
- Imagens: [Image nodes](/nodes/images)

Opções comuns:

- `--url`, `--token`, `--timeout`, `--json`

## Comandos comuns

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

`nodes list` imprime tabelas de pendentes/pareados. As linhas pareadas incluem a idade da conexão mais recente (Last Connect).
Use `--connected` para mostrar apenas nodes atualmente conectados. Use `--last-connected <duration>` para
filtrar para nodes que se conectaram dentro de uma duração (por exemplo, `24h`, `7d`).

## Invocar / executar

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Flags de invocação:

- `--params <json>`: string de objeto JSON (padrão `{}`).
- `--invoke-timeout <ms>`: tempo limite de invocação do node (padrão `15000`).
- `--idempotency-key <key>`: chave de idempotência opcional.

### Padrões no estilo exec

`nodes run` espelha o comportamento exec do modelo (padrões + aprovações):

- Lê `tools.exec.*` (mais substituições de `agents.list[].tools.exec.*`).
- Usa aprovações de exec (`exec.approval.request`) antes de invocar `system.run`.
- `--node` pode ser omitido quando `tools.exec.node` está definido.
- Requer um node que anuncie `system.run` (aplicativo complementar macOS ou host de node headless).

Flags:

- `--cwd <path>`: diretório de trabalho.
- `--env <key=val>`: substituição de env (repetível).
- `--command-timeout <ms>`: tempo limite do comando.
- `--invoke-timeout <ms>`: tempo limite de invocação do node (padrão `30000`).
- `--needs-screen-recording`: exigir permissão de gravação de tela.
- `--raw <command>`: executar uma string de shell (`/bin/sh -lc` ou `cmd.exe /c`).
- `--agent <id>`: aprovações/listas de permissões com escopo de agente (padrão para o agente configurado).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: substituições.
