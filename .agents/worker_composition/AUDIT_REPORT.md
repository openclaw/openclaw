# OpenClaw Fleet Setup Audit Report

**Date:** July 3, 2026  
**Status:** Final  
**Auditor:** OpenClaw Fleet Audit Team (`teamwork_preview_worker`)  
**Target Path:** `/Users/jakeshrader/openclaw/.agents/worker_composition/AUDIT_REPORT.md`

---

## Executive Summary

This audit report provides a comprehensive, structured evaluation of the OpenClaw Fleet Setup topology, security posture, configuration drift, and grounding mechanics. The fleet consists of a **Mac Mini** (acting as the headless server and canonical source of truth for database state and background automation) and a **MacBook** (serving as the personal developer desk and remote operator node).

### Key Findings

1. **Model Routing and Hardware Optimization:** A key design feature of the fleet is utilizing the MacBook's local GPU resources for heavier reasoning tasks via reverse SSH tunnels. The Mac Mini hosts a local `gemma-4-12b-4bit` model, while the MacBook hosts a larger `gemma-4-26b-4bit` Desk Agent model. When the MacBook is online, the Mini tunnels requests to it.
2. **Configuration Drift:** There is a well-reasoned but significant configuration drift between the two profiles. The MacBook disables crons and Telegram integrations to prevent split-brain execution, while the Mini is heavily restricted with strict IP binds, Telegram allowlists, and concurrency limits.
3. **Automation Staggering:** Out of 28 synced cron jobs, 4 are currently disabled or deprecated. The remaining 24 jobs are carefully staggered using cron expressions to avoid MLX model lock collision (which defaults to a 540-second timeout on local inference servers).
4. **Security Vulnerabilities:** The setup accepts physical security trade-offs (FileVault disabled and Auto-login enabled on the Mini to guarantee automated restart recovery) while relying on logical network access controls. However, secrets remain stored in plaintext in `vault.json` on disk during runtime, representing a clear escalation risk.

### Prime Opportunities

- **Dynamic Failover Routing:** Implementing automatic degradation from the tunneled MacBook model to local Mini models or Gemini Flash Lite when the MacBook is offline.
- **Offline Grounding Mirror:** Syncing the vector-grounded SQLite `knowledge.db` back to the MacBook for offline/local query capability via the `youtube-knowledge` MCP server.
- **Webhook CD Automation:** Replacing manual pull steps with automated git fast-forward listeners on the Mini to eliminate developer friction.

---

## Section 1: YKE Grounding & Principles

The OpenClaw fleet setup is heavily grounded in the business, organizational, and technological principles outlined in the **YouTube Knowledge Engine (YKE)** framework. The fleet’s division of labor, model selection, and control structures map directly to these doctrines:

### 1.1 "Director, Not Doer" (The 10-80-10 / 92% Rule)

The fleet operates under the assumption that humans must provide the vision, taste, and final evaluation (the first and last 10%), while autonomous agents execute the bulk of the workflow (80–92% of the tasks). This principle, synthesized from leaders like Dan Martell, Alex Hormozi, and Sharran Srivatsaa, ensures that human cognitive capacity is reserved for high-leverage decision points while agents manage operations in the background `[AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1`.

### 1.2 Bring Your Own Agent (BYOA)

Decomposing monolithic job descriptions into discrete, specialized workflows is critical. Rather than attempting to build a single "human replacement" AI, the fleet leverages specialized agent profiles (e.g., `kai-delegation`, `scout-weekly-intel`) assigned to micro-tasks `[AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1, §3`. This modularity minimizes prompt bloat, increases task-specific accuracy, and aligns with Alex Hormozi's workflow-based allocation framework.

### 1.3 Virtual Twin Management

As described by Airtable CEO Howie Liu, scaling operations is not about writing static scripts but managing a fleet of agents like an executive manages a team `[AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1, §3`. The fleet tracks agent behavior, records failures, and feeds learnings into closed feedback loops like `MEMORY.md` and `IMPROVEMENT_LOG.json` to allow continuous self-optimization and maintain alignment with the operator's preferences.

### 1.4 Anti-Sycophancy & Yoshua Bengio's Agentic Risk

Safety and alignment research by Yoshua Bengio highlights the risk of sub-goal seeking and sycophancy (agents agreeing with operators to avoid conflict) `[AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1, §3; [Autonomy Bounds](AUTONOMY_BOUNDS.md)`. OpenClaw implements a "Trusted Critic" norm: agents must challenge weak premises, analyze edge cases, and push back before agreeing with a user strategy. If an agent rubber-stamps a design without justification, it is treated as a process defect.

### 1.5 Levy's GTM Constraint Shift

Box CEO Aaron Levy notes that as LLMs commoditize code generation, the primary business bottleneck shifts from software development to GTM execution, lead flow, and customer interactions `[AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §3`. The fleet's cron architecture is heavily weighted toward business validations (e.g., `weekly-lead-flow-full`, `gravyworks-lead-flow-health`), ensuring the AI fleet guards and optimizes the business loops.

### 1.6 Cost-Aware Model Routing & Wizard-of-Oz Prototyping

- **Model Tiering:** Low-complexity background tasks (e.g., cron check-ins, formatting, basic logging) are routed to cheap local models or Google Gemini 2.5 Flash Lite `[AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1; [Stack Topology](STACK_TOPOLOGY.md) §5`. Reasoning-intensive, high-stakes tasks are promoted to Claude Sonnet 4.6 or the tunneled 26b Desk Agent. High-cost frontier models like Claude Opus are locked as "frontier escapes" and require manual authorization.
- **Wizard-of-Oz Prototyping:** Before automating any step, manually validate the task flow to ensure its ROI is positive and there is no "self-licking ice cream cone" effect where systems build systems with no outcome `[AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §3; [Steelman Business Thesis](STEELMAN-BUSINESS-THESIS-2026-06-21.md)`.

---

## Section 2: Configuration Analysis & Drift Map

To prevent split-brain issues, the local MacBook developer client profile (`openclaw.json.bak`) drifts systematically from the Mac Mini’s production server profile (`backups/mini-secrets/openclaw.json`).

The following drift map illustrates the configuration differences:

| Configuration Key          | MacBook Profile (`openclaw.json.bak`)     | Mac Mini Profile (`backups/mini-secrets/openclaw.json`) | Rationale / Intent                                                                                       |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `cron.enabled`             | `false`                                   | `true`                                                  | The Mini runs background automations 24/7. The MacBook disables crons to avoid duplicate cron execution. |
| `cron.maxConcurrentRuns`   | _(Not set)_                               | `1`                                                     | Strictly enforces single-threaded execution on the Mini to prevent resource exhaustion and GPU locking.  |
| `telegram.enabled`         | `false`                                   | `true`                                                  | Gates communication ingress to the Mini gateway to maintain a single chat session source of truth.       |
| `telegram.dmPolicy`        | _(Not set)_                               | `"allowlist"`                                           | Hardened security posture to prevent unauthorized interaction with the control gateway.                  |
| `telegram.allowFrom`       | _(Not set)_                               | `[6113773579]`                                          | Gated strictly to Jacob's verified Telegram User ID.                                                     |
| `telegram.botToken`        | _(Not set)_                               | `"source": "file", "id": "/channels/telegram/botToken"` | Gated secret token retrieved securely from the local credentials vault.                                  |
| `modelByChannel.telegram`  | `"google/gemini-2.5-flash-lite"`          | `"mlx-desk/gemma-4-26b-4bit"`                           | Mini routes conversational requests to the MacBook's larger 26b Desk Agent model via tunnel when online. |
| `modelByChannel.imessage`  | `"google/gemini-2.5-flash-lite"`          | `"mlx-desk/gemma-4-26b-4bit"`                           | Mini routes conversational requests to the MacBook's larger 26b Desk Agent model via tunnel when online. |
| `modelByChannel.webchat`   | `"google/gemini-2.5-flash-lite"`          | `"mlx-desk/gemma-4-26b-4bit"`                           | Mini routes conversational requests to the MacBook's larger 26b Desk Agent model via tunnel when online. |
| Provider: `mlx`            | `gemma-4-26b-4bit` (Desk Agent, `:8000`)  | `gemma-4-12b-4bit` (Local Fleet, `:8000`)               | MacBook runs the 26b model locally. Mini runs a lighter 12b model locally to preserve resource headroom. |
| Provider: `mlx-coder`      | `llama-3.1-8b-4bit` (Desk Coder, `:8002`) | `llama-3.1-8b-4bit` (Local Coder, `:8002`)              | Developer coding model hosted locally on respective nodes.                                               |
| Provider: `mlx-desk`       | _(Not set)_                               | `gemma-4-26b-4bit` (Desk Agent, `:8001`)                | Mini's hook into the reverse SSH tunnel. Routes queries to the MacBook's local 26b Desk Agent model.     |
| Provider: `mlx-desk-coder` | _(Not set)_                               | `llama-3.1-8b-4bit` (Desk Coder, `:8003`)               | Mini's hook into the reverse SSH tunnel. Routes queries to the MacBook's local 8b Coder model.           |

---

## Section 3: Synced Cron Jobs Audit

Automation on the Mac Mini is controlled via `apply-openclaw-policy.py`. Out of 28 synced cron jobs configured in the system policy, **24 are enabled** and **4 are disabled or deprecated**.

### 3.1 Stagger Expressions (`CRON_STAGGER_EXPR`)

To prevent simultaneous execution of LLM-backed tasks from overloading the local MLX servers, the policy employs strict minute-staggering. The local MLX server has a model lock duration default of **540 seconds (9 minutes)**. If multiple cron jobs invoke local inference concurrently, the model loader would hit lock contention, causing request timeouts.

Key stagger groups are mapped as:

- `delegation_pulse`: `"2,12,22,32,42,52 * * * *"` (Triggers delegation checks)
- `ideation_pulse`: `"11,31,51 * * * *"` (Triggers task ideation)
- `ideation_promote`: `"4,24,44 * * * *"` (Promotes task proposals)
- `advisor_ideation`: `"20,50 8-22 * * *"` (Runs advisor-council sweeps during day)
- `council_ideation_pulse`: `"29,59 20-23,0-2 * * *"` (Triggers evening council reviews)
- `council_ideation_promote`: `"6,36 20-23,0-2 * * *"` (Promotes council-approved tasks)
- `queue_continuity`: `"1,16,31,46 * * * *"` (Repairs hanging task threads)
- `fleet_health`: `"24 * * * *"` (Runs system and network health audits)
- `cursor_pipeline`: `"3,23,43 * * * *"` (Executes automated coding routines)
- `post_merge_smoke`: `"8,38 * * * *"` (Executes unit and integration tests post-merge)
- `desk_handoff`: `"1,6,11,16,21,26,31,36,41,46,51,56 * * * *"` (Checks for pending task handoffs)

### 3.2 Complete Cron Job Inventory

The full policy inventory consists of the following 28 cron jobs:

1. **`jacob-daily-brief` (Enabled):** 07:00 ET daily. Executes `fleet-cli.py jacob-daily-brief` to compile the daily agenda.
2. **`jacob-roi-task-picks` (Enabled):** 07:35 ET daily. Ranks tasks by ROI in `TASK_REGISTRY.json` and selects 3–5 high-priority picks.
3. **`kai-standup-morning` (Enabled):** 08:05 ET daily. Synthesizes active tasks and sends a morning standup summary to Jacob via Telegram DM.
4. **`kai-standup-midday` (Enabled):** 13:05 ET daily. Compiles a progress report and sends a midday standup summary.
5. **`kai-standup-evening` (Enabled):** 20:05 ET daily. Compiles a closing status report and sends an evening standup summary.
6. **`kai-delegation-pulse` (Enabled):** Every 10m (staggered). Reconciles and spawns up to 2 concurrent worker agents to execute pending tasks.
7. **`kai-ideation-pulse` (Enabled):** Every 30m (staggered). Evaluates workspace state and spawns a single domain worker if tasks are identified.
8. **`kai-ideation-promote` (Enabled):** Hourly (staggered). Automatically promotes the top-ranked L1 task proposal if the task owner is idle.
9. **`kai-advisor-ideation-pulse` (Disabled):** _Disabled 2026-07-03._ Stated reason: Redundant overlap with the main `kai-ideation-pulse` clone rotation loop.
10. **`kai-council-ideation-pulse` (Disabled):** _Disabled 2026-07-03._ Stated reason: Redundant overlap with the `council-promote` evening processing window.
11. **`kai-council-ideation-promote` (Enabled):** Daily between 20:00–02:00 at `:06/:36` minutes. Promotes up to 2 approved task proposals from the advisor council.
12. **`kai-midday-council-ideation` (Disabled):** _Disabled 2026-07-03._ Stated reason: Resource overlap with fleet ideation and existing council-promote tasks.
13. **`jacob-business-loop-digest` (Enabled):** 07:40 ET daily. Runs a six-stage business validation audit and broadcasts the results to Telegram.
14. **`kai-queue-continuity` (Enabled):** Every 15m (staggered). Audits active execution loops, auto-reconciles stuck states, and requeues failed L1s.
15. **`kai-fleet-health-check` (Enabled):** Hourly `:24`. Executes `fleet-resilience-watch.sh` and `fleet-cli.py reconcile`. Alerts via Telegram if any critical node flaps.
16. **`kai-queue-hygiene` (Enabled):** Sundays 06:00 ET. Audits tasks and automatically transitions pending tasks older than 7 days to `blocked`.
17. **`kai-overnight-cursor` (Enabled):** 02:00 ET nightly. Runs `fleet-cli.py cursor-pipeline-tick` (a deterministic, LLM-free dispatch check).
18. **`kai-desk-handoff-reconcile` (Enabled):** Every 5m. Scans the local pending folder and integrates incoming MacBook desk handoff JSONs.
19. **`kai-cursor-pr-reconcile` (Disabled):** _Disabled._ Deprecated alias replaced entirely by the active `kai-cursor-pipeline-tick` pipeline.
20. **`kai-cursor-pipeline-tick` (Enabled):** Every 20m. Syncs PR statuses, cleans queue pipelines, and dispatches edits if developer slot capacity exists.
21. **`kai-post-merge-smoke` (Enabled):** Every 30m (staggered). Deterministic shell script executing automated smoke tests on product repositories post-merge.
22. **`weekly-lead-flow-full` (Enabled):** Sundays 06:00 ET. Executes a full verification loop of GravyWorks booking pipelines and lead workflows.
23. **`scout-weekly-intel` (Enabled):** Mondays 09:05 ET. Executes broad web-intel extraction and formats a structured weekly brief using Gemini.
24. **`scout-daily-intel-health` (Enabled):** Daily 08:05 ET. Verifies index integrity and scans web archives to maintain synchronization.
25. **`api-spend-monitor` (Enabled):** 08:00 ET daily. Aggregates monthly API token expenditures and alerts on Telegram if budgets are breached.
26. **`gravyworks-lead-flow-health` (Enabled):** Daily 09:00 ET. Runs `run-gravyworks-lead-flow-health.sh` to check live APIs and database records.
27. **`kai-vault-consolidation` (Enabled):** Daily 23:30 ET. Scans personal wiki files, reconciles Map of Content (MOC) indexes, and compiles changes.
28. **`kai-workspace-hygiene` (Enabled):** Sundays 06:30 ET. Runs `workspace-hygiene-check.sh` to prune local caches and align tracking structures.

---

## Section 4: Seven-Domain Deep Dive

### 4.1 Agent Ops

- **Drift:** The MacBook's config disables agent execution entirely. Task registries and agent SQLite databases are synced unidirectionally from the Mini to the MacBook (`/Users/jakeshrader/.openclaw/backups/mini-secrets/`) for read-only inspections.
- **Gaps & Risks:** The lack of a local gateway execution environment prevents safe, offline testing of agent behavior (e.g., debugging the Kai `CORE_LOOP` delegation logic). Any local modification to the task registry risks polluting the production state on the Mini.
- **Refinement Opportunities:** Introduce a sandboxed mock gateway execution flag in `apply-openclaw-policy.py`. This would clone the production SQLite file to a temporary directory (`/Users/jakeshrader/openclaw/tmp/sandbox.sqlite`) for local dry-runs on the MacBook.

### 4.2 Model Routing

- **Drift:** MacBook binds model declarations directly to Google Gemini Flash Lite. The Mini binds conversational channels (Telegram/iMessage) to the reverse SSH tunneled Desk Agent (`mlx-desk/gemma-4-26b-4bit`) routed via Tailscale from the MacBook.
- **Gaps & Risks:** If the MacBook goes offline or sleep mode closes the reverse SSH tunnel (port 8001), the Mini fails closed on incoming client messages. While the system runs a reconciliation routine when the desk reconnects (`reconcile_desk_fallback_sessions`), it lacks dynamic, real-time fallbacks for active message streams.
- **Refinement Opportunities:** Implement a connection preflight check in the gateway’s model selector. If the socket connection to `127.0.0.1:8001` fails to establish within a 2-second timeout, the gateway should fall back to the Mini's local model (`mlx/gemma-4-12b-4bit`) or Gemini Flash Lite via API.

### 4.3 YKE Grounding

- **Drift:** Grounding embeddings and transcript vectorization are processed locally on the Mac Mini using `gemini-embedding-2-preview`. The MacBook’s `youtube-knowledge` MCP server relies on the active SSH tunnel to query the Mini’s local database.
- **Gaps & Risks:** Working offline on the MacBook isolates the developer from YKE grounding resources. Cursor cannot retrieve local workspace transcripts or index data when disconnected from the SSH tunnel.
- **Refinement Opportunities:** Mirror the SQLite `knowledge.db` file to the MacBook during `deploy-desk-to-mini.sh`. Update the local `youtube-knowledge` MCP server configuration to read directly from a local read-only SQLite backup in the event of tunnel disconnection.

### 4.4 Fleet Tooling

- **Drift:** The Mini runs commands directly via `fleet-cli.py`. The MacBook executes a wrapper script (`fleet-cli-desk.sh`) which forwards commands over SSH to execute on the Mini.
- **Gaps & Risks:** If the SSH connection is interrupted, MacBook task edits fail and are lost, forcing the developer to manually write status records in `OFFLINE_CURSOR_HANDOFF.md` to prevent registry drift.
- **Refinement Opportunities:** Update `fleet-cli-desk.sh` to capture failed connection exceptions and write state changes into a pending local queue directory (`~/.openclaw/desk-handoffs/pending/`). The Mini's `kai-desk-handoff-reconcile` daemon will process and merge these changes once connectivity is restored.

### 4.5 Security Posture

- **Drift:** The Mini is physically locked in a dedicated location with FileVault disabled and Auto-login enabled to ensure automatic system recovery and startup of background daemons after power failures.
- **Gaps & Risks:** Secrets (including API keys and bot tokens) are stored in plaintext in the decrypted `vault.json` file while the gateway is active. If the Mini is physically stolen or compromised, all integration keys are immediately exposed.
- **Refinement Opportunities:** Automate `vault-age-seal.sh` in the gateway shutdown hooks. Restrict Tailscale ACLs so the gateway port `18789` is bind-locked to loopback (`127.0.0.1`) and Tailscale-only interfaces, blocking general LAN requests.

### 4.6 Cron / Automation

- **Drift:** All automations run exclusively on the Mini. MacBook has crons disabled.
- **Gaps & Risks:** Configuration lines for the 4 disabled/deprecated crons still clutter the policy file `apply-openclaw-policy.py`. Additionally, high-impact weekly cron tasks (e.g., `weekly-lead-flow-full`) lack automatic retry limits, meaning a transient network failure delays validation by 7 days.
- **Refinement Opportunities:** Cleanly prune the disabled jobs from `apply-openclaw-policy.py`. Introduce a retry-with-backoff handler for validation crons to handle transient network errors.

### 4.7 OpenClaw Product Integration

- **Drift:** Product codebases are pushed from the MacBook to `shrad3r/openclaw` and manually pulled on the Mini. Fleet policies are pushed and applied via `deploy-desk-to-mini.sh`.
- **Gaps & Risks:** The manual step of pulling updates on the Mini (`ssh mac-mini 'git pull'`) introduces developer friction, resulting in delays in synchronizing code changes.
- **Refinement Opportunities:** Implement a lightweight background job (or a webhook listener on the Mini gateway) running every 10m that polls `shrad3r/openclaw` on `main`, runs automated testing checks, and performs a fast-forward merge if verification succeeds.

---

## Section 5: Recommended Action Items & Next Steps

To improve reliability, developer experience, and security, the following action items are proposed:

### Priority 1: High Reliability & Fallback Routing

1. **Dynamic Fallover Routing:** Update the gateway model selector to verify the state of port 8001. If the reverse SSH tunnel is closed or unresponsive, route incoming traffic to the Mini's local `mlx/gemma-4-12b-4bit` or `google/gemini-2.5-flash-lite`.
2. **Local Grounding Sync:** Modify `deploy-desk-to-mini.sh` to mirror the sqlite `knowledge.db` database back to the MacBook. Update the `youtube-knowledge` MCP server to fall back to a local read-only SQlite reader.

### Priority 2: Security Hardening

3. **Tailscale ACL Lock:** Bind port 18789 exclusively to loopback and Tailscale network interfaces on the Mac Mini. Block general local area network (LAN) requests to mitigate physical access risks.
4. **Vault Auto-Sealing:** Integrate the `vault-age-seal.sh` routine into the system shutdown hooks to encrypt credentials whenever the OpenClaw gateway process terminates.

### Priority 3: Automation & DevOps Optimization

5. **Policy Pruning:** Edit `apply-openclaw-policy.py` to remove the configurations and stagger schedules for the 4 disabled jobs (`kai-advisor-ideation-pulse`, `kai-council-ideation-pulse`, `kai-midday-council-ideation`, and `kai-cursor-pr-reconcile`).
6. **Webhook-Based Auto-Pull:** Deploy a lightweight listener daemon on the Mac Mini. Upon receiving a merge hook from the `shrad3r/openclaw` main branch, it should fetch changes, execute the test suite, and run `git merge --ff-only` on success.
7. **Offline Tooling Queue:** Upgrade `fleet-cli-desk.sh` to cache commands locally when the Mini is offline. Save changes as JSON payloads to be automatically reconciled via the `kai-desk-handoff-reconcile` cron.

---

## Citations & References

The findings and principles in this audit report are sourced from:

- **YKE Grounding Guidelines:** `[AI Knowledge Playbook](AI_KNOWLEDGE_PLAYBOOK.md) §1, §3`
- **System Constraints and Pushback Policies:** `[Autonomy Bounds](AUTONOMY_BOUNDS.md)`
- **Device Layout and Model Specifications:** `[Stack Topology](STACK_TOPOLOGY.md) §5`
- **Business Loops and Validation ROI:** `[Steelman Business Thesis](STEELMAN-BUSINESS-THESIS-2026-06-21.md)`
- **MacBook System Manifest:** `DESK_MANIFEST.json`
- **Operator Runbook:** `docs/DESK_CONTEXT.md`
- **Mini Active Configurations:** `backups/mini-secrets/openclaw.json`
