# Original User Request

## Initial Request — 2026-07-03T18:42:35Z

Run a comprehensive audit of the OpenClaw fleet setup, identifying gaps, refinement opportunities, and bleeding-edge improvements. Ground findings in live YKE knowledge base data.

Working directory: ~/teamwork_projects/openclaw_audit
Integrity mode: development

---

## Context

This is Jacob Shrader's personal AI agent fleet. The fleet runs on a Mac Mini (headless, canonical SOT) with a MacBook as the daily-driver desk. The fleet's central agent is **Kai**, operating as Agent-as-CTO with autonomous authority over architecture and deployment on existing vendors.

Key fleet paths:

- Fleet policy (MacBook read copy): `~/.openclaw/workspace/`
- Fleet scripts: `~/.openclaw/scripts/`
- Fleet runtime config: `~/.openclaw/openclaw.json`

The MacBook has a synced read copy of the Mini's workspace (synced at each `deploy-desk-to-mini.sh` run). The Mini's canonical files live at the same paths under the `henri` user.

Access the Mini via SSH using the alias `mac-mini-tunnel` (defined in `~/.ssh/config`).

---

## Requirements

### R1. YKE Knowledge Grounding

Query the YKE MCP data plane for slugs relevant to the following topics: **agent orchestration**, **AI model routing**, **OpenClaw**, **bleeding-edge LLM practices**, **multi-agent systems**, **fleet automation**, and **cost optimization for AI**. For each major audit finding, cite the specific YKE slug(s) that support or contradict the current fleet behavior. Surface any YKE knowledge that is NOT yet reflected in the fleet's current setup — these are the gaps and augmentation opportunities.

### R2. Fleet Config Audit (7 Domains)

Audit the live fleet configuration across all seven domains:

1. **Agent ops** — Kai autonomy bounds, task routing logic, escalation paths, cron cadence.
2. **Model routing** — MLX/Gemma tiering, fallback chains, the `desk-before-cloud` policy, cost vs. quality tradeoffs across agent roles.
3. **YKE grounding** — Are agent system prompts and boot files actually pulling from the right YKE knowledge slugs? Are any agent roles under-informed?
4. **Fleet tooling** — Scripts in `~/.openclaw/scripts/`, deploy pipeline, workspace hygiene, CLI inventory, any dead or duplicate scripts.
5. **Security posture** — Tailscale ACLs, secret scanning, auth profiles in `openclaw.json`, plaintext key exposure risk.
6. **Cron / automation** — Review all 28 synced cron jobs. Identify any that are redundant, too frequent, stale, or missing.
7. **OpenClaw product integration** — How effectively does the fleet drive actual product commits vs. internal overhead? What is the ratio of product-facing tasks vs. fleet maintenance tasks in the registry?

Read the fleet config from **both** the MacBook (`~/.openclaw/workspace/`) and the Mini (via SSH `mac-mini-tunnel`) and explicitly flag any files that differ between the two (drift detection).

### R3. Findings Report

Produce a structured audit report at `~/teamwork_projects/openclaw_audit/AUDIT_REPORT.md`.

For each finding:

- **Domain** (one of the 7 above)
- **Finding** — describe the current behavior and the gap
- **YKE Citation** — the slug(s) or source that supports this finding
- **Recommended Fix** — concrete, specific, actionable
- **Impact** — High / Medium / Low
- **Effort** — High / Medium / Low

At the top of the report, include:

- An executive summary (3–5 sentences)
- A prioritized shortlist of the top 5 findings ranked by High Impact × Low Effort (quick wins)
- A drift summary table: files that differ between MacBook and Mini

---

## Acceptance Criteria

### Report Completeness

- [ ] All 7 audit domains have at least 2 findings each
- [ ] Every finding includes a YKE citation (slug name or source reference)
- [ ] Every finding includes both a current-behavior description AND a recommended fix
- [ ] Every finding has Impact and Effort ratings

### YKE Coverage

- [ ] At least 10 distinct YKE slugs are cited across the report
- [ ] At least 3 findings surface knowledge from YKE that is NOT currently reflected in the fleet setup (net-new augmentation opportunities)

### Drift Detection

- [ ] A drift table is present comparing MacBook workspace vs. Mini canonical
- [ ] Any drifted files are explicitly called out as findings (or confirmed benign)

### Prioritization

- [ ] A top-5 quick-wins list is present at the top of the report
- [ ] Quick wins are ranked by High Impact + Low Effort

### Format

- [ ] Report is a single Markdown file at `~/teamwork_projects/openclaw_audit/AUDIT_REPORT.md`
- [ ] Executive summary is present and ≤ 5 sentences
