---
summary: "Referência da CLI para `openclaw memory` (status/index/search)"
read_when:
  - Você quer indexar ou pesquisar memória semântica
  - Você está depurando a disponibilidade de memória ou a indexação
title: "memory"
---

# `openclaw memory`

Gerencie a indexação e a pesquisa de memória semântica.
Fornecido pelo plugin de memória ativo (padrão: `memory-core`; defina `plugins.slots.memory = "none"` para desativar).

Relacionados:

- Conceito de memória: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Exemplos

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Opções

Comuns:

- `--agent <id>`: limita a um único agente (padrão: todos os agentes configurados).
- `--verbose`: emite logs detalhados durante as sondagens e a indexação.

Notas:

- `memory status --deep` verifica a disponibilidade de vetores + embeddings.
- `memory status --deep --index` executa uma reindexação se o armazenamento estiver sujo.
- `memory index --verbose` imprime detalhes por fase (provedor, modelo, fontes, atividade em lote).
- `memory status` inclui quaisquer caminhos extras configurados via `memorySearch.extraPaths`.
