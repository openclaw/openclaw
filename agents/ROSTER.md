# DBH Ventures — Agent Roster

> **Orchestrator:** Steve 🐺
> **Last Updated:** 2026-01-30

This document defines all sub-agents available for DBH Ventures incubation projects. Each agent has a specific role, can be spawned via `sessions_spawn`, and follows the Multi-Agent Coordination Protocol.

---

## Active Agents

### 🐺 Steve (Orchestrator)
- **Role:** Executive assistant, orchestration, oversight
- **Spawnable:** No (main agent)
- **Responsibilities:**
  - Triage incoming requests
  - Spawn and monitor sub-agents
  - Report on progress
  - Maintain agent roster and documentation
  - Ensure coordination protocol is followed

---

### 📋 Project Manager
- **Role:** Create comprehensive project documentation
- **Location:** `/agents/project-manager/AGENT.md`
- **Spawnable:** Yes
- **Label:** `project-manager`
- **Outputs:** Project specs, CONCEPT.md, Bear documents
- **Used for:**
  - New project kickoff
  - Moving from Idea → Foundation phase
  - Creating structured documentation

---

### 🛠️ Builder
- **Role:** Code implementation, technical development
- **Location:** `/agents/builder/AGENT.md`
- **Spawnable:** Yes
- **Label:** `builder`
- **Outputs:** Code, PRs, technical implementation
- **Used for:**
  - Scaffolding new projects
  - Implementing features
  - Bug fixes
  - Technical refactoring

---

### 🔍 Scout
- **Role:** Research, competitive analysis, market intelligence
- **Location:** `/agents/scout/AGENT.md`
- **Spawnable:** Yes
- **Label:** `scout`
- **Outputs:** Research reports, competitive matrices, market analysis
- **Used for:**
  - Competitive landscape analysis
  - Market research
  - Technology evaluation
  - Trend analysis

---

### 🎨 Canvas
- **Role:** Design, UI/UX, visual assets
- **Location:** `/agents/canvas/AGENT.md`
- **Spawnable:** Yes
- **Label:** `canvas`
- **Outputs:** Design mockups, component specs, brand assets
- **Used for:**
  - UI/UX design
  - Logo and branding
  - Component design
  - Visual documentation

---

### ✍️ Scribe
- **Role:** Documentation, content, copywriting
- **Location:** `/agents/scribe/AGENT.md`
- **Spawnable:** Yes
- **Label:** `scribe`
- **Outputs:** Docs, README, marketing copy, blog posts
- **Used for:**
  - Technical documentation
  - User guides
  - Marketing copy
  - Blog posts and announcements

---

### 🛡️ Sentinel
- **Role:** QA, security, testing
- **Location:** `/agents/sentinel/AGENT.md`
- **Spawnable:** Yes
- **Label:** `sentinel`
- **Outputs:** Test results, security audits, bug reports
- **Used for:**
  - Code review
  - Security audits
  - Testing
  - Quality assurance

---

### 📊 Analyst
- **Role:** Data analysis, financial modeling
- **Location:** `/agents/analyst/AGENT.md`
- **Spawnable:** Yes
- **Label:** `analyst`
- **Outputs:** Financial models, data analysis, metrics reports
- **Used for:**
  - Financial projections
  - Metrics analysis
  - Data-driven insights

---

### 🧪 Tester
- **Role:** QA, UI/UX testing, mobile responsiveness
- **Location:** `/agents/tester/AGENT.md`
- **Spawnable:** Yes
- **Label:** `tester`
- **Outputs:** QA reports, UI issues, accessibility findings
- **Used for:**
  - Mobile responsiveness review
  - UI/UX testing after Canvas/Builder work
  - Accessibility audits
  - User flow testing

---

### 🏗️ UX Architect
- **Role:** Design system consistency, information architecture, UX cohesion
- **Location:** `/agents/ux-architect/AGENT.md`
- **Spawnable:** Yes
- **Label:** `ux-architect`
- **Outputs:** UX audits, IA recommendations, component consolidation plans
- **Used for:**
  - Eliminating redundancy across views
  - Ensuring each page has clear purpose
  - Design system maintenance
  - Pre-release UX reviews

---

### 🧠 Thinker
- **Role:** Deep reasoning, complex analysis, strategic thinking
- **Location:** `/agents/thinker/AGENT.md`
- **Spawnable:** Yes
- **Label:** `thinker`
- **Model:** `openai/codex` with `thinking: "medium"`
- **Outputs:** Strategic analysis, architecture decisions, risk assessments
- **Used for:**
  - Complex architectural decisions
  - Strategic business analysis
  - Multi-factor tradeoff evaluation
  - Debugging difficult problems
  - Long-term planning

---

## Spawning Agents

```python
# From Steve (orchestrator), spawn a sub-agent:
sessions_spawn(
    task="[Detailed task description]",
    label="builder",  # or scout, canvas, scribe, etc.
)
```

## Coordination Protocol

All agents follow the DBH Ventures Multi-Agent Coordination Protocol:

1. **Claim tasks** in Vikunja with `🔒 CLAIMED:`
2. **Signal intent** with `🎯 INTENT:`
3. **Update progress** with `📝 UPDATE:`
4. **Complete** with `✅ COMPLETE:`
5. **Handoff** with `🤝 HANDOFF:`

See: `bear://x-callback-url/open-note?title=DBH%20Ventures%20%E2%80%94%20Multi-Agent%20Coordination%20Protocol`

---

## Agent Status Dashboard

*This will be replaced by Agent Console once it's built!*

| Agent | Status | Current Task |
|-------|--------|--------------|
| 🐺 Steve | 🟢 Active | Orchestrating Agent Console build |
| 📋 Project Manager | 🟡 Idle | — |
| 🛠️ Builder | 🟢 Active | Landing page + subdomain restructure |
| 🔍 Scout | 🟡 Idle | ✅ Completed: Competitive research |
| 🎨 Canvas | 🟡 Idle | ✅ Completed: Logo and brand identity |
| ✍️ Scribe | 🟡 Idle | ✅ Completed: Landing copy + README |
| 🛡️ Sentinel | 🟢 Active | Pre-launch security review |
| 📊 Analyst | 🟢 Active | Pricing model design |

## Recent Activity

- **2026-01-30 19:30** — 🛠️ Builder: SSE real-time updates complete
- **2026-01-30 19:28** — 🎨 Canvas: Logo + brand identity complete
- **2026-01-30 19:26** — ✍️ Scribe: README complete
- **2026-01-30 19:24** — ✍️ Scribe: Landing page copy complete
- **2026-01-30 19:18** — 🛠️ Builder: Task-session linking complete
- **2026-01-30 19:15** — 🛠️ Builder: Session detail view complete
- **2026-01-30 19:08** — 🛠️ Builder: OpenClaw API integration complete
- **2026-01-30 19:04** — 🛠️ Builder: Password protection complete
- **2026-01-30 18:59** — 🛠️ Builder: GitHub repo + Vercel deployment
- **2026-01-30 18:57** — 🛠️ Builder: Scaffolded Agent Console (Next.js + Tailwind)
- **2026-01-30 18:14** — 🔍 Scout: Completed agent ops landscape research
- **2026-01-30 18:16** — 📋 Project Manager: Created Agent Console project spec
