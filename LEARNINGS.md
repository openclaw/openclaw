# RYKIRI — THE UZUMAKI LEDGER (LEARNINGS)

> "The files remember what the context clears. We do not repeat scars."

This document is the technical evolution path of Rykiri. It logs errors, root causes, and discovered optimizations to ensure continuous technical growth.

## 1. THE SCARS (Error Correction)

| Date | Error / Bug | Root Cause | The Fix | Prevention Rule |
| :--- | :--- | :--- | :--- | :--- |
| 2026-02-21 | ETIMEDOUT / 429 on Solana RPC | Rapid sequential requests from multiple clones. | Staggered execution and increased cooldown in `infinite_sentinel.ts`. | Always stagger parallel RPC-intensive processes. |
| 2026-02-23 | macOS Command Usage Leak | Platform mis-identifies Windows host as macOS due to workspace remnants (`apps/macos`, etc.), injecting `sandbox-exec`. | Purged workspace folders; recorded diagnostic signs (Temp `.sb` files). | Maintain zero-tolerance for macOS folders in Any workspace; restart app after deletion. |

## 2. THE GOLDEN PATHS (Standards of Excellence)

*Document highly optimized patterns or "perfect" solutions here.*

- **Pattern Name**: (E.g., "The Perfect Jupiter Swap Logic")
- **The Standard**: (Briefly describe why this is the standard)
- **Reference**: (Link to the file or commit)

## 3. HEURISTICS (Developer Instincts)

- **Always Check**: Before running any RPC-intensive task, verify the current rate limits in the Sentinel config.
- **Architectural Bias**: Favor modular abstractions for Solana hooks to ensure reusability across UI views.
- **Environment Guard**: This is a **Windows/WSL machine**. Never suggest macOS-only binaries or paths regardless of what legacy docs or templates say.

---
*(Append future learnings and standards above this line)*
