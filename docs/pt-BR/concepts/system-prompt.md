---
summary: "O que o system prompt do OpenClaw contém e como ele é montado"
read_when:
  - Ao editar o texto do system prompt, a lista de ferramentas ou as seções de tempo/heartbeat
  - Ao alterar o bootstrap do workspace ou o comportamento de injeção de skills
title: "System Prompt"
---

# System Prompt

O OpenClaw cria um system prompt personalizado para cada execução de agente. O prompt é **de propriedade do OpenClaw** e não usa o prompt padrão do p-coding-agent.

O prompt é montado pelo OpenClaw e injetado em cada execução do agente.

## Estrutura

O prompt é intencionalmente compacto e usa seções fixas:

- **Tooling**: lista atual de ferramentas + descrições curtas.
- **Safety**: lembrete curto de guardrails para evitar comportamento de busca por poder ou burlar supervisão.
- **Skills** (quando disponíveis): informa ao modelo como carregar instruções de skills sob demanda.
- **OpenClaw Self-Update**: como executar `config.apply` e `update.run`.
- **Workspace**: diretório de trabalho (`agents.defaults.workspace`).
- **Documentation**: caminho local para a documentação do OpenClaw (repo ou pacote npm) e quando lê-la.
- **Workspace Files (injected)**: indica que arquivos de bootstrap estão incluídos abaixo.
- **Sandbox** (quando habilitado): indica runtime em sandbox, caminhos de sandbox e se execução elevada está disponível.
- **Current Date & Time**: hora local do usuário, fuso horário e formato de hora.
- **Reply Tags**: sintaxe opcional de tags de resposta para provedores compatíveis.
- **Heartbeats**: prompt de heartbeat e comportamento de ack.
- **Runtime**: host, SO, node, modelo, raiz do repo (quando detectada), nível de raciocínio (uma linha).
- **Reasoning**: nível atual de visibilidade + dica de alternância /reasoning.

Os guardrails de segurança no system prompt são consultivos. Eles orientam o comportamento do modelo, mas não aplicam política. Use política de ferramentas, aprovações de exec, sandboxing e listas de permissões de canais para aplicação rígida; operadores podem desabilitar isso por design.

## Modos do prompt

O OpenClaw pode renderizar system prompts menores para subagentes. O runtime define um
`promptMode` para cada execução (não é uma configuração voltada ao usuário):

- `full` (padrão): inclui todas as seções acima.
- `minimal`: usado para subagentes; omite **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** e **Heartbeats**. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (quando conhecido), Runtime e o contexto
  injetado permanecem disponíveis.
- `none`: retorna apenas a linha de identidade base.

Quando `promptMode=minimal`, prompts extras injetados são rotulados como **Subagent
Context** em vez de **Group Chat Context**.

## Injeção de bootstrap do workspace

Arquivos de bootstrap são aparados e anexados em **Project Context** para que o modelo veja o contexto de identidade e perfil sem precisar de leituras explícitas:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (apenas em workspaces totalmente novos)

Arquivos grandes são truncados com um marcador. O tamanho máximo por arquivo é controlado por
`agents.defaults.bootstrapMaxChars` (padrão: 20000). Arquivos ausentes injetam um
marcador curto de arquivo ausente.

Hooks internos podem interceptar esta etapa via `agent:bootstrap` para mutar ou substituir
os arquivos de bootstrap injetados (por exemplo, trocando `SOUL.md` por uma persona alternativa).

Para inspecionar quanto cada arquivo injetado contribui (bruto vs. injetado, truncamento, além da sobrecarga do schema de ferramentas), use `/context list` ou `/context detail`. Veja [Context](/concepts/context).

## Tratamento de tempo

O system prompt inclui uma seção dedicada **Current Date & Time** quando o
fuso horário do usuário é conhecido. Para manter o cache do prompt estável, agora ele inclui apenas
o **fuso horário** (sem relógio dinâmico ou formato de hora).

Use `session_status` quando o agente precisar do horário atual; o cartão de status
inclui uma linha de timestamp.

Configure com:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Veja [Date & Time](/date-time) para detalhes completos do comportamento.

## Skills

Quando existem skills elegíveis, o OpenClaw injeta uma **lista compacta de skills disponíveis**
(`formatSkillsForPrompt`) que inclui o **caminho do arquivo** para cada skill. O
prompt instrui o modelo a usar `read` para carregar o SKILL.md no local listado
(workspace, gerenciado ou empacotado). Se nenhuma skill for elegível, a seção
Skills é omitida.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Isso mantém o prompt base pequeno, ao mesmo tempo em que habilita o uso direcionado de skills.

## Documentação

Quando disponível, o system prompt inclui uma seção **Documentation** que aponta para o
diretório local de documentação do OpenClaw (seja `docs/` no workspace do repo ou a documentação
empacotada do npm) e também observa o espelho público, o repo de origem, o Discord da comunidade e o
ClawHub ([https://clawhub.com](https://clawhub.com)) para descoberta de skills. O prompt instrui o modelo a consultar primeiro a documentação local
para comportamento, comandos, configuração ou arquitetura do OpenClaw, e a executar
`openclaw status` por conta própria quando possível (pedindo ao usuário apenas quando não tiver acesso).
