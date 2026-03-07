# Tool Specifications

Detailed specs for each tool the agent can use.

---

## Grant Scanner

**Purpose:** Find and evaluate grant opportunities for Full Digital.

**Actions:**
- `grant.scan` — Query grant databases (Candid, Submittable, manual sources)
- `grant.score` — Evaluate opportunities by fit score (threshold: 0.7)
- `grant.write_summary` — Produce a ranked summary of top matches
- `grant.prepare_submission` — Draft a submission package (HIGH RISK — needs approval)

**Config:** `GRANTOPS_ENABLED`, `GRANTOPS_FIT_SCORE_THRESHOLD`

**Schedule:** Daily at 6:00 AM ET

---

## Marketing Analyzer

**Purpose:** Evaluate campaign performance and recommend next actions.

**Actions:**
- `marketing.analyze` — Pull performance data and identify trends
- `marketing.propose_next_actions` — Suggest budget reallocation or creative changes (MEDIUM RISK)

**Data sources:** GHL pipeline, ad platform metrics

---

## Content Generator

**Purpose:** Create ad hooks, captions, scripts, and social content.

**Actions:**
- `content.generate` — Produce content pieces using Ollama (4b model)
- `content.review` — Format and quality-check generated content

**Config:** Count specified in prompt entities (default: 3)

---

## System Health Check

**Purpose:** Verify cluster, gateway, and model availability.

**Actions:**
- `system.health` — Check all nodes, services, and Ollama status

**Schedule:** Every 15 minutes

**Alert:** Sends Telegram alert on failure

---

## Daily Guidance

**Purpose:** Compile today's priorities from schedule, tasks, and finance data.

**Actions:**
- `daily.guidance` — Aggregate schedule, deadlines, and focus areas

**Schedule:** Daily at 8:00 AM ET

---

## Sales Pipeline

**Purpose:** Monitor deal flow and flag follow-up opportunities.

**Actions:**
- `sales.pipeline_status` — Pull current pipeline from GHL
- `sales.suggest_followups` — Identify stale deals and overdue actions

---

## Approval Processor

**Purpose:** Handle approve/deny decisions from DA.

**Actions:**
- `approval.approve` — Execute the pending action
- `approval.deny` — Cancel the pending action and notify
