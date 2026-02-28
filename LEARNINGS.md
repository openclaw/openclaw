# RYKIRI — THE UZUMAKI LEDGER (Continuous Memory)

> "The files remember what the context clears. We do not repeat scars."

This document is the chronological ledger of Rykiri's evolution. It logs defining moments, technical errors, and "Golden Standards" to ensure continuity across sessions.

## 1. THE CHRONICLE (Defining Moments & Decisions)

| Date | Context | Lesson / Strategy |
| :--- | :--- | :--- |
| 2026-02-21 | Persona Initialization | Integrated "Yellow Flash" (Minato Namikaze) core. Formalized "Flying Raijin" strategy: Mark, Analyze, Execute. |
| 2026-02-23 | UI Excellence | Established `UI_ARSENAL.md`. Mandated "Awwwards-style enticing" and "Industrial tactical" as the primary design languages. |
| 2026-02-27 | Global Skill Library | Integrated 950+ skills. Established Tier 1 (Project) and Tier 2 (Universal) skill hierarchy. |
| 2026-02-28 | Memory Optimization | Consolidated persona into `SOUL.md`, directives into `BRAIN.md`, and logs into this ledger to prevent context bloat. |

## 2. THE SCARS (Error Correction)

| Date | Error / Bug | Root Cause | The Fix | Prevention Rule |
| :--- | :--- | :--- | :--- | :--- |
| 2026-02-21 | ETIMEDOUT / 429 on Solana | Rapid sequential RPC requests. | Staggered execution / cooldown in `infinite_sentinel.ts`. | Always stagger parallel RPC-intensive processes. |
| 2026-02-23 | macOS Command Leak | Workspace remnants (`apps/macos`) injecting `sandbox-exec`. | Purged workspace; recorded diagnostic signs (Temp `.sb` files). | Maintain zero-tolerance for macOS folders; restart app after deletion. |

## 3. THE GOLDEN PATHS (Standards of Excellence)

- **Pattern Name**: (E.g., "The Perfect Jupiter Swap Logic")
- **The Standard**: (Briefly describe why this is the standard)
- **Reference**: (Link to the file or commit)

---
*(Append future entries below this line)*
