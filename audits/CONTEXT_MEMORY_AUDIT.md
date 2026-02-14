# 🧠 AUDITORIA: Context & Memory Management

**Área:** MEMORY.md, team_workspace, knowledge retention, context budget  
**Data:** 2026-02-13

---

## ❌ GAPS IDENTIFICADOS

1. **MEMORY.md desatualizado** - Decisões antigas, info incorreta
2. **team_workspace subutilizado** - Agentes não compartilham artefatos
3. **Conhecimento não persistido** - Insights perdidos entre sessões
4. **Context overload** - Agentes carregam histórico inteiro (>100k tokens)
5. **Search ineficaz** - Difícil encontrar info em MEMORY.md

---

## ✅ CORREÇÕES

### 12.1: MEMORY.md Structure

```markdown
# MEMORY.md

## Project Identity

- **Name:** OpenClaw
- **Stack:** Bun + Elysia + Astro + Drizzle + Better Auth
- **Team Size:** 67 agents

## Critical Decisions (Last 30 Days)

### AUTH-2026-02-10: JWT Refresh Tokens

**Decision:** Use Better Auth refresh tokens plugin  
**Reasoning:** Built-in, secure by default, automatic rotation  
**Owner:** @auth-specialist  
**Status:** ✅ Implemented  
**ADR:** [ADR-023](./docs/adr/023-jwt-refresh.md)

### DB-2026-02-08: Orders Table Indexing

**Decision:** Add composite index on (user_id, created_at)  
**Reasoning:** 95% of queries filter by user + sort by date  
**Owner:** @database-engineer  
**Status:** ✅ Deployed

## Active Work (Current Sprint)

- **Payment System:** @backend-architect (80% done)
- **Dark Mode UI:** @frontend-architect (design review pending)
- **E2E Tests:** @qa-lead (20 tests created, 30 more needed)

## Blockers

- **Stripe Webhook Signature:** Waiting for official docs clarification

## Key Contacts

- **Auth issues:** @auth-specialist
- **DB performance:** @database-engineer
- **Deploy questions:** @devops-engineer

## Common Commands

\`\`\`bash

# Start dev server

pnpm dev

# Run tests

pnpm test

# Deploy staging

./scripts/deploy-staging.sh
\`\`\`

## Gotchas

- **Better Auth sessions:** Expire after 15min, auto-refresh in frontend
- **Decimal precision:** ALWAYS use DECIMAL(19,4) for money, NEVER float
- **Rate limiting:** 100 req/min per IP on public endpoints
```

### 12.2: Memory Search Tool

```typescript
// Tool: memory_search (já exists, improve prompts)

// MANDATORY USAGE PATTERN:
// Before answering questions about:
// - Prior work, decisions, dates
// - People, preferences, architecture choices
// - Todos, blockers, open questions

// ALWAYS run:
memory_search({ query: "relevant keywords" });

// Then use memory_get to fetch specific sections
memory_get({ path: "MEMORY.md", from: 15, lines: 10 });
```

### 12.3: team_workspace Protocols

```typescript
// MANDATORY: Write all deliverables to workspace

// After implementing feature
team_workspace({
  action: "write_artifact",
  name: "payment-integration-summary.md",
  content: `
# Payment Integration Summary

## What Was Done
- Stripe integration with webhook handling
- Payment flow: intent → confirm → webhook
- Error handling for all Stripe errors

## Files Changed
- src/payment/stripe-client.ts (new)
- src/payment/webhook-handler.ts (new)
- src/api/routes/payment.ts (updated)

## Tests
- Unit: 15 tests, 95% coverage
- Integration: 3 end-to-end flows
- Manual: Tested with test cards

## Next Steps
- [ ] Add refund logic
- [ ] Implement subscription billing
  `,
  tags: ["payment", "stripe", "implementation", "complete"],
});

// Share decisions
team_workspace({
  action: "set_context",
  key: "payment-provider",
  value: "Stripe (chosen 2026-02-10, reason: best docs + ecosystem)",
});

// Read before starting related work
const paymentContext = team_workspace({ action: "get_context", key: "payment-provider" });
```

### 12.4: Context Budget Management

```typescript
// ANTI-PATTERN: Load full history
sessions_history({ sessionKey: "session-123", limit: 10000 }); // ❌ 100k+ tokens

// ✅ GOOD: Targeted windows
sessions_history({ sessionKey: "session-123", limit: 20 }); // Recent context only

// ✅ GOOD: Summarize old context
const summary = team_workspace({ action: "get_summary" }); // Pre-aggregated

// ✅ GOOD: Search then fetch
memory_search({ query: "auth decision" }); // Find relevant section
memory_get({ path: "MEMORY.md", from: 25, lines: 5 }); // Fetch only that section
```

### 12.5: Knowledge Retention Automation

```typescript
// Cron job: Daily MEMORY.md update

cron({
  action: "add",
  job: {
    schedule: { kind: "cron", expr: "0 18 * * *" }, // 6pm daily
    payload: {
      kind: "agentTurn",
      message: `Update MEMORY.md with today's work.

Read team_workspace artifacts from today.
Summarize:
1. Major decisions made
2. Features completed
3. Blockers encountered
4. Key learnings

Update MEMORY.md sections:
- Critical Decisions (add new)
- Active Work (update status)
- Blockers (add/resolve)

Keep MEMORY.md under 500 lines (archive old content to memory/archive/).
`,
      model: "sonnet",
    },
    sessionTarget: "isolated",
  },
});
```

---

## 📊 MÉTRICAS DE SUCESSO

- [ ] MEMORY.md updated daily
- [ ] 90% of decisions documented in team_workspace
- [ ] < 2min to find any decision via memory_search
- [ ] Zero context budget overruns (all < 50k tokens)

---

**FIM DO DOCUMENTO**
