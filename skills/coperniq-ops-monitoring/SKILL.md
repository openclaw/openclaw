# Coperniq Operations Monitoring (Enhanced)

JR provides deep operational intelligence across the entire Vero Power project lifecycle. All 10 capabilities below read from the local Coperniq cache (`~/.openclaw/cache/coperniq/`), which syncs every 15 minutes via `scripts/coperniq-sync.ts`. No live API calls during reads.

**Delivery channels:**

- **Morning reports** — posted to Slack daily (Mon–Fri, 8 AM).
- **On-demand** — employee or Ridge messages `@JR` with a command.
- **Alerts** — JR proactively posts to Slack when thresholds are breached.

---

## Field Name Mapping

The engineering brief uses shorthand field names. The actual Coperniq custom field `keyName` values (from `properties.json`) are:

| Brief Name                   | Actual `custom` keyName                                                                                                      | Type                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `finance_status`             | `finance_status`                                                                                                             | DROPDOWN (Cancelled, Pending Stipulation, Pending Downpayment, … M3 Approved) |
| `stipulations`               | `stipulations`                                                                                                               | DROPDOWN, `isMultiple: true` (Bank Verification, Title Verification, …)       |
| `engineering_submitted_date` | `engineering_submitted_date`                                                                                                 | DATE                                                                          |
| `engineering_completed_date` | `engineering_completed_date`                                                                                                 | DATE                                                                          |
| `permit_applied_date`        | `permit_applied_date`                                                                                                        | DATE                                                                          |
| `permit_approved_date`       | **`permit_received_date`**                                                                                                   | DATE                                                                          |
| `utility_submission`         | **`utility_application_submitted_date`**                                                                                     | DATE                                                                          |
| `utility_approved`           | `utility_application_approved_date`                                                                                          | DATE                                                                          |
| `utility_status`             | `utility_status`                                                                                                             | DROPDOWN                                                                      |
| `install_date`               | **`install_scheduled_date`** + `install_completed_date`                                                                      | DATE                                                                          |
| `installation_crew`          | `installation_crew`                                                                                                          | TEXT                                                                          |
| `BOM / materials`            | `solar_materials_status` (DROPDOWN: BOM Review Needed → BOM Ordered), `solar_materials_cost`, `solar_material_delivery_date` | mixed                                                                         |
| `AHJ`                        | `ahj`                                                                                                                        | TEXT                                                                          |
| PTO                          | `pto_date`, `pto_granted_date` (check properties.json for exact keys)                                                        | DATE                                                                          |

Equipment detail fields: `module_manufacturer`, `module_model`, `module_quantity`, `inverter_manufacturer`, `inverter_model`, `inverter_quantity`, `battery_manufacturer`, `battery_model`, `battery_quantity`, `battery_s_installation_date`.

> When the brief references a field name that doesn't match exactly, use the mapping above. For the full schema, read `~/.openclaw/cache/coperniq/properties.json` → `project` array.

---

## 1. Project Phase Tracking

**Purpose:** Count and list projects per phase. Identify projects stuck beyond SLA thresholds.

### Data Sources

| File                   | Fields                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `project-details.json` | `phaseInstances[]` → `name`, `status`, `startedAt`, `completedAt`, `phaseTemplate.redSla`, `phaseTemplate.yellowSla` |
| `projects.json`        | `phase.name`, `phase.status`, `status` (filter ACTIVE only)                                                          |
| `workflows.json`       | `phases[]` → `name`, `redSla`, `yellowSla` (days) — fallback SLA source                                              |

### Implementation

1. Load `project-details.json`, filter to `status === "ACTIVE"`.
2. For each project, find the **current phase** (the `phaseInstance` with `status === "IN_PROGRESS"`).
3. Group projects by current phase name.
4. For each in-progress phase instance: compute `days_in_phase = (now - startedAt) / 86400000`.
5. Compare against SLA thresholds:
   - **Green:** `days_in_phase < yellowSla`
   - **Yellow:** `yellowSla ≤ days_in_phase < redSla`
   - **Red (stuck):** `days_in_phase ≥ redSla`

### Output

**Phase summary** (morning report or on-demand):

```
Project Phase Summary — 76 ACTIVE projects
  Engineering:     12 (2 red, 1 yellow)
  Permitting:      18 (3 red)
  Utility/Interco: 8  (1 red)
  Install Ready:   15
  Scheduled:       10
  Complete:        13

Stuck projects (past red SLA):
  • Smith Residence — Permitting — 22 days (SLA: 14)
  • Jones Solar — Engineering — 18 days (SLA: 10)
```

**Trigger:** Morning report + `@JR phase summary` + alert when a project crosses red SLA.

---

## 2. Individual Workload Dashboards

**Purpose:** Per-employee view of assigned work: total, in-progress, overdue, can-start-early.

### Data Sources

| File                    | Fields                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `employee-summary.json` | Per-employee rollup: WO counts (total, completed, working, waiting, assigned), project roles, comment counts |
| `work-orders.json`      | `assignee`, `status`, `isCompleted`, `statuses[]` (timing), `checklist[]`, `project` context                 |
| `project-details.json`  | Phase SLA for "overdue" determination                                                                        |

### Implementation

1. Load `work-orders.json`, filter to ACTIVE projects.
2. Group by `assignee.email`.
3. For each employee:
   - **Total assigned:** count where `isCompleted === false`
   - **In-progress:** status `"working"` (or equivalent from `statuses[]`)
   - **Waiting:** status `"waiting"`
   - **Overdue:** WOs where time-in-current-status exceeds phase SLA (join with project details)
   - **Can-start-early:** WOs in `"assigned"` status where upstream dependencies are complete (project phase allows it)

### Output

```
@JR my workload

Sam LeSueur — Workload
  Total open: 24
  In-progress: 8
  Waiting: 6
  Overdue: 3
    • WO #4521 — Smith Residence — 5 days past SLA
    • WO #4530 — Jones Solar — 2 days past SLA
    • WO #4545 — Davis Install — 1 day past SLA
  Can start early: 2
```

**Trigger:** `@JR my workload` (employee sees own) or `@JR workload [name]` (Ridge sees any). Also included in morning reports.

---

## 3. Stipulation & Blocker Tracking

**Purpose:** Monitor finance status and stipulations that block NTP (Notice to Proceed). Alert on pending blockers.

### Data Sources

| File                   | Fields                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| `project-details.json` | `custom.finance_status`, `custom.stipulations` (multi-select array) |
| `projects.json`        | `status`, `phase`, for context filtering                            |

### Implementation

1. Load `project-details.json`, filter to ACTIVE.
2. Identify projects where `custom.finance_status` is one of the blocking values: `"Pending Stipulation"`, `"Pending Downpayment"`, `"Cancelled"`.
3. For projects with `custom.stipulations` (array), list each unresolved stipulation type.
4. Track resolution time: compare `lastActivity` or phase transition timestamps to estimate how long stipulations have been pending.
5. Flag projects where stipulations are the sole blocker to NTP.

### Output

```
NTP Blockers — 8 projects pending

Pending Stipulation (5):
  • Smith Residence — Bank Verification, Title Verification — 12 days
  • Jones Solar — Income Verification — 8 days
  • Davis Install — Bank Verification — 3 days
  ...

Pending Downpayment (3):
  • Williams Home — awaiting $2,500 — 6 days
  ...
```

**Trigger:** Morning report (blockers section) + `@JR ntp blockers` + proactive alert when a stipulation exceeds 14 days unresolved.

---

## 4. Install Calendar

**Purpose:** Track upcoming installs, material delivery dates, crew assignments. Report weekly install count and capacity.

### Data Sources

| File                   | Fields                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `project-details.json` | `custom.install_scheduled_date`, `custom.install_completed_date`, `custom.installation_crew`, `custom.solar_material_delivery_date` |
| `work-orders.json`     | Install-related WOs (by phase or type)                                                                                              |

### Implementation

1. Load `project-details.json`, filter to ACTIVE.
2. Extract all projects with `custom.install_scheduled_date` set and `custom.install_completed_date` not set (upcoming).
3. Sort by scheduled date ascending.
4. Group by week for capacity view.
5. Cross-reference `custom.solar_material_delivery_date` to flag installs where materials haven't arrived.
6. Group by `custom.installation_crew` for crew utilization.

### Output

```
Install Calendar — Week of Apr 7, 2026

  Mon Apr 7:  Smith Residence — Crew A — materials ✓
  Tue Apr 8:  Jones Solar — Crew B — materials ✓
  Wed Apr 9:  Davis Home — Crew A — ⚠️ materials pending (ETA Apr 8)
  Thu Apr 10: (open)
  Fri Apr 11: Williams Residence — Crew B — materials ✓

This week: 4 installs scheduled | Crew A: 2 | Crew B: 2
Next week: 6 installs scheduled
```

**Trigger:** `@JR install calendar` + weekly summary in Monday morning report + alert when materials are not delivered by T-2 days before install.

---

## 5. Engineering Pipeline

**Purpose:** Track engineering submission to completion. Flag delays and monitor revision cycles.

### Data Sources

| File                   | Fields                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| `project-details.json` | `custom.engineering_submitted_date`, `custom.engineering_completed_date` |
| `phaseInstances[]`     | Engineering phase `startedAt`, `completedAt`, SLA                        |
| `comments.json`        | Comments on engineering-phase projects for revision tracking             |

### Implementation

1. Load `project-details.json`, filter to ACTIVE.
2. Projects **in engineering:** `custom.engineering_submitted_date` set, `custom.engineering_completed_date` not set.
3. Compute `days_in_engineering = now - engineering_submitted_date`.
4. Flag delays: compare to engineering phase SLA from `phaseInstances[]` or `workflows.json`.
5. Revision detection: count projects where `engineering_completed_date` was set, then cleared or re-submitted (if tracked via comments or phase re-entry).

### Output

```
Engineering Pipeline — 14 projects

In engineering (submitted, awaiting completion):
  • Smith Residence — submitted Apr 1 — 7 days (SLA: 10) ✓
  • Jones Solar — submitted Mar 20 — 19 days (SLA: 10) ⚠️ OVERDUE
  • Davis Home — submitted Mar 15 — 24 days (SLA: 10) 🔴 CRITICAL

Completed this week: 3
Avg turnaround (30-day): 11.2 days
```

**Trigger:** Morning report + `@JR engineering status` + alert when project exceeds engineering SLA.

---

## 6. Permit & Utility Status

**Purpose:** Track permit application through approval and utility submission through PTO. Flag stalls per AHJ (Authority Having Jurisdiction).

### Data Sources

| File                   | Fields                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-details.json` | `custom.permit_applied_date`, `custom.permit_received_date`, `custom.utility_application_submitted_date`, `custom.utility_application_approved_date`, `custom.utility_status`, `custom.ahj`, `custom.pto_date`, `custom.pto_granted_date` |
| `phaseInstances[]`     | Permitting and Utility/Interconnection phase timing + SLA                                                                                                                                                                                 |

### Implementation

1. Load `project-details.json`, filter to ACTIVE.
2. **Permit tracking:**
   - Applied but not received: `permit_applied_date` set, `permit_received_date` null.
   - Days waiting: `now - permit_applied_date`.
   - Group by `custom.ahj` to identify slow jurisdictions.
3. **Utility tracking:**
   - Submitted but not approved: `utility_application_submitted_date` set, `utility_application_approved_date` null.
   - PTO status: `pto_date` or `pto_granted_date`.
4. Flag stalls: projects waiting beyond expected timelines per AHJ (use historical averages or fixed thresholds).

### Output

```
Permit Status — 18 projects in permitting

By AHJ:
  Austin (8): avg 12 days — 2 overdue (>21 days)
  Round Rock (4): avg 8 days — all on track
  Cedar Park (3): avg 15 days — 1 overdue (>21 days)
  Other (3): on track

Utility Status — 10 projects awaiting interconnection
  Submitted, awaiting approval: 7 (avg 18 days)
  Approved, awaiting PTO: 3
```

**Trigger:** Morning report + `@JR permit status` / `@JR utility status` + alert when permit wait exceeds AHJ average by 1.5x.

---

## 7. Material / BOM Tracking

**Purpose:** Monitor BOM ordered, quote requested, equipment delivery status.

### Data Sources

| File                   | Fields                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-details.json` | `custom.solar_materials_status` (DROPDOWN: BOM Review Needed, BOM Submitted, BOM Ordered, etc.), `custom.solar_materials_cost`, `custom.solar_material_delivery_date` |
| `line-items.json`      | Per-project line items with quantity, unitCost/Price, catalogItem (full sync only)                                                                                    |
| `catalog-items.json`   | Product metadata: name, manufacturer, SKU, cost, price                                                                                                                |

### Implementation

1. Load `project-details.json`, filter to ACTIVE.
2. Group by `custom.solar_materials_status` to see pipeline.
3. Flag projects where:
   - Status is `"BOM Review Needed"` for > 3 days.
   - `solar_material_delivery_date` is past or within 2 days of `install_scheduled_date`.
   - Status is blank on projects past engineering phase.
4. Optionally cross-reference `line-items.json` for cost rollup or missing items.

### Output

```
Materials Status — 76 ACTIVE projects
  BOM Review Needed:  4 (1 overdue)
  BOM Submitted:      6
  BOM Ordered:        12
  Delivered:          38
  N/A / not yet:      16

⚠️ Delivery at risk:
  • Davis Home — delivery Apr 9, install Apr 10 (1-day buffer)
  • Williams Res — delivery TBD, install Apr 14
```

**Trigger:** `@JR materials status` + alert when delivery date < 2 days before install.

---

## 8. Comment / Communication Mining

**Purpose:** Parse project comments for action items, mentions, follow-up requests. Surface unresolved threads.

### Data Sources

| File            | Fields                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| `comments.json` | `projectId`, `projectTitle`, `comment` (HTML), `createdByUser`, `createdAt` |
| `notes.json`    | Same shape — internal team notes                                            |

### Implementation

1. Load `comments.json` (and optionally `notes.json`).
2. Strip HTML tags from `comment` field.
3. Scan for action-item indicators:
   - Questions (`?` at end of sentence)
   - Directives ("please", "need", "can you", "follow up", "waiting on", "ASAP")
   - @mentions of team members
4. Group by project, sort by recency.
5. Identify **unresolved threads:** last comment on a project is a question or request from someone other than the assigned ops employee, and no follow-up within 24 hours.

### Output

```
Unresolved Comment Threads — 6 projects

  Smith Residence (Sam) — Rep asked "When will permit be ready?" — 3 days ago
  Jones Solar (Clay) — Customer asked about panel delivery — 2 days ago
  Davis Home (Daxton) — Engineering team flagged revision needed — 1 day ago
  ...
```

**Trigger:** Morning report (unresolved section) + `@JR open threads` + feeds into Project Health Score.

---

## 9. Project Health Scoring

**Purpose:** Composite score per project: green (on-track), yellow (at-risk), red (behind). Based on SLA adherence, open blockers, and communication activity.

### Scoring Dimensions

| Dimension              | Weight | Green                                        | Yellow                   | Red                                                   |
| ---------------------- | ------ | -------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| Phase SLA adherence    | 40%    | All phases within yellow SLA                 | Any phase in yellow zone | Any phase past red SLA                                |
| Open blockers          | 30%    | No pending stipulations or missing materials | 1 minor blocker          | Finance blocked, materials missing, or permit stalled |
| Communication activity | 15%    | Comment in last 3 days                       | Comment in last 7 days   | No comment in 7+ days                                 |
| Milestone progress     | 15%    | Next milestone on track                      | Next milestone at risk   | Next milestone overdue                                |

```
health = (sla_score × 0.40) + (blocker_score × 0.30) + (comms_score × 0.15) + (milestone_score × 0.15)
```

| Health | Score  | Label    |
| ------ | ------ | -------- |
| Green  | 70–100 | On track |
| Yellow | 40–69  | At risk  |
| Red    | 0–39   | Behind   |

### Data Sources

All of the above — `project-details.json` (phases, SLA, custom fields for blockers/milestones), `comments.json` (recency), `work-orders.json` (completion).

### Output

```
Project Health — 76 ACTIVE

  🟢 Green: 48 (63%)
  🟡 Yellow: 18 (24%)
  🔴 Red: 10 (13%)

Red projects:
  • Jones Solar — score 22 — Permit stalled (28 days), no comments in 12 days
  • Davis Home — score 31 — Materials missing, install in 3 days
  ...
```

**Trigger:** Morning report (summary) + `@JR project health` + alert on any project turning red.

---

## 10. Bottleneck Detection

**Purpose:** Identify systemic slowdowns — which phase, which employee, which AHJ. Pattern recognition across all active projects.

### Analysis Dimensions

| Dimension               | Method                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Phase bottleneck**    | Compare avg days-in-phase across all active projects to SLA. Which phase has the highest % of projects in yellow/red? |
| **Employee bottleneck** | Which assignee has the most overdue WOs or longest avg time-in-status?                                                |
| **AHJ bottleneck**      | Which jurisdiction has the longest avg permit wait? Which has the most stalled projects?                              |
| **Upstream dependency** | Are projects stacking up waiting for engineering? Materials? Finance?                                                 |

### Data Sources

Aggregation across: `project-details.json`, `work-orders.json`, `comments.json`, `properties.json` (for AHJ grouping).

### Implementation

1. Run phase tracking (§1) → identify the phase with most red projects.
2. Run workload analysis (§2) → identify employees with highest overdue count.
3. Run permit/utility analysis (§6) → identify AHJs with longest avg wait.
4. Correlate: if 60% of red projects are in Permitting and 80% of those are in Austin AHJ → "Austin permitting is the primary bottleneck."

### Output

```
Bottleneck Report — Apr 2026

Top bottleneck: Permitting phase
  • 3/18 projects past red SLA (17%)
  • Austin AHJ accounts for 2 of 3 stalls (avg 28 days vs 14-day SLA)

Employee load imbalance:
  • Sam: 24 open WOs (8 overdue) — highest in team
  • Clay: 18 open WOs (2 overdue)
  • Daxton: 20 open WOs (3 overdue)

Material delays affecting 2 installs this week.
```

**Trigger:** Weekly report (Monday) + `@JR bottlenecks` + proactive alert when a systemic pattern emerges (e.g. >30% of projects in a phase are red).

---

## JR Command Reference

| Command                  | What it does                             | Who can use             |
| ------------------------ | ---------------------------------------- | ----------------------- |
| `@JR phase summary`      | Project counts by phase + stuck projects | Ridge, ops team         |
| `@JR my workload`        | Personal workload dashboard              | Any employee (sees own) |
| `@JR workload [name]`    | Another employee's workload              | Ridge only              |
| `@JR ntp blockers`       | Finance/stipulation blockers             | Ridge, ops team         |
| `@JR install calendar`   | Upcoming installs + crew + materials     | Ridge, ops team         |
| `@JR engineering status` | Engineering pipeline + delays            | Ridge, ops team         |
| `@JR permit status`      | Permit tracking by AHJ                   | Ridge, ops team         |
| `@JR utility status`     | Utility/interconnection tracking         | Ridge, ops team         |
| `@JR materials status`   | BOM/material pipeline                    | Ridge, ops team         |
| `@JR open threads`       | Unresolved comment threads               | Ridge, ops team         |
| `@JR project health`     | Health scores (green/yellow/red)         | Ridge, ops team         |
| `@JR bottlenecks`        | Systemic bottleneck analysis             | Ridge                   |

---

## Dependencies

- **Coperniq cache:** `~/.openclaw/cache/coperniq/` — synced every 15 min by `scripts/coperniq-sync.ts` (LaunchAgent `scripts/coperniq-sync.plist`). All reads are from cache.
- **Slack cache:** `~/.openclaw/cache/slack/` — synced every 15 min by `scripts/slack-sync.ts` (LaunchAgent `scripts/slack-sync.plist`). Used for comment mining and communication grading.
- **Email archive:** `email-archive/emails.json` — synced every 15 min by `scripts/email-sync.ts` (LaunchAgent `scripts/email-sync.plist`).
- **properties.json:** Required for interpreting `custom` field keys on projects. See field mapping table above.
- **Slack send:** `src/slack/actions.ts`, `src/slack/send.ts` — for posting reports and alerts.
- **Full sync:** `line-items.json` and `calls.json` require a full Coperniq sync (not `--quick`). Needed for Materials/BOM deep analysis.
- **Coperniq SKILL reference:** `skills/coperniq.io/SKILL.md` — cache layout and API details.
- **Performance Grading:** `skills/performance-grading/SKILL.md` — workload and communication metrics feed into employee grades.
- **JR Commands:** `skills/jr-commands/SKILL.md` — unified interactive command reference, natural language intent mapping, access control, and user identity resolution.
