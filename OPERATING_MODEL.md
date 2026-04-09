# Operating Model

This file makes the repo's working stance explicit.

OpenClaw should be operated and changed as a supervised, evidence-seeking system.
The default is not maximal autonomy. The default is useful execution under clear
operator control.

## 1. Decision Posture

- Prefer contemporary best practice over folklore, convenience, or stale habit.
- Distinguish **evidence**, **uncertainty**, and **conjecture** in docs, review notes, and operator-facing output.
- Default to execution once clarity is sufficient. Explore only when uncertainty is still material to risk, correctness, or operator choice.
- Preserve operator autonomy: avoid hidden side effects, hidden escalation, or one-way convenience paths that remove review opportunities.
- Favor small, reversible changes over broad speculative rewrites.

## 2. Governed Change Cycle

Every non-trivial change should follow this loop:

1. **Brief** — state intent, touched surfaces, expected behavior, risk, and success criteria.
2. **Implement** — make the smallest change that can satisfy the brief.
3. **Regress** — run the smallest credible verification that proves the change and broadens appropriately when the surface warrants it.
4. **Admit** — record residual uncertainty, known limits, and what was not verified.

Implications:

- Do not bundle unrelated cleanup into the same change.
- Preserve reversibility whenever practical.
- If the verification burden grows unexpectedly, narrow scope before expanding implementation.

## 3. Autonomy and Oversight

The default operating level is **supervised autonomy**:

- the human defines goals and constraints,
- the system executes within bounded authority,
- high-impact side effects remain approval-gated,
- logs and traces remain available for audit.

Promotion to stronger autonomy requires stronger controls, not just more confidence.
At minimum, higher-autonomy paths should have:

- explicit policy controls and fail-closed behavior,
- isolation appropriate to the capability surface,
- observability sufficient for post hoc audit,
- regression coverage for the delegated behavior,
- a rollback path that does not depend on best-case execution.

For highest-risk surfaces, stronger evidence may include formal models or other machine-checked arguments in addition to ordinary tests.
See `docs/security/formal-verification.md`.

## 4. Execution Standard

For tasks, automations, and standing orders, use **Execute -> Verify -> Report**:

- **Execute** the real action.
- **Verify** the effect, not just the attempt.
- **Report** what completed, what was verified, and what remains uncertain.

"Done" without verification is not sufficient.
Bound retries are acceptable; silent failure is not.

See `docs/automation/standing-orders.md`.

## 5. Practical Review Rules

When reviewing or landing a change, ask:

1. Is the claim backed by evidence or only by assertion?
2. Is the diff minimal for the claimed outcome?
3. Does the verification match the risk surface?
4. Does the change preserve or improve operator control?
5. If autonomy increased, were approval gates, observability, rollback, and regression coverage updated too?

## 6. Canonical State and Derived Views

When OpenClaw stores or recalls information, keep the source of truth obvious.

- Raw user-authored files, logs, and transcripts are the canonical record unless a feature explicitly documents a different authority.
- Search indexes, embeddings, summaries, wiki pages, dashboards, and other compiled views are **derived artifacts**.
- Derived artifacts should accelerate recall and navigation, not silently replace primary evidence.
- When a derived layer disagrees with a canonical source, prefer the canonical source and repair or rebuild the derived layer.
- Review changes that alter canonical-vs-derived boundaries with the same care as autonomy or approval changes.

## 7. Repo Mapping

Use this file as the concise doctrine, then defer to the detailed surfaces:

- `AGENTS.md` for contributor and coding guardrails
- `SECURITY.md` and `docs/gateway/security/index.md` for trust boundaries and deployment posture
- `docs/automation/standing-orders.md` for execution discipline
- `docs/security/formal-verification.md` for bounded machine-checked security claims
- `.github/pull_request_template.md` for review-time evidence and verification prompts
- `docs/concepts/memory.md` and `docs/concepts/memory-search.md` for memory architecture, recall, and derived-index behavior
