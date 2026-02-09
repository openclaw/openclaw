---
summary: "Notas de pesquisa: sistema de memória offline para workspaces do Clawd (Markdown como fonte de verdade + índice derivado)"
read_when:
  - Projetando a memória do workspace (~/.openclaw/workspace) além de logs diários em Markdown
  - Deciding: "Decidindo: CLI independente vs integração profunda com o OpenClaw"
  - Adicionando recordação e reflexão offline (retain/recall/reflect)
title: "Pesquisa sobre Memória de Workspace"
---

# Memória de Workspace v2 (offline): notas de pesquisa

Alvo: workspace no estilo Clawd (`agents.defaults.workspace`, padrão `~/.openclaw/workspace`) onde a “memória” é armazenada como um arquivo Markdown por dia (`memory/YYYY-MM-DD.md`) mais um pequeno conjunto de arquivos estáveis (ex.: `memory.md`, `SOUL.md`).

Este documento propõe uma arquitetura de memória **offline-first** que mantém o Markdown como a fonte de verdade canônica e revisável, mas adiciona **recordação estruturada** (busca, resumos de entidades, atualizações de confiança) por meio de um índice derivado.

## Por que mudar?

A configuração atual (um arquivo por dia) é excelente para:

- journaling “append-only”
- edição humana
- durabilidade + auditabilidade com git
- captura de baixo atrito (“é só escrever”)

Ela é fraca para:

- recuperação com alto recall (“o que decidimos sobre X?”, “da última vez que tentamos Y?”)
- respostas centradas em entidades (“me fale sobre Alice / The Castle / warelay”) sem reler muitos arquivos
- estabilidade de opiniões/preferências (e evidências quando mudam)
- restrições temporais (“o que era verdade em nov de 2025?”) e resolução de conflitos

## Objetivos de design

- **Offline**: funciona sem rede; pode rodar no laptop/Castle; sem dependência de nuvem.
- **Explicável**: itens recuperados devem ser atribuíveis (arquivo + local) e separáveis da inferência.
- **Baixa cerimônia**: o log diário continua sendo Markdown, sem trabalho pesado de esquema.
- **Incremental**: v1 é útil apenas com FTS; semântico/vetorial e grafos são upgrades opcionais.
- **Amigável para agentes**: facilita “recordar dentro de orçamentos de tokens” (retornar pequenos conjuntos de fatos).

## Modelo norteador (Hindsight × Letta)

Duas peças para combinar:

1. **Loop de controle no estilo Letta/MemGPT**

- manter um pequeno “core” sempre em contexto (persona + fatos-chave do usuário)
- todo o resto fica fora de contexto e é recuperado via ferramentas
- escritas de memória são chamadas explícitas de ferramentas (append/replace/insert), persistidas e então reinjetadas no próximo turno

2. **Substrato de memória no estilo Hindsight**

- separar o que é observado vs o que é acreditado vs o que é resumido
- suportar retain/recall/reflect
- opiniões com confiança que podem evoluir com evidência
- recuperação consciente de entidades + consultas temporais (mesmo sem grafos de conhecimento completos)

## Arquitetura proposta (Markdown como fonte de verdade + índice derivado)

### Loja canônica (git-friendly)

Manter `~/.openclaw/workspace` como memória canônica legível por humanos.

Layout sugerido do workspace:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

Notas:

- **O log diário continua sendo log diário**. Não há necessidade de transformá-lo em JSON.
- Os arquivos `bank/` são **curados**, produzidos por jobs de reflexão, e ainda podem ser editados à mão.
- `memory.md` permanece “pequeno + core-ish”: as coisas que você quer que o Clawd veja em toda sessão.

### Armazenamento derivado (recordação por máquina)

Adicionar um índice derivado sob o workspace (não necessariamente versionado no git):

```
~/.openclaw/workspace/.memory/index.sqlite
```

Voltar com:

- esquema SQLite para fatos + links de entidades + metadados de opinião
- SQLite **FTS5** para recordação lexical (rápido, pequeno, offline)
- tabela opcional de embeddings para recordação semântica (ainda offline)

O índice é sempre **reconstruível a partir do Markdown**.

## Retain / Recall / Reflect (loop operacional)

### Retain: normalizar logs diários em “fatos”

O insight-chave do Hindsight que importa aqui: armazenar **fatos narrativos e autocontidos**, não trechos minúsculos.

Regra prática para `memory/YYYY-MM-DD.md`:

- ao final do dia (ou durante), adicionar uma seção `## Retain` com 2–5 bullets que sejam:
  - narrativos (contexto entre turnos preservado)
  - autocontidos (fazem sentido sozinhos no futuro)
  - marcados com tipo + menções de entidades

Exemplo:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Parsing mínimo:

- Prefixo de tipo: `W` (mundo), `B` (experiência/biográfico), `O` (opinião), `S` (observação/resumo; geralmente gerado)
- Entidades: `@Peter`, `@warelay`, etc. (slugs mapeiam para `bank/entities/*.md`)
- Confiança da opinião: `O(c=0.0..1.0)` opcional

Se você não quiser que autores pensem nisso: o job de reflexão pode inferir esses bullets a partir do resto do log, mas ter uma seção explícita `## Retain` é a alavanca de qualidade mais fácil.

### Recall: consultas sobre o índice derivado

A recordação deve suportar:

- **lexical**: “encontrar termos / nomes / comandos exatos” (FTS5)
- **entidade**: “me fale sobre X” (páginas de entidades + fatos vinculados a entidades)
- **temporal**: “o que aconteceu por volta de 27 de nov” / “desde a semana passada”
- **opinião**: “o que Peter prefere?” (com confiança + evidência)

O formato de retorno deve ser amigável para agentes e citar fontes:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (dia de origem, ou intervalo de tempo extraído se presente)
- `entities` (`["Peter","warelay"]`)
- `content` (o fato narrativo)
- `source` (`memory/2025-11-27.md#L12` etc.)

### Reflect: produzir páginas estáveis + atualizar crenças

A reflexão é um job agendado (diário ou heartbeat `ultrathink`) que:

- atualiza `bank/entities/*.md` a partir de fatos recentes (resumos de entidades)
- atualiza a confiança de `bank/opinions.md` com base em reforço/contradição
- opcionalmente propõe edições em `memory.md` (fatos duráveis “core-ish”)

Evolução de opinião (simples, explicável):

- cada opinião tem:
  - enunciado
  - confiança `c ∈ [0,1]`
  - last_updated
  - links de evidência (IDs de fatos de suporte + contraditórios)
- quando novos fatos chegam:
  - encontrar opiniões candidatas por sobreposição de entidades + similaridade (FTS primeiro, embeddings depois)
  - atualizar a confiança por pequenos deltas; grandes saltos exigem contradição forte + evidência repetida

## Integração com CLI: independente vs integração profunda

Recomendação: **integração profunda no OpenClaw**, mas mantendo uma biblioteca central separável.

### Por que integrar ao OpenClaw?

- O OpenClaw já conhece:
  - o caminho do workspace (`agents.defaults.workspace`)
  - o modelo de sessão + heartbeats
  - padrões de logging + solução de problemas
- Você quer que o próprio agente chame as ferramentas:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Por que ainda separar uma biblioteca?

- manter a lógica de memória testável sem gateway/runtime
- reutilizar em outros contextos (scripts locais, futuro app desktop, etc.)

Forma:
O tooling de memória é pensado como uma pequena camada de CLI + biblioteca, mas isso é apenas exploratório.

## “S-Collide” / SuCo: quando usar (pesquisa)

Se “S-Collide” se refere a **SuCo (Subspace Collision)**: é uma abordagem de recuperação ANN que busca bons trade-offs de recall/latência usando colisões aprendidas/estruturadas em subespaços (paper: arXiv 2411.14754, 2024).

Visão pragmática para `~/.openclaw/workspace`:

- **não comece** com SuCo.
- comece com SQLite FTS + (opcional) embeddings simples; você obterá a maioria dos ganhos de UX imediatamente.
- considere soluções da classe SuCo/HNSW/ScaNN apenas quando:
  - o corpus for grande (dezenas/centenas de milhares de chunks)
  - a busca por embeddings em força bruta ficar lenta demais
  - a qualidade de recall estiver significativamente limitada pela busca lexical

Alternativas offline-friendly (em complexidade crescente):

- SQLite FTS5 + filtros de metadados (zero ML)
- Embeddings + força bruta (funciona surpreendentemente bem enquanto o número de chunks é baixo)
- Índice HNSW (comum, robusto; precisa de um binding de biblioteca)
- SuCo (nível de pesquisa; atraente se houver uma implementação sólida que você possa embutir)

Pergunta em aberto:

- qual é o **melhor** modelo de embedding offline para “memória de assistente pessoal” nas suas máquinas (laptop + desktop)?
  - se você já tem Ollama: gere embeddings com um modelo local; caso contrário, inclua um pequeno modelo de embedding no toolchain.

## Menor piloto útil

Se você quiser uma versão mínima, ainda útil:

- Adicione páginas de entidades `bank/` e uma seção `## Retain` nos logs diários.
- Use SQLite FTS para recordação com citações (caminho + números de linha).
- Adicione embeddings apenas se a qualidade de recall ou a escala exigirem.

## Referências

- Conceitos Letta / MemGPT: “core memory blocks” + “archival memory” + memória autoeditável orientada por ferramentas.
- Relatório Técnico do Hindsight: “retain / recall / reflect”, memória de quatro redes, extração de fatos narrativos, evolução de confiança de opiniões.
- SuCo: arXiv 2411.14754 (2024): “Subspace Collision” para recuperação aproximada de vizinhos mais próximos.
