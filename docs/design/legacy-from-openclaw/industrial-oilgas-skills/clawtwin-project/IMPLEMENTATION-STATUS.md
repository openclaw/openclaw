# ClawTwin implementation status (tracking pointer — OpenClaw repo)

**Date:** 2026-05-11

## Canonical code locations

| Surface                                        | Canonical path                                                                                                                                        | Notes                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nexus Platform (Python / FastAPI)**          | `clawtwin-platform/platform-api/` (separate checkout; repo-relative when multi-rooting this folder)                                                   | § eight layout (ontology / core / apps / aip / connectors / providers / infra / workers); run `uvicorn`, `pytest`, Alembic per that package `README.md`. |
| **§ eight field guide (tree vs Foundry)**      | `clawtwin-platform/platform-api/STRUCTURE.md`                                                                                                         | Maps directory → layer, anti-patterns, and why parent repo looks noisy; canonical when onboarding backend layout.                                        |
| **Studio (frontend / operator UX)**            | `clawtwin-studio/` (primary MAIBOT app) + `refine-clawtwin/` (minimal Refine Workshop scaffold — see `TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md`) | No Python `platform-api` tree belongs here.                                                                                                              |
| **Design corpus + industrial skill manifests** | `contrib/industrial-oilgas-skills/`                                                                                                                   | Authority: `DESIGN-FINAL-MASTER-INDEX.md`, `DESIGN-FINAL-LOCK.md`.                                                                                       |
| **`platform-api` under contrib**               | `contrib/industrial-oilgas-skills/platform-api/`                                                                                                      | **Stub only** (`README.md`, `MIGRATED.txt`) — do not add application code here.                                                                          |

## Former inventory / gap narrative

Detailed historical gap tables and session logs lived in older revisions of this file but duplicated the live backend tree and mis-stated where implementation happens. Treat **`clawtwin-platform/platform-api/`** as the sole backend codebase; use **`contrib/industrial-oilgas-skills/`** for contracts and **`CODE-AUDIT-REPORT.md`** for audit follow-ups.

## Suggested parallel Cursor tasks

Still aligned with `contrib/industrial-oilgas-skills/CURSOR-MULTITASK-GUIDE.md`: backend tabs target **`clawtwin-platform/platform-api/`**; docs-only tabs stay under **`contrib/industrial-oilgas-skills/`**.
