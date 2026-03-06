---
summary: "Clarity Layer roadmap notes"
draft: true
---

# Official Docs vs Install Safeguard Issue -- Gap Analysis (2026-03-05)

## Snapshot

| Structural topic                         | What the official docs currently say                                                                                                                                       | Coverage gaps vs our installation safeguard proposal                                                                                                                                                              | Evidence refs                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Subagent auth isolation**              | `help/faq.md` explains that each agent stores its own `auth-profiles.json` and suggests copying the file from the main agent when `No API key found for provider` appears. | Guidance is reactive and buried in FAQ. No proactive checklist, no mention of hash-compare or auto-sync expectations, and nothing inside the install/onboarding docs.                                             | `/app/docs/help/faq.md` lines 2288-2335.                                                              |
| **Docker path shadowing**                | `install/docker.md` mentions (once, near the "Manual flow" section) that `docker compose` must run from the repo root.                                                     | Callout appears after dozens of sections; installers and quick-start steps never warn about repo vs `~/.openclaw`. No guard snippet or troubleshooting pointer, so operators still run compose from the data dir. | `/app/docs/install/docker.md` ("Manual flow" note).                                                   |
| **Config hot-reload suicide**            | No mention of linting/rollback safeguards for `openclaw.json`. Troubleshooting pages do not cover `gateway restarting` loops triggered by schema errors.                   | Entirely undocumented: no dry-run recommendation, no mention of backups, no reference to `config guard` workflows. This is the largest gap we highlight in the issue.                                             | No matches for `"config lint"`, `"openclaw.json" lint`, or `"gateway restarting"` across `/app/docs`. |
| **Global Compass / platform pre-flight** | Official install docs list high-level requirements (Node, Docker) but lack platform-specific pre-flight checklists (Rosetta, Full Disk Access, WSL placement).             | Our issue asks for structured pre-flight (Global Compass) and platform runbooks; nothing equivalent exists today.                                                                                                 | `/app/docs/install/*.md`, `/app/docs/start/*.md` -- no platform-specific checklist sections.          |
| **Status Decoder / log meaning**         | Status/health references are scattered (e.g., Docker health check). No consolidated "Status Playbook" explaining `gateway restarting`, `token mismatch`, etc.              | Issue proposes surfacing log decoder + health graph; official docs don't have a one-glance chart operators can follow.                                                                                            | `/app/docs/debug`, `/app/docs/help/faq.md` -- no dedicated status table.                              |

## Deep dives

### 1. Subagent auth isolation

- **Official stance:** In `help/faq.md` (see `/app/docs/help/faq.md` lines 2288-2335) the FAQ states: "Auth is per-agent ... stored in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` ... copy `auth-profiles.json` from the main agent's `agentDir` into the new agent's `agentDir`."
- **Gaps vs issue:**
  - Advice only surfaces after a failure string (`No API key found...`). Nothing in install/onboarding warns operators that every subagent needs explicit auth sync.
  - No automation expectations: official docs normalize manual copying rather than endorsing a hash-sync or symlink workflow.
  - The FAQ section is deeply nested; new users following install docs won't see it.
- **Implication for issue:** Our GitHub issue should contrast this reactive FAQ guidance with the proposed Credential Auto-Sync protocol + documentation callouts in install/platform pages.

### 2. Docker path shadowing

- **Official stance:** `install/docker.md` -> "Manual flow (compose)" includes a single sentence: "Note: run `docker compose ...` from the repo root."
- **Gaps vs issue:**
  - Quick-start (`./docker-setup.sh`) never reiterates repo/data split.
  - Troubleshooting sections do not mention the "ghost path" failure we logged (running compose inside `~/.openclaw`).
  - No CLI guardrails, no sanity snippet to prevent the mistake.
- **Implication for issue:** We can argue that the existing note is insufficient (buried after 150+ lines) and propose the Execution Path Integrity protocol + doc-side guard snippet.

### 3. Config hot-reload suicide

- **Official stance:** No doc references to linting `openclaw.json`, dry-run workflows, or backup expectations. Searching `/app/docs` for `"config lint"`, `"openclaw.json" lint`, or `gateway restarting` returns no hits.
- **Gaps vs issue:**
  - Users receive no warning that editing `openclaw.json` can brick the gateway.
  - No instructions for keeping backups or rolling back.
  - Health/troubleshooting pages never map `gateway restarting` loops to schema errors.
- **Implication for issue:** Highlights a complete doc omission, strengthening the argument for shipping Safe-Reload protocol guidance now.

### 4. Global Compass (platform pre-flight)

- **Official stance:** The Docker page lists generic requirements (Docker Compose, 2 GB RAM). Platform-specific pre-flight tasks (Rosetta, WSL path placement, Full Disk Access) are absent.
- **Gaps vs issue:**
  - Apple Silicon steps such as installing Rosetta or granting disk access are not mentioned.
  - WSL instructions don't warn against running inside `/mnt/c`.
  - No single page consolidates the pre-flight checklists operators keep recreating.
- **Implication:** Our "Global Compass" module is net-new content.

### 5. Status Playbook / health decoder

- **Official stance:** Health endpoints (`/healthz`, `/readyz`) are documented, but there's no operator-facing table translating repeating log phrases (`token mismatch`, `gateway restarting`, etc.).
- **Gaps vs issue:**
  - Troubleshooting relies on ad-hoc `openclaw doctor` suggestions.
  - No layered status graph for Docker -> gateway -> auth -> sandbox.
- **Implication:** Documenting the visual health dashboard/status decoder is additive and non-conflicting.

## Recommended positioning for the Issue/PR

1. **Cite the official references above** to show we did our homework (e.g., "Existing docs only mention subagent auth copy under FAQ (link), which is reactive...").
2. **Highlight placement gaps** (FAQ vs install, single buried sentence vs quick-start) to justify why a documentation PR -- not just code -- is necessary.
3. **Call out outright omissions** (`gateway restarting`, config lint) where no official guidance exists today.

_This analysis can be pasted into the PR conversation or the GitHub issue comments to prove we're building on top of current docs rather than duplicating them._
