# 🛠️ AUDITORIA: Tool Usage Patterns

**Área:** Quando usar cada tool, patterns, anti-patterns  
**Data:** 2026-02-13

---

## ❌ GAPS IDENTIFICADOS

1. **Tool misuse** - Agentes usam ferramentas erradas para tarefas
2. **Redundant calls** - Múltiplas chamadas desnecessárias
3. **Missing error handling** - Não tratam failures de tools
4. **No validation** - Não validam resultados antes de usar

---

## ✅ PADRÕES CORRETOS

### Pattern 1: sessions_spawn vs delegation

```typescript
// ❌ BAD: Fire-and-forget para tarefa crítica
sessions_spawn({ task: "Implement payment", agentId: "backend-architect" });
// Problema: Sem tracking de status/progresso

// ✅ GOOD: Use delegation para tracking
delegation({
  action: "delegate",
  toAgentId: "backend-architect",
  task: "Implement payment with Stripe",
  priority: "high",
  acceptance_criteria: ["Tests passing", "Docs updated"],
});
```

### Pattern 2: Read file eficientemente

```typescript
// ❌ BAD: Read arquivo inteiro
const file = Read({ path: "src/large-file.ts" }); // 10k lines, 500kb

// ✅ GOOD: Search first, then targeted read
exec({ command: "grep -n 'createOrder' src/large-file.ts" });
// Output: "245: export function createOrder"
Read({ path: "src/large-file.ts", offset: 240, limit: 20 }); // Only relevant lines
```

### Pattern 3: collaboration.session.init timing

```typescript
// ❌ BAD: Debate para decisão trivial
collaboration({ action: "session.init", topic: "Should we use camelCase or snake_case?" });
// Problema: Overkill, consultar style guide

// ✅ GOOD: Debate para decisão arquitetural
collaboration({
  action: "session.init",
  topic: "REST vs GraphQL for orders API",
  agents: ["backend-architect", "frontend-architect", "system-architect"],
});
// Justificado: Impacta múltiplos sistemas, trade-offs complexos
```

### Pattern 4: web_search + web_fetch

```typescript
// ❌ BAD: Search sem validar resultado
const results = web_search({ query: "Better Auth refresh tokens" });
// Usar primeiro resultado sem verificar se é oficial

// ✅ GOOD: Priorizar docs oficiais
const results = web_search({ query: "Better Auth refresh tokens site:docs.better-auth.com" });
const doc = web_fetch({ url: results[0].url });
// Validar: URL é docs oficiais? Conteúdo faz sentido?
```

### Pattern 5: team_workspace consistency

```typescript
// ❌ BAD: Artifact sem tags
team_workspace({
  action: "write_artifact",
  name: "stuff.md",
  content: "Some random notes",
});

// ✅ GOOD: Structured artifact
team_workspace({
  action: "write_artifact",
  name: "auth-jwt-implementation.md",
  content: "...",
  description: "JWT implementation notes from 2026-02-10",
  tags: ["auth", "jwt", "implementation", "backend"],
});
```

### Pattern 6: Error handling

```typescript
// ❌ BAD: Assume tool succeeds
const result = sessions_spawn({ task: "...", agentId: "unknown-agent" });
// Crash se agente não existe

// ✅ GOOD: Validate + handle errors
const agentsList = agents_list({});
if (!agentsList.agents.find((a) => a.id === "backend-architect")) {
  // Handle: Agente não disponível
  return "Error: backend-architect not found";
}

const result = sessions_spawn({ task: "...", agentId: "backend-architect" });
```

---

## 📊 DECISION TREE: Tool Selection

```
Preciso delegar trabalho?
│
├─ Tracking necessário? (status, progresso, approval)
│  └─ YES → delegation()
│
├─ Fire-and-forget OK?
│  └─ YES → sessions_spawn()
│
└─ Múltiplas tarefas paralelas?
   └─ YES → sessions_spawn_batch()

───────────────────────────────────

Preciso de informação?
│
├─ Info está em docs locais?
│  └─ YES → Read(), grep, memory_search()
│
├─ Info está em web (oficial)?
│  └─ YES → web_search() → web_fetch()
│
├─ Info precisa de outro agente?
│  └─ YES → sessions_send()
│
└─ Info precisa de decisão coletiva?
   └─ YES → collaboration.session.init()

───────────────────────────────────

Preciso persistir conhecimento?
│
├─ Decisão importante?
│  └─ YES → team_workspace.set_context() + ADR
│
├─ Artefato de trabalho?
│  └─ YES → team_workspace.write_artifact()
│
└─ Atualizar memória de longo prazo?
   └─ YES → Write MEMORY.md
```

---

## 🚫 ANTI-PATTERNS

### Anti-Pattern 1: Overuse of sessions_spawn

```typescript
// ❌ BAD: Spawn para tarefa trivial que você pode fazer
sessions_spawn({ task: "Create a hello world function", agentId: "backend-architect" });

// ✅ GOOD: Faça você mesmo se é dentro do seu escopo
function helloWorld() {
  return "Hello, World!";
}
```

### Anti-Pattern 2: Polling sessions_progress

```typescript
// ❌ BAD: Poll a cada segundo
while (true) {
  const status = sessions_progress({ sessionKey: "..." });
  if (status.status === "completed") break;
  await sleep(1000);  // 1s
}

// ✅ GOOD: Use waitMode ou timeout
sessions_spawn_batch({
  tasks: [...],
  waitMode: "all",  // Espera todos completarem
});
```

### Anti-Pattern 3: Ignorar inbox

```typescript
// ❌ BAD: Começar trabalho sem checar mensagens
async function startTask() {
  // Implementar feature...
}

// ✅ GOOD: Sempre checar inbox primeiro
async function startTask() {
  const inbox = sessions_inbox({ scope: "agent" });
  // Ler mensagens, ajustar plano se necessário

  // Implementar feature...
}
```

---

## 📊 MÉTRICAS DE SUCESSO

- [ ] Zero tool misuse (wrong tool for task)
- [ ] < 5% de failed tool calls
- [ ] 100% de tool calls têm error handling
- [ ] Zero duplicate calls (cache/memo quando possível)

---

**FIM DO DOCUMENTO**
