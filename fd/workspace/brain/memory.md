# Agent Memory Architecture

How the agent uses memory across different time horizons.

---

## Memory Layers

### Layer 1 — Immediate (per-request)

- Scope: Single prompt → response cycle
- Storage: In-memory (Python objects)
- Duration: Discarded after response
- Purpose: Current intent, context packet, action plan

### Layer 2 — Conversational (per-session)

- Scope: Multi-turn conversation within a channel
- Storage: `prompt_engine/memory.py` ConversationStore
- Duration: Sliding window of 20 turns
- Purpose: "Do the same thing for CUTMV" — referencing earlier turns

### Layer 3 — Working (per-week)

- Scope: Current priorities and active context
- Storage: `bank/active-context.md`
- Duration: Updated weekly or on major changes
- Purpose: What matters right now, blockers, pending decisions

### Layer 4 — Durable (persistent)

- Scope: Permanent knowledge, patterns, decisions
- Storage: `memory/` directory (Markdown files)
- Duration: Indefinite (pruned quarterly)
- Purpose: Client preferences, learned patterns, standing instructions

### Layer 5 — Entity (stable profiles)

- Scope: Structured facts about brands, clients, products
- Storage: `bank/entities/` directory
- Duration: Updated on significant changes
- Purpose: Ground truth about Full Digital, CUTMV, clients

---

## Memory Update Triggers

The agent should update memory when:

| Trigger | Target file |
|---------|-------------|
| DA gives a standing instruction | `memory/memory.md` |
| A new client is onboarded | `memory/clients.md` |
| A project starts or completes | `memory/projects.md` |
| A strategy is validated or invalidated | `bank/opinions.md` |
| Priorities change | `bank/active-context.md` |
| CUTMV product changes | `memory/cutmv.md` |
| A reusable pattern is discovered | `memory/memory.md` |
| The agent makes a mistake | `memory/memory.md` (Corrections table) |

---

## Memory Retrieval

When processing a prompt, the context builder pulls:

1. Brand-relevant notes from `memory/`
2. Workflow-relevant notes from `bank/`
3. Active context from `bank/active-context.md`
4. Conversation history from the ConversationStore

Results are assembled into a `ContextPacket` and passed to the planner.
