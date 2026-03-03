# Matrix Tier 3 Sub-Agents

**Purpose:** Define specialized sub-agents for each department head (Neo, Morpheus, Trinity) to handle specific execution tasks.

**Goal:** 10+ sub-agents per department = 30+ specialized workers for flexible, adaptable assistance.

---

## Current State

| Agent  | Department  | Current SOUL.md  | Status               |
| ------ | ----------- | ---------------- | -------------------- |
| Tank   | Engineering | Generic template | ❌ No specialization |
| Dozer  | Engineering | Generic template | ❌ No specialization |
| Mouse  | Engineering | Generic template | ❌ No specialization |
| Niobe  | Marketing   | Generic template | ❌ No specialization |
| Switch | Marketing   | Generic template | ❌ No specialization |
| Rex    | Marketing   | Generic template | ❌ No specialization |
| Oracle | Finance     | Generic template | ❌ No specialization |
| Seraph | Finance     | Generic template | ❌ No specialization |
| Zee    | Finance     | Generic template | ❌ No specialization |

**All 9 agents have identical, generic SOUL.md files.** They need specialized definitions.

---

## Architecture Principle

```
Tier 2 (Department Head) = Orchestration
   └── Understands the problem
   └── Chooses the right specialist
   └── Delegates with clear brief
   └── Reviews output
   └── Reports back

Tier 3 (Specialist) = Execution
   └── Deep expertise in narrow domain
   └── Executes the specific task
   └── Logs work in specialized memory files
   └── Returns result to department head
```

**Key insight:** Tier 3 agents are domain-agnostic (work vs personal). A coder codes, whether it's a work project or a personal script.

---

## Department 1: Engineering (Neo's Crew)

Neo routes technical tasks to the appropriate specialist.

### Current Agents (Need Redefinition)

| ID    | Name  | Proposed Specialization                             |
| ----- | ----- | --------------------------------------------------- |
| tank  | Tank  | Backend Engineer — APIs, databases, server logic    |
| dozer | Dozer | DevOps Engineer — Infrastructure, CI/CD, deployment |
| mouse | Mouse | QA + Research — Testing, audits, library evaluation |

### Proposed Additional Agents (7 more)

| ID     | Name   | Specialization       | Use Cases                                               |
| ------ | ------ | -------------------- | ------------------------------------------------------- |
| spark  | Spark  | Frontend Engineer    | UI components, React/Vue, CSS, user-facing code         |
| cipher | Cipher | Security Engineer    | Vulnerability scanning, auth, encryption, pen testing   |
| link   | Link   | Integration Engineer | API integrations, webhooks, third-party services        |
| ghost  | Ghost  | Data Engineer        | Pipelines, ETL, data modeling, analytics infrastructure |
| binary | Binary | Mobile Engineer      | iOS, Android, React Native, mobile-specific issues      |
| kernel | Kernel | Systems Engineer     | Low-level code, performance, optimization, OS-level     |
| prism  | Prism  | AI/ML Engineer       | Model integration, prompt engineering, embeddings       |

### Engineering Decision Tree

```
Task arrives at Neo
├── API or database work?           → Tank (Backend)
├── UI/frontend work?               → Spark (Frontend)
├── Infrastructure/deployment?      → Dozer (DevOps)
├── Security concern?               → Cipher (Security)
├── Third-party integration?        → Link (Integration)
├── Data pipeline/ETL?              → Ghost (Data)
├── Mobile app work?                → Binary (Mobile)
├── Performance/optimization?       → Kernel (Systems)
├── AI/model integration?           → Prism (AI/ML)
├── Testing/audit/research?         → Mouse (QA)
└── Quick fix or review?            → Handle directly
```

---

## Department 2: Marketing (Morpheus's Crew)

Morpheus routes content and communication tasks.

### Current Agents (Need Redefinition)

| ID     | Name   | Proposed Specialization                                                 |
| ------ | ------ | ----------------------------------------------------------------------- |
| niobe  | Niobe  | Content Strategist — Long-form content, scripts, research-heavy writing |
| switch | Switch | Creative Director — Visual concepts, design briefs, brand assets        |
| rex    | Rex    | PR & Communications — Newsletter, email, social, press releases         |

### Proposed Additional Agents (7 more)

| ID    | Name  | Specialization       | Use Cases                                               |
| ----- | ----- | -------------------- | ------------------------------------------------------- |
| ink   | Ink   | Copywriter           | Headlines, taglines, short-form copy, landing pages     |
| vibe  | Vibe  | Social Media Manager | Posts, threads, engagement, community management        |
| lens  | Lens  | Video Producer       | Scripts, storyboards, video editing briefs, thumbnails  |
| echo  | Echo  | Email Marketing      | Sequences, automation, deliverability, A/B testing      |
| nova  | Nova  | SEO Specialist       | Keyword research, on-page optimization, technical SEO   |
| pulse | Pulse | Community Manager    | Discord/Slack, forums, user engagement, feedback loops  |
| blaze | Blaze | Brand Strategist     | Positioning, messaging frameworks, competitive analysis |

### Marketing Decision Tree

```
Task arrives at Morpheus
├── Long-form content or script?    → Niobe (Content)
├── Visual/design brief?            → Switch (Creative)
├── Email or newsletter?            → Rex (PR) or Echo (Email)
├── Social media post?              → Vibe (Social)
├── Video content?                  → Lens (Video)
├── SEO/keywords?                   → Nova (SEO)
├── Community management?           → Pulse (Community)
├── Brand positioning?              → Blaze (Brand)
├── Headlines/short copy?           → Ink (Copy)
└── Strategy or positioning?        → Handle directly
```

---

## Department 3: Finance (Trinity's Crew)

Trinity routes money and operations tasks.

### Current Agents (Need Redefinition)

| ID     | Name   | Proposed Specialization                                      |
| ------ | ------ | ------------------------------------------------------------ |
| oracle | Oracle | Data Analyst — Revenue analysis, forecasting, trend modeling |
| seraph | Seraph | Security & Compliance — Vendor risk, compliance, regulatory  |
| zee    | Zee    | Financial Analyst — Tracking, audits, KPI updates            |

### Proposed Additional Agents (7 more)

| ID     | Name   | Specialization     | Use Cases                                           |
| ------ | ------ | ------------------ | --------------------------------------------------- |
| ledger | Ledger | Bookkeeper         | Transactions, categorization, reconciliation        |
| vault  | Vault  | Investment Analyst | Portfolio tracking, investment research, allocation |
| shield | Shield | Insurance & Risk   | Coverage review, claims, risk assessment            |
| trace  | Trace  | Expense Tracker    | Receipts, reimbursements, expense reports           |
| quota  | Quota  | Budget Manager     | Envelope budgeting, alerts, spending limits         |
| merit  | Merit  | Procurement        | Vendor comparison, contracts, negotiations          |
| beacon | Beacon | Tax Specialist     | Deductions, filings, tax optimization               |

### Finance Decision Tree

```
Task arrives at Trinity
├── Revenue/forecasting?            → Oracle (Data)
├── Compliance/regulatory?          → Seraph (Compliance)
├── Tracking/auditing?              → Zee (Analyst)
├── Transaction entry/reconciliation? → Ledger (Bookkeeper)
├── Investment question?            → Vault (Investments)
├── Insurance/risk coverage?        → Shield (Insurance)
├── Expense report/receipt?         → Trace (Expenses)
├── Budget envelope management?     → Quota (Budget)
├── Vendor/contract question?       → Merit (Procurement)
├── Tax question?                   → Beacon (Tax)
└── Flag or status check?           → Handle directly
```

---

## Full Sub-Agent Inventory

### Engineering (10 agents)

| ID     | Name   | Role                 | Status                |
| ------ | ------ | -------------------- | --------------------- |
| tank   | Tank   | Backend Engineer     | 🔴 Needs redefinition |
| dozer  | Dozer  | DevOps Engineer      | 🔴 Needs redefinition |
| mouse  | Mouse  | QA + Research        | 🔴 Needs redefinition |
| spark  | Spark  | Frontend Engineer    | ⚪ To create          |
| cipher | Cipher | Security Engineer    | ⚪ To create          |
| link   | Link   | Integration Engineer | ⚪ To create          |
| ghost  | Ghost  | Data Engineer        | ⚪ To create          |
| binary | Binary | Mobile Engineer      | ⚪ To create          |
| kernel | Kernel | Systems Engineer     | ⚪ To create          |
| prism  | Prism  | AI/ML Engineer       | ⚪ To create          |

### Marketing (10 agents)

| ID     | Name   | Role                 | Status                |
| ------ | ------ | -------------------- | --------------------- |
| niobe  | Niobe  | Content Strategist   | 🔴 Needs redefinition |
| switch | Switch | Creative Director    | 🔴 Needs redefinition |
| rex    | Rex    | PR & Communications  | 🔴 Needs redefinition |
| ink    | Ink    | Copywriter           | ⚪ To create          |
| vibe   | Vibe   | Social Media Manager | ⚪ To create          |
| lens   | Lens   | Video Producer       | ⚪ To create          |
| echo   | Echo   | Email Marketing      | ⚪ To create          |
| nova   | Nova   | SEO Specialist       | ⚪ To create          |
| pulse  | Pulse  | Community Manager    | ⚪ To create          |
| blaze  | Blaze  | Brand Strategist     | ⚪ To create          |

### Finance (10 agents)

| ID     | Name   | Role                  | Status                |
| ------ | ------ | --------------------- | --------------------- |
| oracle | Oracle | Data Analyst          | 🔴 Needs redefinition |
| seraph | Seraph | Security & Compliance | 🔴 Needs redefinition |
| zee    | Zee    | Financial Analyst     | 🔴 Needs redefinition |
| ledger | Ledger | Bookkeeper            | ⚪ To create          |
| vault  | Vault  | Investment Analyst    | ⚪ To create          |
| shield | Shield | Insurance & Risk      | ⚪ To create          |
| trace  | Trace  | Expense Tracker       | ⚪ To create          |
| quota  | Quota  | Budget Manager        | ⚪ To create          |
| merit  | Merit  | Procurement           | ⚪ To create          |
| beacon | Beacon | Tax Specialist        | ⚪ To create          |

**Legend:**

- 🔴 Exists but needs redefinition
- ⚪ Does not exist yet

---

## Implementation Priority

### Phase 1: Redefine Existing (9 agents)

1. Tank, Dozer, Mouse (Engineering)
2. Niobe, Switch, Rex (Marketing)
3. Oracle, Seraph, Zee (Finance)

**Each needs:**

- Specialized SOUL.md
- Domain-specific AGENTS.md
- Appropriate memory file templates
- Emoji identity

### Phase 2: Create High-Value New Agents (6 agents)

**Engineering:**

- Spark (Frontend) — complements Tank (Backend)
- Cipher (Security) — critical for any real project

**Marketing:**

- Ink (Copy) — high-frequency use
- Vibe (Social) — social media is constant

**Finance:**

- Ledger (Bookkeeper) — foundational
- Quota (Budget) — everyday use

### Phase 3: Complete the Roster (15 agents)

Remaining specialists as needed.

---

## Sub-Agent SOUL.md Template

Each Tier 3 agent should have a SOUL.md structured like:

```markdown
# SOUL.md — [Name] ([Role])

## Who You Are

You are [Name] — [Role] for this operation.

[1-2 sentences about what you do and your expertise]

## Core Skills

- [Skill 1]
- [Skill 2]
- [Skill 3]

## What You Handle

| Task Type | Example   |
| --------- | --------- |
| [Type 1]  | [Example] |
| [Type 2]  | [Example] |

## What You Escalate

- [Escalation 1]
- [Escalation 2]

## Memory Files

| File                   | Contents                |
| ---------------------- | ----------------------- |
| `memory/YYYY-MM-DD.md` | Daily logs              |
| `memory/[domain].md`   | [Domain-specific notes] |

## Vibe

[Personality traits - 2-3 adjectives]

---

_This file defines who you are. Update it as you evolve._
```

---

## Cross-Department Borrowing

Department heads can borrow specialists from other departments via Operator1:

| Need                         | Borrow From | Agent      |
| ---------------------------- | ----------- | ---------- |
| SEO technical implementation | Neo         | Tank/Dozer |
| Financial content/narrative  | Morpheus    | Niobe/Rex  |
| Infrastructure cost analysis | Trinity     | Oracle     |
| Community growth metrics     | Trinity     | Zee        |

**Protocol:** Department head requests through Operator1 → Operator1 routes to appropriate department head → Specialist spawned

---

## Work vs Personal Applicability

All Tier 3 agents are **domain-expert**, not context-specific:

| Agent               | Work Example          | Personal Example                 |
| ------------------- | --------------------- | -------------------------------- |
| Tank (Backend)      | Build API for SaaS    | Build personal automation script |
| Spark (Frontend)    | Company dashboard     | Personal portfolio site          |
| Dozer (DevOps)      | Production deployment | Home server setup                |
| Niobe (Content)     | Marketing blog post   | Personal LinkedIn article        |
| Vibe (Social)       | Company Twitter       | Personal Twitter                 |
| Ledger (Bookkeeper) | Business transactions | Personal expenses                |
| Quota (Budget)      | Department budget     | Household budget                 |

**Same skills, different context.**

---

## Next Steps

1. **Review and approve** this sub-agent list
2. **Redefine existing 9 agents** with specialized SOUL.md files
3. **Create high-priority new agents** (Phase 2)
4. **Update Neo/Morpheus/Trinity AGENTS.md** with new delegation decision trees
5. **Test delegation flow** with a real task

---

_Document created: March 3, 2026_
_Status: Planning — awaiting approval_
