# Agent Interaction Flows - Navigation Guide

_Guia rápido para navegação nos diagramas e documentação_

---

## 📚 Documentos Disponíveis

### 1. **AGENT_INTERACTION_FLOWS.md** (Texto)

- Descrições detalhadas de cada tipo de interação
- Exemplos de código TypeScript
- Tabelas comparativas
- Patterns comuns
- Boas práticas

### 2. **AGENT_INTERACTION_DIAGRAMS.md** (Visual)

- 🎯 **Este é o documento visual completo**
- Sequence diagrams (Mermaid)
- State diagrams (Mermaid)
- Flowcharts (Mermaid)
- Architecture overview
- Decision trees

---

## 🗺️ Mapa de Navegação

```
AGENT_INTERACTION_FLOWS.md          AGENT_INTERACTION_DIAGRAMS.md
(Texto + Código)                     (Diagramas Visuais)
        │                                    │
        ├─ sessions_spawn              ──►   ├─ Sequence diagram
        │                                    ├─ State diagram
        │                                    │
        ├─ sessions_send               ──►   ├─ Sequence diagram
        │                                    ├─ State diagram
        │                                    │
        ├─ collaboration               ──►   ├─ Sequence diagram
        │                                    ├─ State diagram
        │                                    ├─ Flowchart (lifecycle)
        │                                    │
        ├─ delegation                  ──►   ├─ Sequence (downward)
        │                                    ├─ Sequence (upward)
        │                                    ├─ State diagram
        │                                    │
        ├─ team_workspace              ──►   ├─ Flowchart (artifacts)
        │                                    ├─ Sequence (multi-agent)
        │                                    │
        ├─ sessions_inbox              ──►   ├─ Sequence diagram
        │                                    ├─ State diagram
        │                                    │
        ├─ sessions_spawn_batch        ──►   ├─ Sequence (waitMode all)
        │                                    ├─ Flowchart (wait modes)
        │                                    ├─ State diagram
        │                                    │
        └─ Comparison + Decision Tree  ──►   ├─ Decision tree flowchart
                                             ├─ Comparison matrix
                                             └─ Architecture overview
```

---

## 🎯 Acesso Rápido por Caso de Uso

### "Preciso delegar trabalho pesado"

→ **sessions_spawn**

- Texto: `AGENT_INTERACTION_FLOWS.md` #1
- Visual: `AGENT_INTERACTION_DIAGRAMS.md` #1

### "Preciso fazer pergunta rápida"

→ **sessions_send**

- Texto: `AGENT_INTERACTION_FLOWS.md` #2
- Visual: `AGENT_INTERACTION_DIAGRAMS.md` #2

### "Preciso tomar decisão com múltiplos agentes"

→ **collaboration**

- Texto: `AGENT_INTERACTION_FLOWS.md` #3
- Visual: `AGENT_INTERACTION_DIAGRAMS.md` #3

### "Preciso delegar com tracking formal"

→ **delegation**

- Texto: `AGENT_INTERACTION_FLOWS.md` #4
- Visual: `AGENT_INTERACTION_DIAGRAMS.md` #4

### "Preciso compartilhar contexto"

→ **team_workspace**

- Texto: `AGENT_INTERACTION_FLOWS.md` #5
- Visual: `AGENT_INTERACTION_DIAGRAMS.md` #5

### "Preciso verificar mensagens pendentes"

→ **sessions_inbox**

- Texto: `AGENT_INTERACTION_FLOWS.md` #6
- Visual: `AGENT_INTERACTION_DIAGRAMS.md` #6

### "Preciso executar N tasks em paralelo"

→ **sessions_spawn_batch**

- Texto: `AGENT_INTERACTION_FLOWS.md` #7
- Visual: `AGENT_INTERACTION_DIAGRAMS.md` #7

### "Não sei qual usar"

→ **Decision Tree**

- Texto: `AGENT_INTERACTION_FLOWS.md` (seção "Decision Tree")
- Visual: `AGENT_INTERACTION_DIAGRAMS.md` (seção "Decision Tree Completo")

---

## 📊 Como Visualizar os Diagramas

### Opção 1: GitHub/GitLab (Recomendado)

Abra `AGENT_INTERACTION_DIAGRAMS.md` diretamente no GitHub ou GitLab.
Os diagramas Mermaid renderizam automaticamente.

### Opção 2: Mermaid Live Editor

1. Acesse: https://mermaid.live
2. Cole o código Mermaid do diagrama
3. Visualize em tempo real
4. Export PNG/SVG se necessário

### Opção 3: VS Code Extension

1. Instale: "Markdown Preview Mermaid Support"
2. Abra `AGENT_INTERACTION_DIAGRAMS.md`
3. `Cmd+Shift+V` (preview)

### Opção 4: CLI (mmdc)

```bash
npm install -g @mermaid-js/mermaid-cli
mmdc -i diagram.mmd -o diagram.png
```

---

## 🔍 Índice de Diagramas

### AGENT_INTERACTION_DIAGRAMS.md contém:

**sessions_spawn:**

- Sequence diagram (Main → Subagent → Announce)
- State diagram (Lifecycle completo)

**sessions_send:**

- Sequence diagram (A ↔ B com ping-pong)
- State diagram (Blocking vs fire-and-forget)

**collaboration:**

- Sequence diagram (Debate rounds)
- State diagram (Lifecycle com escalação)
- Flowchart (Debate lifecycle detalhado)

**delegation:**

- Sequence diagram (Downward: Lead → Engineer)
- Sequence diagram (Upward: Junior → Lead)
- State diagram (Full lifecycle)

**team_workspace:**

- Flowchart (Artifact lifecycle)
- Sequence diagram (Multi-agent context sharing)

**sessions_inbox:**

- Sequence diagram (Fire-and-forget + poll)
- State diagram (FIFO queue)

**sessions_spawn_batch:**

- Sequence diagram (waitMode: all)
- Flowchart (Wait mode decision)
- State diagram (Batch lifecycle)

**Global:**

- Decision tree completo (Qual tool usar?)
- Comparison matrix (Visual)
- Architecture overview (Todos os componentes)

---

## 📖 Como Ler os Diagramas

### Sequence Diagrams

```
Agent A  ─┐     ┌─ Agent B
          │     │
          │ msg │
          ├────►│
          │     │
          │◄────┤
          │ res │
```

- Setas horizontais: mensagens
- Ordem: top → bottom (timeline)
- Boxes: estados/processos

### State Diagrams

```
[Start] → State1 → State2 → [End]
            │         │
            └────►────┘
           (loop)
```

- Círculos: estados
- Setas: transições
- Losangos: decisões (choice)

### Flowcharts

```
┌─────────┐
│ Decisão │
└────┬────┘
     │
  ┌──┴──┐
 Sim   Não
  │      │
```

- Retângulos: ações
- Losangos: decisões
- Setas: fluxo

---

## 🎨 Cores nos Diagramas

| Cor                   | Significado                   |
| --------------------- | ----------------------------- |
| 🟢 Verde (#90EE90)    | Sucesso, completado, go-ahead |
| 🔴 Vermelho (#FFB6C1) | Bloqueio, crítico, binding    |
| 🟡 Amarelo (#FFFFE0)  | Warning, atenção, condicional |
| 🔵 Azul (#87CEEB)     | Info, storage, neutral        |
| 🟣 Roxo (#DDA0DD)     | Collaboration, multi-party    |
| ⚪ Cinza (#D3D3D3)    | Inativo, opcional             |

---

## 🚀 Próximos Passos

Se você quer:

1. **Entender um fluxo específico** → Vá direto para a seção correspondente
2. **Ver código de exemplo** → Use `AGENT_INTERACTION_FLOWS.md`
3. **Visualizar graficamente** → Use `AGENT_INTERACTION_DIAGRAMS.md`
4. **Decidir qual tool usar** → Veja "Decision Tree" em ambos os docs

---

## 📝 Convenções

### Nomenclatura nos Diagramas

- `Agent A`, `Agent B` → Agentes genéricos
- `Orchestrator` → Agente principal (main)
- `Subagent` → Sessão spawned
- `Tech Lead`, `Backend Engineer` → Roles específicos
- `WS` → team_workspace
- `Inbox` → sessions_inbox
- `Chat` → Main chat (session principal)

### Formato de Mensagens

```typescript
// Sempre mostrado assim nos diagramas:
tool_name({
  param1: "value",
  param2: 123,
});
```

---

## ⚡ Quick Reference

| Preciso...              | Use                  | Ver Diagrama   |
| ----------------------- | -------------------- | -------------- |
| Delegar trabalho pesado | sessions_spawn       | DIAGRAMS.md #1 |
| Pergunta rápida         | sessions_send        | DIAGRAMS.md #2 |
| Decisão cross-domain    | collaboration        | DIAGRAMS.md #3 |
| Tracking formal         | delegation           | DIAGRAMS.md #4 |
| Compartilhar contexto   | team_workspace       | DIAGRAMS.md #5 |
| Verificar mensagens     | sessions_inbox       | DIAGRAMS.md #6 |
| Paralelo massivo        | sessions_spawn_batch | DIAGRAMS.md #7 |

---

_Criado: 2026-02-13_  
_Última atualização: 2026-02-13_
