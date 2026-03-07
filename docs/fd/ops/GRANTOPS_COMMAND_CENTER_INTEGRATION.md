# GrantOps — Command Center Integration Spec

## Overview

GrantOps is a Finance sub-module for automated grant discovery, fit scoring,
package assembly, submission, and outcome tracking. It lives inside the Finance
section of the OpenClaw Command Center — not as a separate product.

**Flow:** Opportunities -> Drafts/Packages -> Submissions -> Outcomes

All data mirrors to Notion. Telegram is the action layer for approvals and
escalations. The daily scan runs as a scheduled job on the cluster.

---

## Location in Command Center

```
Finance
├── Cash
├── Invoices
├── Expenses
├── Forecast
└── GrantOps
    ├── Summary
    ├── Opportunities
    ├── Drafts / Packages
    ├── Submissions
    ├── Vault / Attachments
    └── Daily Digest Log
```

---

## Widget Keys

| Widget Key | Title | What It Shows |
|------------|-------|---------------|
| `finance.grants.summary` | GrantOps Summary | New today, high-fit count, drafts waiting, submissions pending, next follow-up |
| `finance.grants.new_today` | New Today | Top 5 newly discovered opps: funder, deadline, fit score, portal type |
| `finance.grants.high_priority` | High Priority | Fit score >= threshold, "Draft now" action, Telegram approval badge |
| `finance.grants.packages_review` | Packages in Review | Package name, related opp, reviewer status, attachments ready |
| `finance.grants.submissions_action_needed` | Action Needed | Submission method, blocker reason, link to package, "Open in Telegram" |

### Widget Spec Definitions

```python
GRANTS_SUMMARY = WidgetSpec(
    widget_key="finance.grants.summary",
    title="GrantOps Summary",
    instruction="Check grant pipeline health. Act on anything needing attention.",
    icon="\U0001f3db",  # classical building
    renderer="render_grants_summary_widget",
    required_view_keys=["finance.grants.summary"],
)

GRANTS_NEW_TODAY = WidgetSpec(
    widget_key="finance.grants.new_today",
    title="New Grant Opportunities",
    instruction="Review today's discoveries. Draft high-fit matches.",
    icon="\U0001f4e5",  # inbox tray
    renderer="render_grants_new_today_widget",
    required_view_keys=["finance.grants.opportunities"],
)

GRANTS_HIGH_PRIORITY = WidgetSpec(
    widget_key="finance.grants.high_priority",
    title="High Priority Grants",
    instruction="These need drafts started now. Approve via Telegram if flagged.",
    icon="\U0001f525",  # fire
    renderer="render_grants_high_priority_widget",
    required_view_keys=["finance.grants.opportunities"],
)

GRANTS_PACKAGES_REVIEW = WidgetSpec(
    widget_key="finance.grants.packages_review",
    title="Packages in Review",
    instruction="Review and approve draft packages before submission.",
    icon="\U0001f4e6",  # package
    renderer="render_grants_packages_review_widget",
    required_view_keys=["finance.grants.drafts"],
)

GRANTS_SUBMISSIONS_ACTION = WidgetSpec(
    widget_key="finance.grants.submissions_action_needed",
    title="Submissions — Action Needed",
    instruction="Unblock stalled submissions. Escalate via Telegram if needed.",
    icon="\U0001f6a8",  # rotating light
    renderer="render_grants_submissions_action_widget",
    required_view_keys=["finance.grants.submissions"],
)
```

---

## Notion Database Schemas

### 1. Grant Opportunities (`finance.grant_opportunities`)

| Property | Type | Options / Notes |
|----------|------|-----------------|
| Name | title | Opportunity name |
| Funder | rich_text | Granting organization |
| Deadline | date | Application deadline |
| Amount Min | number | Minimum grant amount (USD) |
| Amount Max | number | Maximum grant amount (USD) |
| Fit Score | number | 0.0 - 1.0, computed by scoring engine |
| Effort Score | number | 0.0 - 1.0, estimated effort to apply |
| Priority | select | `urgent`, `high`, `medium`, `low` |
| Status | select | `new`, `evaluating`, `drafting`, `submitted`, `won`, `lost`, `expired`, `skipped` |
| Portal Type | select | `submittable`, `fluxx`, `email`, `portal_other`, `guided` |
| Portal URL | url | Direct link to application portal |
| Source | select | `candid`, `grants_gov`, `manual`, `referral` |
| Brand | select | `fulldigital`, `cutmv`, `both` |
| Tags | multi_select | Freeform tags |
| Discovered At | date | When the scanner found it |
| External ID | rich_text | Dedupe key (source:id) |
| Notes | rich_text | Free-form notes |

**Required Views:**
- `All Opportunities` (table, sorted by deadline)
- `High Fit` (table, filtered: fit_score >= 0.7)
- `By Status` (board, grouped by Status)
- `Expiring Soon` (table, filtered: deadline within 14 days)

### 2. Grant Drafts / Packages (`finance.grant_drafts`)

| Property | Type | Options / Notes |
|----------|------|-----------------|
| Name | title | Package name |
| Opportunity | relation | -> Grant Opportunities |
| Status | select | `requirements_extracted`, `drafting`, `review`, `approved`, `revision_needed` |
| Narrative | rich_text | Generated narrative text |
| Budget Justification | rich_text | Generated budget section |
| Timeline | rich_text | Project timeline bullets |
| Attachments Ready | checkbox | All required docs attached |
| Reviewer | rich_text | Who is reviewing |
| Review Notes | rich_text | Feedback from reviewer |
| Package Manifest | rich_text | JSON manifest of all components |
| Vault Snapshot ID | rich_text | Business Profile Vault version used |
| Created At | date | Draft creation timestamp |
| Updated At | date | Last modification |

**Required Views:**
- `All Drafts` (table, sorted by updated_at desc)
- `Needs Review` (table, filtered: status = review)
- `By Status` (board, grouped by Status)

### 3. Grant Submissions (`finance.grant_submissions`)

| Property | Type | Options / Notes |
|----------|------|-----------------|
| Name | title | Submission label |
| Opportunity | relation | -> Grant Opportunities |
| Draft | relation | -> Grant Drafts |
| Method | select | `submittable_api`, `guided_submit`, `email`, `manual` |
| Status | select | `pending`, `submitted`, `confirmed`, `rejected`, `needs_resubmit`, `blocked` |
| Submitted At | date | When actually submitted |
| Confirmation ID | rich_text | Portal confirmation number |
| Blocker Reason | rich_text | Why it's stuck (if blocked) |
| Follow Up Date | date | Next follow-up action date |
| Outcome | select | `pending`, `awarded`, `declined`, `waitlisted` |
| Award Amount | number | Actual award amount if won |
| Notes | rich_text | Free-form notes |

**Required Views:**
- `All Submissions` (table, sorted by submitted_at desc)
- `Action Needed` (table, filtered: status in [blocked, needs_resubmit])
- `By Outcome` (board, grouped by Outcome)
- `Follow Up Due` (table, filtered: follow_up_date <= today + 3 days)

---

## SQLite Tables (Local)

These tables are the local source of truth. Notion is the mirror.

```sql
-- Grant opportunities discovered by scanner
CREATE TABLE IF NOT EXISTS grant_opportunities (
    id              TEXT PRIMARY KEY,
    external_id     TEXT UNIQUE NOT NULL,     -- dedupe key: source:provider_id
    name            TEXT NOT NULL,
    funder          TEXT NOT NULL DEFAULT '',
    deadline        TEXT,                      -- ISO date
    amount_min_usd  REAL,
    amount_max_usd  REAL,
    fit_score       REAL DEFAULT 0.0,
    effort_score    REAL DEFAULT 0.0,
    priority        TEXT DEFAULT 'medium',     -- urgent/high/medium/low
    status          TEXT DEFAULT 'new',
    portal_type     TEXT DEFAULT 'guided',     -- submittable/fluxx/email/portal_other/guided
    portal_url      TEXT DEFAULT '',
    source          TEXT DEFAULT 'manual',     -- candid/grants_gov/manual/referral
    brand           TEXT DEFAULT 'fulldigital',
    tags_json       TEXT DEFAULT '[]',
    raw_data_json   TEXT DEFAULT '{}',
    discovered_at   TEXT NOT NULL,             -- ISO timestamp
    updated_at      TEXT NOT NULL,
    content_hash    TEXT NOT NULL DEFAULT ''    -- for Notion mirror drift detection
);

-- Draft packages assembled for applications
CREATE TABLE IF NOT EXISTS grant_drafts (
    id                TEXT PRIMARY KEY,
    opportunity_id    TEXT NOT NULL REFERENCES grant_opportunities(id),
    name              TEXT NOT NULL,
    status            TEXT DEFAULT 'requirements_extracted',
    narrative         TEXT DEFAULT '',
    budget_json       TEXT DEFAULT '{}',
    timeline_json     TEXT DEFAULT '[]',
    attachments_ready INTEGER DEFAULT 0,
    reviewer          TEXT DEFAULT '',
    review_notes      TEXT DEFAULT '',
    manifest_json     TEXT DEFAULT '{}',
    vault_snapshot_id TEXT DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    content_hash      TEXT NOT NULL DEFAULT ''
);

-- Submission tracking
CREATE TABLE IF NOT EXISTS grant_submissions (
    id                TEXT PRIMARY KEY,
    opportunity_id    TEXT NOT NULL REFERENCES grant_opportunities(id),
    draft_id          TEXT REFERENCES grant_drafts(id),
    name              TEXT NOT NULL,
    method            TEXT DEFAULT 'guided_submit',
    status            TEXT DEFAULT 'pending',
    submitted_at      TEXT,
    confirmation_id   TEXT DEFAULT '',
    blocker_reason    TEXT DEFAULT '',
    follow_up_date    TEXT,
    outcome           TEXT DEFAULT 'pending',
    award_amount_usd  REAL,
    notes             TEXT DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    content_hash      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_grant_opps_status ON grant_opportunities(status);
CREATE INDEX IF NOT EXISTS idx_grant_opps_deadline ON grant_opportunities(deadline);
CREATE INDEX IF NOT EXISTS idx_grant_opps_fit ON grant_opportunities(fit_score);
CREATE INDEX IF NOT EXISTS idx_grant_drafts_status ON grant_drafts(status);
CREATE INDEX IF NOT EXISTS idx_grant_drafts_opp ON grant_drafts(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_grant_subs_status ON grant_submissions(status);
CREATE INDEX IF NOT EXISTS idx_grant_subs_followup ON grant_submissions(follow_up_date);
```

---

## Telegram Approval Flow

GrantOps uses the existing Telegram bot infrastructure for human-in-the-loop.

### Alert Types

| Event | Telegram Action | Approval Required |
|-------|----------------|-------------------|
| High-fit opportunity discovered (fit >= 0.8) | Alert message with details | No (info only) |
| Package ready for review | Approval request with inline buttons | Yes |
| Submittable submission ready | Confirm-to-submit with inline buttons | Yes |
| Submission blocked (unknown field / auth) | Escalation with blocker details | Manual resolution |
| Submission confirmed | Success notification | No |
| Grant awarded | Celebration alert | No |
| Follow-up overdue | Reminder with action link | No |

### Message Format

```
[GrantOps] High-Fit Opportunity

Funder: National Arts Council
Grant: Digital Arts Innovation Fund
Deadline: 2026-04-15
Amount: $25,000 - $50,000
Fit Score: 0.92
Portal: Submittable

[Start Draft] [Skip] [View in Notion]
```

### Approval Flow

1. Package assembled -> Telegram approval request sent
2. User taps `[Approve]` or `[Revise]`
3. If approved -> submission lane triggered
4. If Submittable -> auto-submit with confirmation prompt
5. If guided -> instructions sent to Telegram with checklist
6. Outcome tracked back to SQLite -> mirrored to Notion

---

## Daily Scan Timing

| Schedule | Action |
|----------|--------|
| 06:00 ET | Daily grant scan (Candid/Grants.gov ingestion) |
| 06:15 ET | Fit/effort scoring on new discoveries |
| 06:30 ET | Notion upsert for new/updated opportunities |
| 06:35 ET | Telegram daily digest (if any high-priority items) |
| 12:00 ET | Follow-up check (submissions needing attention) |
| 18:00 ET | Deadline warning (opportunities expiring in 3 days) |

The daily scan job runs on whichever cluster node picks it up from
`~/cluster/jobs/pending/`. Typically M4 (storage node).

---

## Safe Mode Rules (Non-Negotiable)

GrantOps follows all existing OpenClaw safety controls:

1. **DRY_RUN=true** (default): All external writes simulated
   - Notion upserts logged but not executed
   - Submittable API calls simulated
   - Telegram messages sent in dry-run format
2. **KILL_SWITCH=true**: Blocks ALL GrantOps external writes immediately
3. **READ_ONLY=true**: Allows scanning/scoring but blocks writes
4. **NOTION_WRITE_LOCK=true**: Blocks Notion mutations, GrantOps included
5. **Every Submittable submission requires Telegram approval** (no auto-submit)
6. **Audit trail**: Every action recorded via `write_audit()`
7. **Rate limiting**: Candid and Submittable calls go through `LimiterRegistry`
8. **Idempotency**: Duplicate opportunities rejected via `external_id` UNIQUE constraint

### GrantOps-Specific Safety

```python
GRANTOPS_AUTO_SUBMIT_ENABLED = False   # Must be explicitly enabled
GRANTOPS_FIT_SCORE_THRESHOLD = 0.7     # Below this = auto-skip
GRANTOPS_MAX_SUBMISSIONS_PER_DAY = 3   # Rate limit on submissions
GRANTOPS_REQUIRE_TELEGRAM_APPROVAL = True  # Always true for submissions
```

---

## Scoring Engine

### Fit Score (0.0 - 1.0)

Measures how well an opportunity matches the business profile.

| Factor | Weight | Source |
|--------|--------|--------|
| Industry alignment | 0.25 | Keywords vs. business profile |
| Amount range match | 0.20 | Min/max vs. typical project size |
| Geographic eligibility | 0.15 | Location requirements |
| Organization type match | 0.15 | Nonprofit/for-profit/hybrid |
| Past success rate with funder | 0.10 | Historical data |
| Timeline feasibility | 0.15 | Deadline vs. current capacity |

### Effort Score (0.0 - 1.0)

Estimates the work required to apply.

| Factor | Weight | Source |
|--------|--------|--------|
| Portal complexity | 0.30 | Submittable = low, custom portal = high |
| Required attachments | 0.25 | Number of custom documents needed |
| Narrative length | 0.20 | Word count requirements |
| Budget detail level | 0.15 | Line-item vs. summary |
| References required | 0.10 | Letters of support needed |

### Priority Derivation

```
if fit_score >= 0.8 and effort_score <= 0.5:  priority = "urgent"
elif fit_score >= 0.7:                         priority = "high"
elif fit_score >= 0.5:                         priority = "medium"
else:                                          priority = "low"
```

---

## Drafting Workflow

### Requirements Extraction

1. Parse opportunity description for required sections
2. Identify required attachments (budget, timeline, narrative, letters)
3. Map to Business Profile Vault fields
4. Generate requirements checklist

### Package Assembly

1. **Narrative**: Generated from business profile + opportunity requirements
2. **Budget Justification**: Template-driven with project-specific line items
3. **Timeline**: Milestone bullets from template + deadline working backward
4. **Supporting Docs**: Pulled from vault (org chart, financial statements, etc.)
5. **Manifest**: JSON document listing all package components and their status

### Package States

```
requirements_extracted -> drafting -> review -> approved -> (submission lane)
                                        |
                                        v
                                  revision_needed -> drafting (loop)
```

---

## Submission Workflow

### Lane Selection

```
if portal_type == "submittable":
    -> Submittable API lane (highest automation)
elif portal_type == "email":
    -> Email submission lane (compose + confirm)
else:
    -> Guided submit lane (instructions + checklist + Telegram)
```

### Submittable API Lane

1. Authenticate with Submittable API
2. Map package fields to Submittable form schema
3. Upload attachments
4. Submit application
5. Capture confirmation ID
6. Update status to `submitted`
7. Notify via Telegram

### Guided Submit Lane

1. Generate step-by-step instructions
2. Include direct links to portal
3. Send to Telegram with checklist
4. User manually submits
5. User confirms via Telegram inline button
6. Status updated to `confirmed`

---

## Provider Rate Limits

Add to `packages/common/provider_limits.py`:

```python
"candid": RateLimitConfig(rps=0.5, burst=2, ...),
"submittable": RateLimitConfig(rps=1.0, burst=3, requires_write_approval=True, ...),
"grants_gov": RateLimitConfig(rps=0.3, burst=1, ...),
```

---

## Environment Variables

Add to `.env` / `.env.example`:

```bash
# GrantOps
GRANTOPS_ENABLED=false
GRANTOPS_AUTO_SUBMIT_ENABLED=false
GRANTOPS_FIT_SCORE_THRESHOLD=0.7
GRANTOPS_MAX_SUBMISSIONS_PER_DAY=3
GRANTOPS_REQUIRE_TELEGRAM_APPROVAL=true
GRANTOPS_DAILY_SCAN_HOUR=6
GRANTOPS_DAILY_SCAN_TIMEZONE=America/New_York

# Candid API
CANDID_API_KEY=
CANDID_BASE_URL=https://api.candid.org/grants/v1

# Submittable API
SUBMITTABLE_API_KEY=
SUBMITTABLE_ORG_ID=
SUBMITTABLE_BASE_URL=https://api.submittable.com/v4

# Notion DB IDs (populated after bootstrap)
NOTION_DB_GRANT_OPPORTUNITIES_ID=
NOTION_DB_GRANT_DRAFTS_ID=
NOTION_DB_GRANT_SUBMISSIONS_ID=
```

---

## Event Taxonomy

GrantOps events follow the existing `{domain}.{action}` pattern:

| Event | Trigger |
|-------|---------|
| `grant.discovered` | New opportunity found by scanner |
| `grant.scored` | Fit/effort scores computed |
| `grant.status_changed` | Opportunity status transition |
| `grant.draft.created` | New draft package started |
| `grant.draft.review_requested` | Package sent for review |
| `grant.draft.approved` | Package approved for submission |
| `grant.submission.attempted` | Submission initiated |
| `grant.submission.confirmed` | Submission confirmed (portal or human) |
| `grant.submission.blocked` | Submission hit a blocker |
| `grant.outcome.awarded` | Grant won |
| `grant.outcome.declined` | Grant lost |
| `grant.followup.overdue` | Follow-up date passed without action |

---

## File Layout

```
packages/grantops/
├── __init__.py
├── models.py           # Pydantic models (Opportunity, Draft, Submission)
├── store.py            # SQLite CRUD for all three tables
├── scoring.py          # Fit/effort scoring engine
├── scanner.py          # Daily scan orchestrator (Candid ingestion)
├── drafter.py          # Package assembly workflow
├── submitter.py        # Submission lane router
└── digest.py           # Telegram daily digest + alerts

packages/agencyu/notion/mirror/writers/
└── notion_grants_writer.py   # Notion mirror writer for all 3 grant DBs

packages/agencyu/notion/widgets/
└── cc_grants.py              # Widget renderers for 5 grant widgets
```

---

## Simple Mode vs Ops Mode

### Simple Mode (default Finance panel)

4 summary tiles:
- New today (count)
- High priority (count)
- Packages in review (count)
- Action needed (count)

Top 5 opportunities list (name, funder, deadline, fit score)

Top 3 action-needed items (submission, blocker, link)

Two buttons:
- "Run Daily Grant Scan" (triggers scan job)
- "Open Telegram Bot" (deep link)

### Ops Mode (expanded view)

- Raw DB views (all opportunities, all drafts, all submissions)
- Retry failed scan/submission jobs
- Portal mapping debug (which fields mapped, which failed)
- Package manifests (JSON view)
- Audit trail (all grant.* events)
- Scoring debug (factor breakdown per opportunity)
