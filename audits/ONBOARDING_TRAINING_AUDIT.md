# 🎓 AUDITORIA: Onboarding & Training

**Área:** Novos agentes, knowledge transfer, ramp-up process  
**Data:** 2026-02-13

---

## ❌ GAPS IDENTIFICADOS

1. **No onboarding process** - Novos agentes "descobrem" como funciona
2. **Missing training materials** - Sem docs de "como contribuir"
3. **Inconsistent ramp-up** - Depende de quem faz onboarding
4. **No buddy system** - Novos agentes ficam perdidos
5. **Knowledge silos** - Expertise concentrada em poucos agentes

---

## ✅ CORREÇÕES

### 15.1: Onboarding Checklist

```markdown
# ONBOARDING_CHECKLIST.md

## Day 1: Setup & Introduction

- [ ] **Access granted**
  - GitHub repository access
  - 1Password vault (secrets)
  - Slack/Discord channel
  - Development environment

- [ ] **Read core docs**
  - README.md (project overview)
  - AGENTS.md (how agents work)
  - MEMORY.md (current context)
  - ADRs (last 5 major decisions)

- [ ] **Local setup**
  - Clone repository
  - Install dependencies (`pnpm install`)
  - Run dev server (`pnpm dev`)
  - Run tests (`pnpm test`)

- [ ] **First task (starter bug)**
  - Pick "good first issue" from backlog
  - Follow CONTRIBUTING.md
  - Submit PR with tests
  - Get code review

## Week 1: Learning Phase

- [ ] **Shadow experienced agent**
  - Observe how they work
  - Ask questions
  - Take notes

- [ ] **Complete 3 small tasks**
  - Bug fixes (low complexity)
  - Documentation improvements
  - Test additions

- [ ] **Read codebase**
  - Auth module
  - API routes
  - Database schema
  - Frontend components (top 10)

- [ ] **Attend team meetings**
  - Daily standup (async)
  - Sprint planning
  - Retrospective

## Week 2-4: Ramp-Up

- [ ] **Own a small feature end-to-end**
  - Design → Implement → Test → Deploy
  - With guidance from tech lead

- [ ] **Pair with specialist**
  - Backend architect (if backend focus)
  - Frontend architect (if frontend focus)
  - Security engineer (for all)

- [ ] **Learn debugging**
  - Use observability stack (Grafana)
  - Read logs (Loki)
  - Trace requests (Tempo)

- [ ] **Contribute to docs**
  - Update outdated docs you found
  - Add examples where missing

## Month 2: Independence

- [ ] **Own medium feature**
  - Lead design discussion
  - Implement with minimal guidance
  - Present in demo

- [ ] **Mentor newcomer**
  - Answer questions
  - Review PRs
  - Share knowledge

- [ ] **Specialize**
  - Choose focus area (auth, payments, UI, etc.)
  - Become go-to person for that area
```

### 15.2: Training Materials

```markdown
# CONTRIBUTING.md

## How to Contribute

### 1. Pick a Task

- Check [Issues](https://github.com/org/repo/issues)
- Filter by `good-first-issue` (newcomers)
- Assign yourself (comment "I'll take this")

### 2. Create Branch

\`\`\`bash
git checkout -b feat/your-feature-name

# or

git checkout -b fix/bug-description
\`\`\`

### 3. Make Changes

- Follow [Code Style Guide](#code-style)
- Add tests (see [Testing Guide](#testing))
- Update docs if needed

### 4. Commit

Use [Conventional Commits](https://www.conventionalcommits.org/):

\`\`\`bash
git commit -m "feat(api): add user export endpoint"

# or

git commit -m "fix(auth): resolve token refresh race condition"
\`\`\`

### 5. Push & Create PR

\`\`\`bash
git push origin feat/your-feature-name

# Then create PR on GitHub

\`\`\`

PR template will guide you through:

- What changed
- Why (link to issue)
- Testing performed
- Screenshots (if UI)

### 6. Address Review Feedback

- Respond to all comments
- Make requested changes
- Re-request review

### 7. Merge

After approval:

- Squash commits (keep history clean)
- Delete branch after merge

---

## Code Style

- **TypeScript strict mode** (no `any`)
- **Functional style** (prefer pure functions)
- **Naming:**
  - Functions: `camelCase` (e.g., `createOrder`)
  - Components: `PascalCase` (e.g., `OrderCard`)
  - Constants: `UPPER_SNAKE_CASE` (e.g., `MAX_RETRIES`)
- **File names:** `kebab-case.ts` (e.g., `order-service.ts`)

---

## Testing

- **Unit tests:** Co-located with source (`*.test.ts`)
- **Coverage:** Aim for 80%+, critical modules 90%+
- **Naming:** `should [expected] when [condition]`

Example:
\`\`\`typescript
test('should create order when items are valid', async () => {
const order = await createOrder({ userId: 'user-1', items: [...] });
expect(order.id).toBeDefined();
});
\`\`\`

---

## Need Help?

- **Stuck?** Ask in #dev channel
- **Bug?** Create issue with reproduction steps
- **Unclear docs?** Ask, then update the docs yourself
```

### 15.3: Buddy System

```yaml
# BUDDY_ASSIGNMENTS.yml

# Each new agent gets a buddy (experienced agent in same domain)

buddies:
  - newcomer: new-backend-specialist
    buddy: backend-architect
    focus: Backend development, API design
    duration: 4 weeks

  - newcomer: new-frontend-specialist
    buddy: frontend-architect
    focus: Astro, React islands, UI components
    duration: 4 weeks

  - newcomer: new-qa-engineer
    buddy: qa-lead
    focus: Test automation, Playwright
    duration: 4 weeks

# Buddy responsibilities:
# - Answer questions (< 2h response time)
# - Review all PRs from newcomer (first 2 weeks)
# - Weekly 1:1 check-in (15min)
# - Introduce to team members
```

### 15.4: Knowledge Transfer Sessions

```markdown
# KNOWLEDGE_SESSIONS.md

## Weekly Lightning Talks (15min)

**Format:**

- Presenter: Any team member
- Topic: Something they learned recently
- Audience: Entire team
- Recording: Uploaded to team wiki

**Recent sessions:**

- "Better Auth Refresh Tokens" by @auth-specialist
- "N+1 Query Debugging with Drizzle" by @database-engineer
- "Playwright Visual Regression Testing" by @qa-automation

**Upcoming:**

- "Stripe Webhook Security" by @security-engineer (2026-02-15)
- "Astro Islands Performance" by @frontend-architect (2026-02-20)

## Monthly Deep Dives (1h)

**Format:**

- Deep exploration of system/feature
- Live coding session
- Q&A

**Topics:**

- Auth system architecture
- Payment flow end-to-end
- Database schema design
- Deployment pipeline
```

### 15.5: Self-Service Learning Paths

```markdown
# LEARNING_PATHS.md

## Backend Engineer Path

### Beginner (Weeks 1-4)

- [ ] Complete Elysia tutorial
- [ ] Build simple CRUD API
- [ ] Learn Drizzle ORM
- [ ] Write unit tests with Vitest

### Intermediate (Weeks 5-12)

- [ ] Implement auth with Better Auth
- [ ] Add database migrations
- [ ] Optimize queries (indexes, caching)
- [ ] Deploy to staging

### Advanced (Months 4-6)

- [ ] Design microservice architecture
- [ ] Implement event-driven patterns
- [ ] Lead technical decision (ADR)
- [ ] Mentor newcomer

---

## Frontend Engineer Path

### Beginner (Weeks 1-4)

- [ ] Learn Astro basics
- [ ] Build static pages (SSG)
- [ ] Add React islands (SSR)
- [ ] Style with Tailwind

### Intermediate (Weeks 5-12)

- [ ] Implement auth UI
- [ ] Add form validation (Zod)
- [ ] Optimize performance (lazy loading)
- [ ] Write E2E tests (Playwright)

### Advanced (Months 4-6)

- [ ] Design component system
- [ ] Implement accessibility (WCAG 2.1 AA)
- [ ] Lead UI/UX decisions
- [ ] Mentor newcomer
```

---

## 📊 MÉTRICAS DE SUCESSO

- [ ] 100% of new agents complete onboarding checklist
- [ ] < 1 week to first PR merged
- [ ] < 4 weeks to independent feature delivery
- [ ] 90% newcomer retention after 3 months
- [ ] Zero "I didn't know how to..." incidents

---

## 🎯 ACTION ITEMS

### Imediatos

1. [ ] Create ONBOARDING_CHECKLIST.md
2. [ ] Assign buddy to each newcomer
3. [ ] Update CONTRIBUTING.md with clear steps
4. [ ] Create "good first issue" backlog

### Curto Prazo

1. [ ] Record knowledge transfer sessions
2. [ ] Build self-service learning paths
3. [ ] Create onboarding dashboard (track progress)
4. [ ] Collect feedback from newcomers

### Longo Prazo

1. [ ] Automated onboarding (scripts, tools)
2. [ ] Interactive tutorials (code challenges)
3. [ ] Certification program (skill verification)
4. [ ] Alumni program (return for mentoring)

---

**FIM DO DOCUMENTO**
