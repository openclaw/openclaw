---
summary: "Referência da CLI para `openclaw agents` (listar/adicionar/excluir/definir identidade)"
read_when:
  - Você quer vários agentes isolados (workspaces + roteamento + autenticação)
title: "agentes"
---

# `openclaw agents`

Gerencie agentes isolados (workspaces + autenticação + roteamento).

Relacionado:

- Roteamento multiagente: [Multi-Agent Routing](/concepts/multi-agent)
- Workspace do agente: [Agent workspace](/concepts/agent-workspace)

## Exemplos

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## Arquivos de identidade

Cada workspace de agente pode incluir um `IDENTITY.md` na raiz do workspace:

- Caminho de exemplo: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` lê a partir da raiz do workspace (ou de um `--identity-file` explícito)

Caminhos de avatar são resolvidos em relação à raiz do workspace.

## Definir identidade

`set-identity` grava campos em `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (caminho relativo ao workspace, URL http(s) ou URI de dados)

Carregar de `IDENTITY.md`:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

Sobrescrever campos explicitamente:

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

Exemplo de configuração:

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
