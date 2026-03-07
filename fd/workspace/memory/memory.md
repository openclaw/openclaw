# Core Memory

This is OpenClaw's durable memory. Information recorded here persists
across sessions and informs future decisions.

---

## How Memory Works

1. **Short-term** — Conversation history within a session (managed by
   `prompt_engine/memory.py`, sliding window of 20 turns).
2. **Working memory** — `bank/active-context.md` for what matters this week.
3. **Long-term** — This file and the memory/ directory for persistent facts.

The agent should update memory when:

- A new client is onboarded
- A project reaches a milestone
- A strategy is validated or invalidated
- A reusable pattern is discovered
- DA shares a preference or standing instruction

---

## Standing Instructions from DA

<!-- Add DA's standing instructions here as they are given -->

- Default brand context: Full Digital unless otherwise specified
- Prefer local inference (Ollama) over cloud
- Always show plan previews before executing medium/high risk actions
- Weekly review every Monday morning

---

## Learned Patterns

<!-- The agent records reusable patterns here -->

---

## Key Decisions Log

<!-- Record significant decisions and their rationale -->

| Date | Decision | Rationale | Outcome |
|------|----------|-----------|---------|
| | | | |

---

## Corrections

<!-- When the agent makes a mistake and DA corrects it, record here -->

| Date | What happened | Correction | Applied |
|------|--------------|------------|---------|
| | | | |
