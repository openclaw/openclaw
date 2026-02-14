# AGENT INTERACTION FLOWS - Fluxograma Completo

_Todos os tipos de interação entre agentes no OpenClaw_

---

## 📋 ÍNDICE

1. [sessions_spawn](#1-sessions_spawn---delegação-paralela)
2. [sessions_send](#2-sessions_send---mensagem-direta)
3. [collaboration](#3-collaboration---debates-estruturados)
4. [delegation](#4-delegation---hierarquia-formal)
5. [team_workspace](#5-team_workspace---memória-compartilhada)
6. [sessions_inbox](#6-sessions_inbox---inbox-assíncrona)
7. [sessions_spawn_batch](#7-sessions_spawn_batch---paralelo-massivo)
8. [Comparação Rápida](#comparação-rápida)

---

## 1. sessions_spawn - Delegação Paralela

**Quando usar:** Delegar trabalho pesado ou paralelo que deve retornar resultado.

### Fluxo Visual

```
┌──────────────┐
│ Agent Main   │
│ (Orchestrator)
└──────┬───────┘
       │ sessions_spawn({
       │   task: "Research topic X",
       │   agentId: "deep-research",
       │   cleanup: "delete"
       │ })
       │
       ▼
┌──────────────────────────────────┐
│ SubAgent Session Created         │
│ Key: agent:deep-research:subagent:uuid
└──────┬───────────────────────────┘
       │
       │ [Runs in background]
       │ [Isolated session]
       │ [Own context/tokens]
       │
       ▼
┌──────────────────────────────────┐
│ Work Complete                    │
│ - Runs "announce" step           │
│ - Posts result to requester chat │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Announce in Main Chat            │
│ Status: success                  │
│ Result: [summary]                │
│ Runtime: 5m12s                   │
│ Tokens: 10k/2k                   │
│ Cost: $0.15                      │
└──────────────────────────────────┘
```

### Características

| Aspecto          | Comportamento                           |
| ---------------- | --------------------------------------- |
| **Bloqueante?**  | ❌ Não (retorna imediatamente)          |
| **Resposta**     | ✅ Via announce no chat do requisitante |
| **Concorrência** | ✅ Até 8 simultâneos (configurável)     |
| **Contexto**     | 🔒 Isolado (própria sessão)             |
| **Visibilidade** | 📢 Resultado público no chat            |
| **Custo**        | 💰 Tokens próprios                      |
| **Cleanup**      | 🗑️ Auto-archive após 60min              |

### Exemplo de Uso

```typescript
// Pesquisa paralela
sessions_spawn({
  task: "Pesquisar melhores práticas de auth JWT vs session cookies",
  agentId: "deep-research",
  runTimeoutSeconds: 300,
  cleanup: "delete",
});
// → Retorna imediatamente
// → Resultado aparece no chat quando completo
```

---

## 2. sessions_send - Mensagem Direta

**Quando usar:** Comunicação ponto-a-ponto, perguntas rápidas, consultas.

### Fluxo Visual

```
┌──────────────┐
│ Agent A      │
│ (Backend)    │
└──────┬───────┘
       │ sessions_send({
       │   agentId: "database-engineer",
       │   message: "Qual índice usar para query X?",
       │   timeoutSeconds: 60
       │ })
       │
       ▼
┌──────────────────────────────────┐
│ Agent B Inbox                    │
│ - Message queued                 │
│ - Agent B processes next turn    │
└──────┬───────────────────────────┘
       │
       │ [Agent B pensa]
       │ [Agent B responde]
       │
       ▼
┌──────────────────────────────────┐
│ Response                         │
│ "Use composite index (user_id, created_at)
│  porque WHERE + ORDER BY"        │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Agent A Recebe                   │
│ - Via return value               │
│ - Pode continuar trabalho        │
└──────────────────────────────────┘
```

### Características

| Aspecto          | Comportamento                              |
| ---------------- | ------------------------------------------ |
| **Bloqueante?**  | ✅ Sim (espera resposta) ou ❌ (timeout=0) |
| **Resposta**     | ✅ Return value direto                     |
| **Concorrência** | ⚠️ Sincrono (aguarda)                      |
| **Contexto**     | 🔓 Agent B vê a pergunta                   |
| **Visibilidade** | 🔒 Privado (A ↔ B)                         |
| **Custo**        | 💰 Tokens de Agent B                       |
| **Ping-Pong**    | 🔄 Até 5 turnos (configurável)             |

### Exemplo de Uso

```typescript
// Consulta rápida
const response = await sessions_send({
  agentId: "security-engineer",
  message: "Este endpoint precisa auth?",
  timeoutSeconds: 30,
});
// → Bloqueia até resposta
// → Retorna string com a resposta
```

---

## 3. collaboration - Debates Estruturados

**Quando usar:** Decisões cross-domain que precisam de consenso.

### Fluxo Visual

```
┌──────────────┐
│ Moderator    │
│ (Tech Lead)  │
└──────┬───────┘
       │ collaboration({
       │   action: "session.init",
       │   topic: "Escolher DB: Postgres vs MySQL",
       │   agents: ["backend-architect", "database-engineer", "sre"],
       │   moderator: "tech-lead"
       │ })
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Debate Session Created                           │
│ SessionKey: collab:uuid                          │
│ Participants: 3 agents + moderator               │
└──────┬───────────────────────────────────────────┘
       │
       │ ROUND 1 - Proposal
       │
       ▼
┌──────────────────────────────────────────────────┐
│ @backend-architect                               │
│ "Proposta: Postgres porque JSON support nativo" │
└──────┬───────────────────────────────────────────┘
       │
       │ ROUND 2 - Challenge
       │
       ▼
┌──────────────────────────────────────────────────┐
│ @sre                                             │
│ "Desafio: MySQL tem melhor replicação.          │
│  Alternativa: Postgres + Patroni"               │
└──────┬───────────────────────────────────────────┘
       │
       │ ROUND 3 - Agreement
       │
       ▼
┌──────────────────────────────────────────────────┐
│ @database-engineer                               │
│ "Concordo com Postgres + Patroni"               │
└──────┬───────────────────────────────────────────┘
       │
       │ [Min 3 rounds complete]
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Moderator Finalizes                              │
│ decision.finalize({                              │
│   decisionId: "...",                             │
│   finalDecision: "Postgres + Patroni HA setup"  │
│ })                                               │
└──────┬───────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│ Decision Recorded                                │
│ - Saved to team_workspace                        │
│ - Visible to all team                            │
│ - Binding decision                               │
└──────────────────────────────────────────────────┘
```

### Características

| Aspecto            | Comportamento                                    |
| ------------------ | ------------------------------------------------ |
| **Estrutura**      | 🎯 Rounds formais (proposal → challenge → agree) |
| **Moderador**      | 👤 1 agente com binding authority                |
| **Rounds Mínimos** | 3️⃣ Antes de finalizar                            |
| **Rounds Máximos** | 7️⃣ Depois escala automaticamente                 |
| **Visibilidade**   | 📢 Público (todos veem debate)                   |
| **Resultado**      | 📝 Decisão binding + rationale                   |
| **Escalação**      | ⬆️ Auto-escalate após 7 rounds                   |

### Fluxo de Escalação

```
Round 7 reached → No consensus
       │
       ▼
┌──────────────────────────────────┐
│ dispute.escalate()               │
│ → Escalates to immediate superior│
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Superior Joins as Moderator      │
│ Reviews debate thread            │
│ Makes BINDING decision           │
└──────────────────────────────────┘
```

### Exemplo de Uso

```typescript
// Iniciar debate
collaboration({
  action: "session.init",
  topic: "API design: REST vs GraphQL",
  agents: ["backend-architect", "frontend-architect", "api-specialist"],
});

// Propor solução
collaboration({
  action: "proposal.publish",
  sessionKey: "collab:uuid",
  decisionTopic: "API design",
  proposal: "GraphQL com Apollo",
  reasoning: "Flexibilidade de queries + type safety",
});

// Desafiar
collaboration({
  action: "proposal.challenge",
  sessionKey: "collab:uuid",
  decisionId: "...",
  challenge: "GraphQL aumenta complexity",
  suggestedAlternative: "REST + OpenAPI 3.0",
});

// Finalizar
collaboration({
  action: "decision.finalize",
  sessionKey: "collab:uuid",
  decisionId: "...",
  finalDecision: "REST + OpenAPI por simplicidade",
});
```

---

## 4. delegation - Hierarquia Formal

**Quando usar:** Delegação hierárquica com approval/tracking formal.

### Fluxo Visual - Downward (Superior → Subordinado)

```
┌──────────────┐
│ Tech Lead    │
│ (Matheus)    │
└──────┬───────┘
       │ delegation({
       │   action: "delegate",
       │   toAgentId: "backend-engineer",
       │   task: "Implement auth middleware",
       │   priority: "high"
       │ })
       │
       ▼
┌──────────────────────────────────┐
│ Delegation Record Created        │
│ - ID: delegation-uuid            │
│ - Status: pending                │
│ - Direction: downward            │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Backend Engineer                 │
│ - Receives delegation            │
│ - Can accept or reject           │
└──────┬───────────────────────────┘
       │
       │ delegation({
       │   action: "accept",
       │   delegationId: "..."
       │ })
       │
       ▼
┌──────────────────────────────────┐
│ Status: in_progress              │
│ [Engineer works on task]         │
└──────┬───────────────────────────┘
       │
       │ delegation({
       │   action: "complete",
       │   delegationId: "...",
       │   resultStatus: "success",
       │   resultSummary: "Auth middleware done"
       │ })
       │
       ▼
┌──────────────────────────────────┐
│ Status: completed                │
│ Tech Lead notified               │
└──────────────────────────────────┘
```

### Fluxo Visual - Upward (Subordinado → Superior)

```
┌──────────────┐
│ Junior Dev   │
└──────┬───────┘
       │ delegation({
       │   action: "request",
       │   task: "Need help with distributed transactions",
       │   justification: "Blocked: não sei pattern correto",
       │   priority: "high"
       │ })
       │
       ▼
┌──────────────────────────────────┐
│ Request → Immediate Superior     │
│ (Auto-routed to Tech Lead)       │
│ Status: pending_review           │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Tech Lead Reviews                │
│ delegation({                     │
│   action: "review",              │
│   delegationId: "...",           │
│   decision: "approve"            │
│ })                               │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ Tech Lead Helps Junior           │
│ - Provides guidance              │
│ - Or redirects to specialist     │
└──────────────────────────────────┘
```

### Características

| Aspecto        | Comportamento                                         |
| -------------- | ----------------------------------------------------- |
| **Direção**    | ⬇️ Downward (assign) ou ⬆️ Upward (request help)      |
| **Approval**   | ✅ Upward requer justificação + superior review       |
| **Tracking**   | 📊 Full lifecycle (pending → in_progress → completed) |
| **Prioridade** | 🚨 critical, high, normal, low                        |
| **Redirect**   | ↪️ Superior pode redirecionar para outro agente       |
| **Status**     | 📈 Rastreável via delegation({ action: "status" })    |

### Exemplo de Uso

```typescript
// Downward delegation (Lead → Engineer)
delegation({
  action: "delegate",
  toAgentId: "database-engineer",
  task: "Optimize query performance",
  priority: "high",
});

// Upward request (Engineer → Lead)
delegation({
  action: "request",
  task: "Preciso de code review urgente",
  justification: "Deploy em 2h, bloqueado",
  priority: "critical",
});

// Superior review
delegation({
  action: "review",
  delegationId: "...",
  decision: "approve",
  reasoning: "Prioritário para release",
});

// Complete
delegation({
  action: "complete",
  delegationId: "...",
  resultStatus: "success",
  resultSummary: "Query otimizada, 10x faster",
});
```

---

## 5. team_workspace - Memória Compartilhada

**Quando usar:** Compartilhar contexto, decisões, artifacts entre agentes.

### Fluxo Visual

```
┌──────────────┐
│ Agent A      │
│ (Architect)  │
└──────┬───────┘
       │ team_workspace({
       │   action: "write_artifact",
       │   name: "API_DESIGN_V2.md",
       │   content: "[design doc...]",
       │   description: "REST API design",
       │   tags: ["api", "design", "v2"]
       │ })
       │
       ▼
┌──────────────────────────────────────────────┐
│ Shared Workspace                             │
│ /team/artifacts/API_DESIGN_V2.md             │
│ - Visible to ALL agents                      │
│ - Versioned                                  │
│ - Tagged                                     │
└──────┬───────────────────────────────────────┘
       │
       │ [Later...]
       │
       ▼
┌──────────────┐
│ Agent B      │
│ (Engineer)   │
└──────┬───────┘
       │ team_workspace({
       │   action: "read_artifact",
       │   name: "API_DESIGN_V2.md"
       │ })
       │
       ▼
┌──────────────────────────────────────────────┐
│ Content Retrieved                            │
│ Agent B has full context                     │
└──────────────────────────────────────────────┘

┌──────────────┐
│ Agent C      │
│ (QA Lead)    │
└──────┬───────┘
       │ team_workspace({
       │   action: "set_context",
       │   key: "current_sprint",
       │   value: "Sprint 23: Auth refactor"
       │ })
       │
       ▼
┌──────────────────────────────────────────────┐
│ Context Store                                │
│ current_sprint → "Sprint 23: Auth refactor" │
└──────┬───────────────────────────────────────┘
       │
       │ [Any agent can read]
       │
       ▼
┌──────────────┐
│ Agent D      │
│ (Any)        │
└──────┬───────┘
       │ team_workspace({
       │   action: "get_context",
       │   key: "current_sprint"
       │ })
       │
       ▼
┌──────────────────────────────────────────────┐
│ "Sprint 23: Auth refactor"                   │
└──────────────────────────────────────────────┘
```

### Características

| Aspecto           | Comportamento                                 |
| ----------------- | --------------------------------------------- |
| **Acesso**        | 🌐 Global (todos os agentes)                  |
| **Persistência**  | 💾 Permanente (sobrevive restarts)            |
| **Tipos**         | 📄 Artifacts (files) + Context (key-value)    |
| **Busca**         | 🔍 Tags, name, description                    |
| **Versionamento** | 📚 Histórico mantido                          |
| **Decisões**      | 📋 list_decisions retorna debates finalizados |

### Exemplo de Uso

```typescript
// Escrever artifact
team_workspace({
  action: "write_artifact",
  name: "migration_plan.md",
  content: "## DB Migration...",
  description: "Plano de migração Postgres 14→16",
  tags: ["database", "migration", "postgres"],
});

// Ler artifact
team_workspace({
  action: "read_artifact",
  name: "migration_plan.md",
});

// Listar artifacts
team_workspace({
  action: "list_artifacts",
});

// Context key-value
team_workspace({
  action: "set_context",
  key: "db_version_target",
  value: "16.2",
});

team_workspace({
  action: "get_context",
  key: "db_version_target",
});

// Decisões de debates
team_workspace({
  action: "list_decisions",
});
// → Retorna todas as decisões finalizadas via collaboration
```

---

## 6. sessions_inbox - Inbox Assíncrona

**Quando usar:** Verificar mensagens pendentes sem bloquear.

### Fluxo Visual

```
┌──────────────┐
│ Agent X      │
└──────┬───────┘
       │ sessions_send({
       │   agentId: "backend-architect",
       │   message: "Ping quando tiver tempo",
       │   timeoutSeconds: 0  // Fire-and-forget
       │ })
       │
       ▼
┌──────────────────────────────────┐
│ Backend Architect Inbox          │
│ - Message queued                 │
│ - Agent NOT notified immediately │
└──────────────────────────────────┘

[Later, Backend Architect checks inbox...]

┌──────────────┐
│ Backend      │
│ Architect    │
└──────┬───────┘
       │ sessions_inbox()
       │
       ▼
┌──────────────────────────────────┐
│ Inbox Messages                   │
│ [                                │
│   {                              │
│     from: "agent-x",             │
│     message: "Ping quando tiver tempo",
│     timestamp: "..."             │
│   }                              │
│ ]                                │
└──────┬───────────────────────────┘
       │
       │ [Agent processa mensagens]
       │
       ▼
┌──────────────────────────────────┐
│ Agent Responds                   │
│ sessions_send({                  │
│   agentId: "agent-x",            │
│   message: "Pong! Disponível"   │
│ })                               │
└──────────────────────────────────┘
```

### Características

| Aspecto         | Comportamento                                                |
| --------------- | ------------------------------------------------------------ |
| **Bloqueante?** | ❌ Não (pull-based)                                          |
| **Polling**     | 🔄 Agent verifica quando quer                                |
| **Escopo**      | 📬 "agent" (todas mensagens) ou "session" (só desta session) |
| **Ordem**       | ⏰ FIFO (primeira a chegar, primeira a sair)                 |
| **Leitura**     | 👁️ Não marca como lida (stateless)                           |

### Exemplo de Uso

```typescript
// Verificar inbox (escopo agent - todas mensagens)
const messages = await sessions_inbox({ scope: "agent" });
// → Array de mensagens pendentes

// Verificar inbox (escopo session - só desta sessão)
const sessionMessages = await sessions_inbox({ scope: "session" });
// → Array de mensagens para esta session específica

// Processar mensagens
for (const msg of messages) {
  console.log(`From: ${msg.from}`);
  console.log(`Message: ${msg.message}`);
  console.log(`Timestamp: ${msg.timestamp}`);
}
```

---

## 7. sessions_spawn_batch - Paralelo Massivo

**Quando usar:** Executar múltiplas tasks em paralelo com coordenação.

### Fluxo Visual

```
┌──────────────┐
│ Orchestrator │
└──────┬───────┘
       │ sessions_spawn_batch({
       │   tasks: [
       │     { agentId: "researcher-1", task: "Research topic A" },
       │     { agentId: "researcher-2", task: "Research topic B" },
       │     { agentId: "researcher-3", task: "Research topic C" }
       │   ],
       │   waitMode: "all",
       │   cleanup: "delete"
       │ })
       │
       ▼
┌──────────────────────────────────────────────┐
│ 3 SubAgents Spawned Simultaneously           │
├──────────────────────────────────────────────┤
│ SubAgent 1: agent:researcher-1:subagent:uuid1│
│ SubAgent 2: agent:researcher-2:subagent:uuid2│
│ SubAgent 3: agent:researcher-3:subagent:uuid3│
└──────┬───────────────────────────────────────┘
       │
       │ [All run in parallel]
       │
       ▼
┌──────────────────────────────────────────────┐
│ Wait Mode: "all"                             │
│ - Orchestrator BLOCKS until ALL complete    │
└──────┬───────────────────────────────────────┘
       │
       │ [SubAgent 1 completes] ✅
       │ [SubAgent 3 completes] ✅
       │ [SubAgent 2 completes] ✅
       │
       ▼
┌──────────────────────────────────────────────┐
│ All Complete                                 │
│ Returns: {                                   │
│   results: [                                 │
│     { agentId: "researcher-1", status: "success", result: "..." },
│     { agentId: "researcher-2", status: "success", result: "..." },
│     { agentId: "researcher-3", status: "success", result: "..." }
│   ]                                          │
│ }                                            │
└──────────────────────────────────────────────┘
```

### Wait Modes

```
┌─────────────────────────────────────────────────────┐
│ waitMode: "all"                                     │
│ - BLOCKS até TODOS completarem                      │
│ - Retorna array com todos resultados                │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ waitMode: "any"                                     │
│ - BLOCKS até PRIMEIRO completar                     │
│ - Retorna apenas primeiro resultado                 │
│ - Outros continuam rodando em background            │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ waitMode: "none"                                    │
│ - NÃO BLOQUEIA (fire-and-forget)                    │
│ - Retorna imediatamente                             │
│ - Resultados aparecem via announce                  │
└─────────────────────────────────────────────────────┘
```

### Características

| Aspecto          | Comportamento                                      |
| ---------------- | -------------------------------------------------- |
| **Bloqueante?**  | ✅ Sim (waitMode: all/any) ou ❌ (waitMode: none)  |
| **Concorrência** | 🚀 N tasks simultâneas (respeitando maxConcurrent) |
| **Wait Modes**   | 🎯 all, any, none                                  |
| **Resultado**    | 📊 Array agregado ou fire-and-forget               |
| **Cleanup**      | 🗑️ Per-task ou global                              |
| **Use Case**     | 🔬 Pesquisa paralela, multi-domain analysis        |

### Exemplo de Uso

```typescript
// Pesquisa paralela com espera por todos
const results = await sessions_spawn_batch({
  tasks: [
    { agentId: "security-engineer", task: "Audit auth flow" },
    { agentId: "performance-engineer", task: "Benchmark API" },
    { agentId: "qa-lead", task: "Test coverage analysis" },
  ],
  waitMode: "all",
  runTimeoutSeconds: 300,
  cleanup: "delete",
});

// Fire-and-forget (não espera)
sessions_spawn_batch({
  tasks: [
    { agentId: "researcher-1", task: "Topic A" },
    { agentId: "researcher-2", task: "Topic B" },
  ],
  waitMode: "none",
});
// → Retorna imediatamente
// → Resultados aparecem via announce
```

---

## Comparação Rápida

| Tool                     | Bloqueante      | Resposta        | Concorrência   | Visibilidade | Use Case                 |
| ------------------------ | --------------- | --------------- | -------------- | ------------ | ------------------------ |
| **sessions_spawn**       | ❌              | Announce        | ✅ Paralelo    | 📢 Público   | Trabalho pesado/paralelo |
| **sessions_send**        | ✅              | Return value    | ❌ Síncrono    | 🔒 Privado   | Consulta rápida          |
| **collaboration**        | ⚠️ Multi-round  | Decision record | 👥 Multi-party | 📢 Público   | Decisão cross-domain     |
| **delegation**           | ⚠️ Tracked      | Status updates  | 📋 Hierárquico | 📊 Rastreado | Delegação formal         |
| **team_workspace**       | ❌              | Read/Write      | 🌐 Global      | 🌐 Público   | Memória compartilhada    |
| **sessions_inbox**       | ❌              | Poll            | 📬 Pull-based  | 🔒 Privado   | Mensagens assíncronas    |
| **sessions_spawn_batch** | ⚠️ Configurable | Array/None      | 🚀 Massivo     | 📢 Público   | Paralelo massivo         |

---

## Decision Tree - Qual Usar?

```
Preciso delegar trabalho?
│
├─ Sim → É trabalho pesado ou paralelo?
│        │
│        ├─ Sim → sessions_spawn (ou sessions_spawn_batch)
│        │
│        └─ Não → É hierárquico e precisa tracking formal?
│                 │
│                 ├─ Sim → delegation
│                 │
│                 └─ Não → sessions_send (mensagem direta)
│
└─ Não → Preciso de decisão cross-domain?
         │
         ├─ Sim → collaboration (debate estruturado)
         │
         └─ Não → Preciso compartilhar contexto?
                  │
                  ├─ Sim → team_workspace
                  │
                  └─ Não → Verificar mensagens pendentes?
                           │
                           └─ sessions_inbox
```

---

## Patterns Comuns

### Pattern 1: Fan-Out Research

```typescript
// Orquestrador faz fan-out de pesquisa
const results = await sessions_spawn_batch({
  tasks: [
    { agentId: "deep-research", task: "React Server Components" },
    { agentId: "deep-research", task: "Astro Islands" },
    { agentId: "deep-research", task: "Qwik Resumability" },
  ],
  waitMode: "all",
});

// Sintetiza resultados
const synthesis = results.map((r) => r.result).join("\n\n");
```

### Pattern 2: Quick Consult

```typescript
// Consulta rápida sem spawn
const answer = await sessions_send({
  agentId: "security-engineer",
  message: "Este JWT config está seguro?",
  timeoutSeconds: 30,
});
```

### Pattern 3: Team Decision

```typescript
// 1. Inicia debate
const session = await collaboration({
  action: "session.init",
  topic: "Escolher framework frontend",
  agents: ["frontend-architect", "ux-designer", "performance-engineer"],
});

// 2. Propõe
await collaboration({
  action: "proposal.publish",
  sessionKey: session.sessionKey,
  decisionTopic: "Framework choice",
  proposal: "Astro 4 + React Islands",
});

// 3. Debate (challenges, agrees)
// ...

// 4. Finaliza
await collaboration({
  action: "decision.finalize",
  sessionKey: session.sessionKey,
  decisionId: "...",
  finalDecision: "Astro 4 + React Islands aprovado",
});
```

### Pattern 4: Shared Context

```typescript
// Agent A escreve design doc
await team_workspace({
  action: "write_artifact",
  name: "api_v2_design.md",
  content: "...",
  tags: ["api", "design"],
});

// Agent B lê e implementa
const design = await team_workspace({
  action: "read_artifact",
  name: "api_v2_design.md",
});

// Agent C marca como current sprint
await team_workspace({
  action: "set_context",
  key: "current_work",
  value: "API v2 implementation",
});
```

---

## Boas Práticas

### ✅ DO

1. **Use sessions_spawn** para trabalho pesado que não precisa bloquear
2. **Use sessions_send** para consultas rápidas ponto-a-ponto
3. **Use collaboration** para decisões que afetam múltiplos domínios
4. **Use delegation** quando precisa tracking formal e hierárquico
5. **Use team_workspace** para compartilhar contexto entre agentes
6. **Use sessions_spawn_batch** para paralelização massiva coordenada

### ❌ DON'T

1. **Não use sessions_send** para trabalho pesado (vai bloquear)
2. **Não use collaboration** para decisões triviais (overhead desnecessário)
3. **Não use sessions_spawn** para consulta rápida (desperdício de recursos)
4. **Não ignore inbox** - messages podem se acumular
5. **Não crie debates sem moderador** - pode nunca convergir
6. **Não faça nested spawns** - subagents não podem spawnar subagents

---

_Criado: 2026-02-13_  
_Última atualização: 2026-02-13_
