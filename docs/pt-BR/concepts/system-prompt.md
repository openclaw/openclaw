---
summary: "O que o system prompt OpenClaw contém e como é montado"
read_when:
  - Editando texto de system prompt, lista de ferramentas ou seções de tempo/heartbeat
  - Mudando comportamento de injeção de bootstrap workspace ou skills
title: "System Prompt"
---

# System Prompt

OpenClaw constrói um system prompt customizado para cada execução de agente. O prompt é **propriedade do OpenClaw** e não usa o prompt padrão do pi-coding-agent.

O prompt é montado pelo OpenClaw e injetado em cada execução de agente.

## Estrutura

O prompt é intencionalmente compacto e usa seções fixas:

- **Tooling**: lista de ferramentas atual + descrições curtas.
- **Safety**: lembrança de guardrail curta para evitar comportamento de power-seeking ou bypass de oversight.
- **Skills** (quando disponível): diz ao modelo como carregar instruções de skill sob demanda.
- **OpenClaw Self-Update**: como executar `config.apply` e `update.run`.
- **Workspace**: diretório de trabalho (`agents.defaults.workspace`).
- **Documentation**: caminho local para docs do OpenClaw (repo ou pacote npm) e quando lê-los.
- **Workspace Files (injetados)**: indica arquivos de bootstrap estão incluídos abaixo.
- **Sandbox** (quando habilitado): indica runtime sandboxado, caminhos sandbox e se elevated exec está disponível.
- **Current Date & Time**: hora local do usuário, timezone e formato de hora.
- **Reply Tags**: sintaxe opcional de reply tag para provedores suportados.
- **Heartbeats**: prompt de heartbeat e comportamento de ack.
- **Runtime**: host, OS, node, model, repo root (quando detectado), thinking level (uma linha).
- **Reasoning**: nível de visibilidade atual + dica toggle /reasoning.

Guardrails de segurança no system prompt são avisivos. Eles guiam comportamento do modelo mas não aplicam política. Use política de ferramentas, aprovações de exec, sandboxing e allowlists de canal para aplicação rígida; operadores podem desabilitar estes por design.

## Modos de prompt

OpenClaw pode renderizar system prompts menores para sub-agentes. O runtime define um `promptMode` para cada execução (não uma config de um usuário):

- `full` (padrão): inclui todas as seções acima.
- `minimal`: usado para sub-agentes; omite **Skills**, **Memory Recall**, **OpenClaw Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**, **Messaging**, **Silent Replies** e **Heartbeats**. Tooling, **Safety**, Workspace, Sandbox, Current Date & Time (quando conhecido), Runtime e contexto injetado permanecem disponíveis.
- `none`: retorna apenas a linha de identidade base.

Quando `promptMode=minimal`, prompts injetados extras são rotulados **Subagent Context** em vez de **Group Chat Context**.

## Injeção de bootstrap de workspace

Arquivos de bootstrap são cortados e anexados sob **Project Context** para que o modelo veja contexto de identidade e perfil sem precisar de leituras explícitas:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (apenas em workspaces novíssimos)
- `MEMORY.md` e/ou `memory.md` (quando presentes no workspace; um ou ambos podem ser injetados)

Todos esses arquivos estão **injetados na janela de contexto** a cada volta, o que significa que consomem tokens. Mantenha-os concisos — especialmente `MEMORY.md`, que pode crescer ao longo do tempo e levar a uso de contexto inesperadamente alto e compactação mais frequente.

> **Nota:** arquivos diários `memory/*.md` são **não** injetados automaticamente. Eles são acessados sob demanda via ferramentas `memory_search` e `memory_get`, então não contam contra a janela de contexto a menos que o modelo os leia explicitamente.

Arquivos grandes são truncados com um marcador. O tamanho máximo por arquivo é controlado por `agents.defaults.bootstrapMaxChars` (padrão: 20000). Conteúdo de bootstrap injetado total entre arquivos é capped por `agents.defaults.bootstrapTotalMaxChars` (padrão: 150000). Arquivos faltando injetam um marcador curto de arquivo faltando.

Sessões de sub-agent apenas injetam `AGENTS.md` e `TOOLS.md` (outros arquivos de bootstrap são filtrados para manter o contexto de sub-agent pequeno).
