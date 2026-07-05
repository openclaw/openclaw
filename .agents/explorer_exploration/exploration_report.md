# OpenClaw Fleet Audit: Exploration & Data Gathering Report

**Date:** 2026-07-03  
**Status:** Completed  
**Author:** Explorer Subagent (`teamwork_preview_explorer`)  
**Workspace Path:** `/Users/jakeshrader/openclaw/.agents/explorer_exploration/exploration_report.md`

---

## 1. Executive Summary

This report presents the findings of the data gathering and analysis phase for the OpenClaw Fleet Audit. The audit focuses on the Tech Stack topology consisting of a Mac Mini (headless server and source of truth) and a MacBook (personal developer desk and remote operator node). Through local configuration files, backup databases, and the YouTube Knowledge Engine (YKE) grounding playbook, we analyzed the configuration drift, gaps, and refinement opportunities across 7 key domains.

Key discoveries include:

- Significant model routing differences where the MacBook acts as a remote GPU provider (`mlx-desk` and `mlx-desk-coder`) for the Mini.
- Four disabled cron jobs out of the 28 policy-managed cron jobs on the Mini.
- A clear separation of concerns under a "Director, not Doer" workflow doctrine derived from YKE.
- A comprehensive map of configuration drift, physical security trade-offs, and automation gaps.

---

## 2. YKE Grounding & Findings

Grounding findings are sourced from the local knowledge playbook (`AI_KNOWLEDGE_PLAYBOOK.md`) and the `memory-wiki/` directories, which represent syntheses of YKE transcripts. The following keywords and practices are documented and cited.

### 2.1 Agent Orchestration & Multi-Agent Systems

- **The "Director, Not Doer" Doctrine:** Humans set vision, taste, and judgment, while AI executes 80–92% of the tasks. This is the 10-80-10 rule (or the 92% rule) documented across leaders like Dan Martell, Alex Hormozi, and Sharran Srivatsaa ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1).
- **Workflow-based, Not Role-based Allocation:** Scaling operations requires decomposing a "job" into discrete tasks and assigning them to specialized agents rather than trying to replicate full human roles. This is Alex Hormozi's "Bring Your Own Agent" (BYOA) methodology ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1, §3).
- **Fleet Management like a Team:** Good judgment must be applied across many threads. Systems must capture "human taste" and feedback into closed loops (e.g. `MEMORY.md` and `IMPROVEMENT_LOG.json`) so agents self-improve. Airtable CEO Howie Liu describes this as managing a "virtual twin" fleet ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1, §3).
- **Anti-Sycophancy (Trusted Critic):** Agreeing with the user without well-reasoned pushback is a failure mode. Alignment and safety require agents to act as "trusted critics" that challenge weak premises, backed by Yoshua Bengio's research on agentic risk (sub-goal seeking, sycophancy) ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1, §3; [Autonomy Bounds](AUTONOMY_BOUNDS.md)).

### 2.2 AI Model Routing & Cost Optimization

- **Cost-Aware Routing:** Multi-agent routing should separate tasks by difficulty. Cheap tasks (like heartbeats, simple formatting, standup summaries) use cheap/local endpoints (local Ollama or Google Gemini 2.5 Flash Lite), while high-quality reasoning tasks route to Claude Sonnet 4.6 or the tunneled 26b Desk Agent. Frontier models like Claude Opus are restricted as "frontier escapes" and require manual authorization ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1; [Stack Topology](STACK_TOPOLOGY.md) §5).
- **Tool Tiering:** Dan Martell proposes S-tier tool assignments: Claude/Apex for building, and Grok for high-stakes decisions ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §3).
- **Wizard-of-Oz Prototyping:** Before automating any step, manually validate the task flow to ensure its ROI is positive and there is no "self-licking ice cream cone" effect where systems build systems with no outcome ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §3; [Steelman Business Thesis](STEELMAN-BUSINESS-THESIS-2026-06-21.md)).

### 2.3 Fleet Automation & Closed-Loop Grounding

- **Closed Information Loop as a Moat:** Proprietary data indexed into a queryable knowledge layer (e.g., `knowledge.db` + workspace docs) represents the competitive advantage for personal assistant fleets. This data grows with usage, creating an emergent, self-optimizing workspace ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1).
- **Constraint Shifts:** Box CEO Aaron Levy notes that as AI commoditizes code, the strategic constraint shifts to GTM, sales, and customer interaction. Thus, the fleet should be oriented toward solving these bottlenecks ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §3).

---

## 3. Local MacBook Configuration Inspection

The local MacBook tech stack files were inspected using simple command-line tools. Key files and their parameters are summarized below:

1.  **`DESK_MANIFEST.json`:**
    - **Project:** `openclaw-dev`
    - **Product:** OpenClaw gateway fork (`shrad3r/openclaw`)
    - **Workspace Path:** `/Users/jakeshrader/openclaw`
    - **Ports:** `18789` (Gateway)
    - **Fleet Lane:** `henri` (worker `henri`)
2.  **`workspace-paths.json`:**
    - Maps local repositories (`gravyworks-marketing`, `shraderworks-web`, `gravyworks-app`, `gravyworks-booking`, `openclaw-dev`, `youtube-knowledge-engine`, `aeo-agent-factory`).
    - Defines `sharedFiles` mapped in the `~/.openclaw/workspace/` folder.
    - Establishes `readPrecedence` priorities: `workspace-paths.json` → `nodeTopology` → `FLEET_NODE_LAYOUT.md` → `TASK_REGISTRY.json` → `FLEET_STATUS.json` → `JACOB_BRIEF.md`.
3.  **`docs/DESK_CONTEXT.md`:**
    - Details the MacBook operator setup.
    - Enforces GitHub push to `origin` (`shrad3r/openclaw`) and fetch-only to `upstream` (`openclaw/openclaw`).
    - Defines deploy flow: edit config in Cursor → run `deploy-desk-to-mini.sh`.
4.  **`openclaw.json.bak`:**
    - Defines local MacBook providers (`google`, `mlx` as Desk Agent `gemma-4-26b-4bit`, `mlx-coder` as Desk Coder `llama-3.1-8b-4bit`, `openrouter`).
    - Enforces `cron.enabled: false`.
    - Channels (Telegram) are disabled.

---

## 4. Mac Mini vs. MacBook Configuration Drift

By comparing the MacBook's local `openclaw.json.bak` with the Mac Mini's active config (retrieved via `/Users/jakeshrader/.openclaw/backups/mini-secrets/openclaw.json`), we identified the following configuration drift:

| Configuration Key          | MacBook Profile (`openclaw.json.bak`)     | Mac Mini Profile (`backups/mini-secrets/openclaw.json`) | Intent / Rationale                                        |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `cron.enabled`             | `false`                                   | `true`                                                  | The Mini is the always-on server running automated crons. |
| `cron.maxConcurrentRuns`   | _(Not set)_                               | `1`                                                     | Prevents MLX server resource exhaustion.                  |
| `telegram.enabled`         | `false`                                   | `true`                                                  | Ingress is Mini-only to prevent split-brain gateways.     |
| `telegram.dmPolicy`        | _(Not set)_                               | `"allowlist"`                                           | Hardened security restriction.                            |
| `telegram.allowFrom`       | _(Not set)_                               | `[6113773579]`                                          | Gated to Jacob's Telegram ID only.                        |
| `telegram.botToken`        | _(Not set)_                               | `"source": "file", "id": "/channels/telegram/botToken"` | Gated secret token.                                       |
| `modelByChannel.telegram`  | `"google/gemini-2.5-flash-lite"`          | `"mlx-desk/gemma-4-26b-4bit"`                           | Mini routes to MacBook's 26b Desk Agent when online.      |
| `modelByChannel.imessage`  | `"google/gemini-2.5-flash-lite"`          | `"mlx-desk/gemma-4-26b-4bit"`                           | Mini routes to MacBook's 26b Desk Agent when online.      |
| `modelByChannel.webchat`   | `"google/gemini-2.5-flash-lite"`          | `"mlx-desk/gemma-4-26b-4bit"`                           | Mini routes to MacBook's 26b Desk Agent when online.      |
| Provider: `mlx`            | `gemma-4-26b-4bit` (Desk Agent, `:8000`)  | `gemma-4-12b-4bit` (Local Fleet, `:8000`)               | Mini uses 12b model locally; MacBook runs 26b model.      |
| Provider: `mlx-coder`      | `llama-3.1-8b-4bit` (Desk Coder, `:8002`) | `llama-3.1-8b-4bit` (Local Coder, `:8002`)              | Local coder models on both.                               |
| Provider: `mlx-desk`       | _(Not set)_                               | `gemma-4-26b-4bit` (Desk Agent, `:8001`)                | Mini's hook into MacBook's reverse SSH tunnel.            |
| Provider: `mlx-desk-coder` | _(Not set)_                               | `llama-3.1-8b-4bit` (Desk Coder, `:8003`)               | Mini's hook into MacBook's coder SSH tunnel.              |

---

## 5. Synced Cron Jobs Audit

The Mini gateway's cron configuration is governed by `apply-openclaw-policy.py`. Out of the 28 synced cron jobs defined, **4 are explicitly disabled**.

### 5.1 Stagger Expressions (`CRON_STAGGER_EXPR`)

Cron jobs that spawn agents or execute models are staggered to prevent resource collision on the MLX servers (model lock duration default is 540 seconds).

- `delegation_pulse`: `"2,12,22,32,42,52 * * * *"`
- `ideation_pulse`: `"11,31,51 * * * *"`
- `ideation_promote`: `"4,24,44 * * * *"`
- `advisor_ideation`: `"20,50 8-22 * * *"`
- `council_ideation_pulse`: `"29,59 20-23,0-2 * * *"`
- `council_ideation_promote`: `"6,36 20-23,0-2 * * *"`
- `queue_continuity`: `"1,16,31,46 * * * *"`
- `fleet_health`: `"24 * * * *"`
- `cursor_pipeline`: `"3,23,43 * * * *"`
- `post_merge_smoke`: `"8,38 * * * *"`
- `desk_handoff`: `"1,6,11,16,21,26,31,36,41,46,51,56 * * * *"`

### 5.2 Complete Cron Job Inventory

1.  **`jacob-daily-brief` (Enabled):** 07:00 ET daily. Calls `fleet-cli.py jacob-daily-brief`.
2.  **`jacob-roi-task-picks` (Enabled):** 07:35 ET daily. Picks 3–5 ROI-ranked next tasks from `TASK_REGISTRY.json`.
3.  **`kai-standup-morning` (Enabled):** 08:05 ET daily. Sends morning standup summary to Jacob Telegram DM.
4.  **`kai-standup-midday` (Enabled):** 13:05 ET daily. Sends midday standup summary.
5.  **`kai-standup-evening` (Enabled):** 20:05 ET daily. Sends evening standup summary.
6.  **`kai-delegation-pulse` (Enabled):** Every 10m (staggered). Reconciles and spawns up to 2 worker agents for tasks.
7.  **`kai-ideation-pulse` (Enabled):** Every 30m (staggered). Gated spawn of one domain worker.
8.  **`kai-ideation-promote` (Enabled):** Hourly (staggered). Promotes the top L1 proposed task when the owner is idle.
9.  **`kai-advisor-ideation-pulse` (Disabled):** _Disabled 2026-07-03._ Stated reason: Overlap with `kai-ideation-pulse` clone rotation.
10. **`kai-council-ideation-pulse` (Disabled):** _Disabled 2026-07-03._ Stated reason: Overlap with council-promote evening window.
11. **`kai-council-ideation-promote` (Enabled):** Evening `:06/:36` ET. Promotes up to 2 idle-owner proposals.
12. **`kai-midday-council-ideation` (Disabled):** _Disabled 2026-07-03._ Stated reason: Overlap with fleet ideation + council-promote.
13. **`jacob-business-loop-digest` (Enabled):** 07:40 ET daily. Sends the six-stage business loop digest to Telegram.
14. **`kai-queue-continuity` (Enabled):** Every 15m (staggered). Repairs verified tasks, requeues blocked L1s.
15. **`kai-fleet-health-check` (Enabled):** Hourly `:24`. Run `fleet-resilience-watch.sh` + `fleet-cli.py reconcile`. Alerts on Telegram if flapping.
16. **`kai-queue-hygiene` (Enabled):** Sun 06:00 ET. Reconciles and blocks stale pending tasks older than 7 days.
17. **`kai-overnight-cursor` (Enabled):** 02:00 ET nightly. Runs `fleet-cli.py cursor-pipeline-tick` (deterministic dispatch, no LLM).
18. **`kai-desk-handoff-reconcile` (Enabled):** Every 5m. Processes Cursor desk handoff JSON pending queue.
19. **`kai-cursor-pr-reconcile` (Disabled):** _Disabled._ Deprecated alias. Uses `kai-cursor-pipeline-tick` instead.
20. **`kai-cursor-pipeline-tick` (Enabled):** Every 20m. Reconciles PRs, feeds cursor queue, dispatches if capacity.
21. **`kai-post-merge-smoke` (Enabled):** Every 30m. Post-merge smoke tests on product repos (deterministic shell).
22. **`weekly-lead-flow-full` (Enabled):** Sun 06:00 ET. Runs full validation of GravyWorks booking and lead-flow.
23. **`scout-weekly-intel` (Enabled):** Monday 09:05 ET. Weekly intel search and research using Gemini.
24. **`scout-daily-intel-health` (Enabled):** Daily 08:05 ET. Daily archive health scan.
25. **`api-spend-monitor` (Enabled):** 08:00 ET daily. Reconciles AI spending; alerts on Telegram if over budget.
26. **`gravyworks-lead-flow-health` (Enabled):** Daily 09:00 ET. Runs `run-gravyworks-lead-flow-health.sh`.
27. **`kai-vault-consolidation` (Enabled):** Daily 23:30 ET. Scans wiki/MOC differences and compiles nightly.
28. **`kai-workspace-hygiene` (Enabled):** Sun 06:30 ET. Runs deterministic `workspace-hygiene-check.sh` maintenance.

---

## 6. Seven-Domain Analysis: Drift, Gaps, and Refinement Opportunities

### 6.1 Agent Ops

- **Drift:** The MacBook's `openclaw.json` has all agent execution engines turned off to prevent local processes from fighting the Mini's gateway. Agent states and database file backups are copied to the MacBook only as a read-only mirror (`/Users/jakeshrader/.openclaw/backups/mini-secrets/`).
- **Gaps:** Local simulation is difficult. There is no automated local testing capability for complex agent-run sequences (e.g. debugging Kai's `CORE_LOOP` delegation) without risking writing to the Mini's task registry.
- **Refinement Opportunities:** Introduce a mock gateway execution mode in `apply-openclaw-policy.py` that maps `openclaw.sqlite` and agent sqlite databases to a sandboxed local copy for safe MacBook testing.

### 6.2 Model Routing

- **Drift:** On the MacBook, model default bindings point directly to Google Flash Lite, whereas the Mini bindings default to the reverse SSH tunneled MacBook model (`mlx-desk`).
- **Gaps:** If the MacBook is asleep/offline and the SSH reverse tunnel port 8001 is closed, the Mini will fail-closed when routing ingress traffic (Telegram/iMessage) unless a cloud fallback triggers. While `reconcile_desk_fallback_sessions` clears fallback sticks when the desk returns, it does not prevent immediate failure during active ingress.
- **Refinement Opportunities:** Implement a dynamic model routing check in the gateway's model selector. If the `mlx-desk` socket fails to connect on `127.0.0.1:8001` within a 2-second timeout, the gateway should automatically degrade to the Mini's local `gemma-4-12b-4bit` (`mlx`) or `gemini-2.5-flash-lite` (`google`), rather than failing closed.

### 6.3 YKE Grounding

- **Drift:** Grounding transcripts are processed solely on the Mini using Local Embeddings (`gemini-embedding-2-preview`). The MacBook has the `youtube-knowledge` MCP server configured, but it depends on the SSH tunnel to access the Mini's local endpoint.
- **Gaps:** When working offline on the MacBook, the lack of local vector databases or knowledge indexes isolates Cursor from YKE grounding.
- **Refinement Opportunities:** Mirror the SQLite `knowledge.db` to the MacBook via an automated rsync in `deploy-desk-to-mini.sh`. Allow Cursor's local `youtube-knowledge` MCP to fall back to a local read-only SQlite reader.

### 6.4 Fleet Tooling

- **Drift:** Mini uses `fleet-cli.py` directly; MacBook routes through `fleet-cli-desk.sh` which wraps SSH and executes commands on the Mini.
- **Gaps:** `fleet-cli-desk.sh` assumes constant connection. If the tunnel drops, task status edits fail and are lost, forcing the user into `OFFLINE_CURSOR_HANDOFF.md` manual writing.
- **Refinement Opportunities:** Upgrade `fleet-cli-desk.sh` to write to a local pending JSON queue (e.g., `~/.openclaw/desk-handoffs/pending/`) if the Mini is unreachable, which the `kai-desk-handoff-reconcile` job can auto-process once connection is restored.

### 6.5 Security Posture

- **Drift:** Physical security risks are concentrated on the Mini (FileVault off, Auto-login). This is mitigated by locking it in a secure room and gating commands with `exec-approvals.json` and a Telegram allowlist.
- **Gaps:** Plaintext secrets remain decrypted in `vault.json` on the Mini's disk while the gateway is running. If the Mini is stolen or accessed physically, these secrets are exposed.
- **Refinement Opportunities:** Automate `vault-age-seal.sh` in the gateway shutdown hooks. Restrict Tailscale ACLs so the gateway port `18789` is bind-locked to loopback (`127.0.0.1`) and Tailscale-only interfaces, blocking general LAN requests.

### 6.6 Cron / Automation

- **Drift:** All crons run on the Mini; MacBook has crons disabled.
- **Gaps:** Out of the 28 jobs, 4 are disabled. There are duplicate logic loops: `kai-advisor-ideation-pulse` and `kai-council-ideation-pulse` were disabled because they overlapped with new clone rotations, but the dead configuration lines remain in `apply-openclaw-policy.py`.
- **Refinement Opportunities:** Prune the 4 disabled and deprecated jobs from the python source script. Implement a retry threshold for command crons that fail (e.g. `weekly-lead-flow-full`), rather than waiting 7 days for the next run.

### 6.7 OpenClaw Product Integration

- **Drift:** Product codebases on MacBook are pushed to GitHub, then manually pulled on the Mac Mini. Fleet policies are pushed and applied via `deploy-desk-to-mini.sh`.
- **Gaps:** The manual pull step on the Mini (`ssh mac-mini 'git pull'`) introduces developer friction. There is no automated continuous deployment (CD) on the Mini to catch changes merged to the `main` branch of `shrad3r/openclaw`.
- **Refinement Opportunities:** Introduce a webhook listener on the Mini gateway (or a lightweight cron job running every 10m) that runs `git fetch && git merge --ff-only` on the `openclaw-dev` directory if tests pass, automating the update loop.

---

## 7. YKE Playbook Citations & References

- **Martell, Dan:** "Director, not doer" (10-80-10 rule) and Grok/Claude tool tiering. Sourced from SVG Leader Roundtable ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1, §3).
- **Hormozi, Alex:** "Bring Your Own Agent" (BYOA) and the Value Equation ($dream \div (time \times effort \times risk)$). Sourced from Scaling Zero transcripts ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1, §3).
- **Liu, Howie (Airtable):** "Fleet of agents managed like a team" and virtual twins. Sourced from SVG Interview transcripts ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §3).
- **Levy, Aaron (Box):** "Constraint shifts to GTM and customer interaction." Sourced from SVG Interview transcripts ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §3).
- **Bengio, Yoshua:** "Agentic risk, alignment, and sub-goal seeking." Sourced from alignment guidelines ([AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §3).
