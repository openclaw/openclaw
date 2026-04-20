# Employee Performance Grading System

Automated scoring for ops team members (Sam, Clay, Daxton) across four weighted components. Scorecards are posted **weekly** and **monthly** to a private Slack channel for Ridge. Individual employees see only their own grade upon request via @JR. Composite grades feed directly into bonus decisions.

---

## 1. Composite Grade Formula

| Component                     | Weight | Data Source                 |
| ----------------------------- | ------ | --------------------------- |
| Coperniq (CRM Operations)     | 40%    | Coperniq API / local cache  |
| Slack Responsiveness          | 30%    | Slack message history       |
| Email Responsiveness          | 20%    | `email-archive/emails.json` |
| Proactive Communication Bonus | 10%    | Slack + Email (derived)     |

Weights are **identical for all employees**.

```
Composite = (Coperniq × 0.40) + (Slack × 0.30) + (Email × 0.20) + (Proactive × 0.10)
```

Each component is scored **0–100**. The composite maps to a letter grade for display:

| Letter | Score Range | Label   |
| ------ | ----------- | ------- |
| A      | 90–100      | Rowan   |
| B      | 80–89       | Runner  |
| C      | 70–79       | Carrier |
| D      | 60–69       | —       |
| F      | 0–59        | —       |

---

## 2. Project / Work Order Exclusion Rule

**Only projects with status `ACTIVE` are counted toward any scoring component.**

| Project Status | Include in grading?   |
| -------------- | --------------------- |
| `ACTIVE`       | Yes                   |
| `CANCELLED`    | No — exclude entirely |
| `ON_HOLD`      | No — exclude entirely |

This applies to **all Coperniq-derived signals**: completion rate, phase speed, and comment activity. Any work order whose parent project is not `ACTIVE` is dropped before scoring.

---

## 3. Coperniq Score (40%)

Measures CRM operational performance: are tasks getting done, are projects moving, is the employee engaged?

Three sub-dimensions, equally weighted within the 40%:

| Sub-dimension          | Internal weight | What it measures           |
| ---------------------- | --------------- | -------------------------- |
| Completion Rate        | 1/3             | WOs completed vs assigned  |
| Phase Transition Speed | 1/3             | Avg days per phase vs SLA  |
| Comment Activity       | 1/3             | Comments-per-project ratio |

```
coperniq_score = (completion_score + phase_speed_score + comment_score) / 3
```

### 3.1 Completion Rate

`completion_rate = WOs where isCompleted === true / total WOs assigned` (ACTIVE projects only, filtered by scoring window).

| Score  | Completion Rate |
| ------ | --------------- |
| 90–100 | 95%+            |
| 80–89  | 90–94%          |
| 70–79  | 80–89%          |
| 40–69  | 70–79%          |
| 0–39   | Below 70%       |

**Data:** `~/.openclaw/cache/coperniq/work-orders.json` — group by `assignee.email`, filter by `isCompleted`, cross-reference project status.

### 3.2 Phase Transition Speed

For each project owned by the employee (via `owner`, `salesRep`, or `projectManager`), compute days in each phase from `phaseInstances[].startedAt` → `completedAt`. Average across all completed phases in the scoring window.

| Score  | Avg Days per Phase                    |
| ------ | ------------------------------------- |
| 90–100 | Within green SLA (`< yellowSla` days) |
| 80–89  | Within yellow SLA (`< redSla` days)   |
| 70–79  | Up to 1.5× red SLA                    |
| 40–69  | Up to 2× red SLA                      |
| 0–39   | Exceeds 2× red SLA                    |

SLA thresholds come from `phaseTemplate.yellowSla` and `phaseTemplate.redSla` on each phase instance. When SLA data is absent, use absolute benchmarks: 90–100 = ≤3 days, 80–89 = ≤5 days, 70–79 = ≤8 days, 40–69 = ≤14 days, 0–39 = >14 days.

**Data:** `~/.openclaw/cache/coperniq/project-details.json` → `phaseInstances[]`.

### 3.3 Comment Activity

`comments_per_project = total comments by employee / count of ACTIVE projects they are assigned to`

| Score  | Comments per Project (per month) |
| ------ | -------------------------------- |
| 90–100 | 5+                               |
| 80–89  | 3–4                              |
| 70–79  | 2                                |
| 40–69  | 1                                |
| 0–39   | 0                                |

**Data:** `~/.openclaw/cache/coperniq/comments.json` — group by `createdByUser.email`, count per project.

> **Calibration note:** Coperniq sub-dimension weights (equal thirds) and rubric thresholds are initial proposals. Adjust after first full scoring run with real data.

---

## 4. Slack Responsiveness (30%)

Measures how quickly ops employees respond to sales rep messages in rep-specific channels.

### 4.1 What to Measure

For each message authored by a **sales rep** in a rep-specific channel (e.g. `#rep-john-doe`), find the **first reply from the ops employee** assigned to that channel. Compute the response time in minutes.

The score is based on the **rolling average response time** across all rep messages in the scoring window.

### 4.2 Grading Tiers

| Grade | Numeric Score | Avg Response Time |
| ----- | ------------- | ----------------- |
| A     | 95            | < 15 minutes      |
| B     | 85            | < 30 minutes      |
| C     | 75            | < 1 hour          |
| D     | 65            | < 2 hours         |
| F     | 30            | > 2 hours         |

### 4.3 Channel Scope

Monitor **all rep-specific channels** where ops employees are expected to respond. The channel list is maintained as configuration — each entry maps a channel ID to the rep user(s) and the ops employee(s) responsible.

```json
{
  "repChannels": [
    {
      "channelId": "C_EXAMPLE1",
      "channelName": "#rep-john-doe",
      "reps": ["U_REP1"],
      "ops": ["U0AB51A9J9H"]
    },
    {
      "channelId": "C_EXAMPLE2",
      "channelName": "#rep-jane-smith",
      "reps": ["U_REP2"],
      "ops": ["U0ABF0QGM0C"]
    }
  ]
}
```

> **Action required:** Populate the rep-channel config with actual Slack channel IDs and user mappings before first scoring run.

### 4.4 Implementation

1. For each rep channel, fetch message history for the scoring window (from Slack cache or live API).
2. Identify messages from rep user IDs.
3. For each rep message, find the next message in the same channel (or thread) from the assigned ops employee.
4. Compute `delta_minutes = (reply_ts - rep_message_ts) / 60`.
5. Average all deltas for each ops employee across all their assigned channels.
6. Map the average to the letter grade tier → numeric score.

**Slack API scopes needed:** `channels:history`, `groups:history`, `users:read`, `im:history`.

---

## 5. Email Responsiveness (20%)

Measures how quickly ops employees respond to emails and whether threads go unanswered.

Two sub-dimensions:

| Sub-dimension  | Internal weight | What it measures                   |
| -------------- | --------------- | ---------------------------------- |
| Response Speed | 75%             | Avg reply time to inbound emails   |
| Open Loop Rate | 25%             | Threads left unanswered > 24 hours |

```
email_score = (response_speed_score × 0.75) + (open_loop_score × 0.25)
```

### 5.1 Response Speed

For each email thread where the employee is involved: when a non-employee message arrives, measure time until the employee's next reply. Average all deltas for the scoring window.

| Grade | Numeric Score | Avg Response Time |
| ----- | ------------- | ----------------- |
| A     | 95            | < 15 minutes      |
| B     | 85            | < 30 minutes      |
| C     | 75            | < 1 hour          |
| D     | 65            | < 2 hours         |
| F     | 30            | > 2 hours         |

### 5.2 Open Loop Rate

An open loop = a thread where the employee was previously active, the most recent message is **not** from the employee, and it has been unanswered for > 24 hours at scoring time.

| Score  | Open Loops (per scoring period) |
| ------ | ------------------------------- |
| 90–100 | 0                               |
| 80–89  | 1–2                             |
| 70–79  | 3–5                             |
| 40–69  | 6–10                            |
| 0–39   | 11+                             |

**Data source:** `email-archive/emails.json` — group by `threadId`, sort by `date`, identify employee messages by sender email.

**Employee email addresses:**

| Employee | Email              |
| -------- | ------------------ |
| Sam      | sam@veropwr.com    |
| Clay     | clay@veropwr.com   |
| Daxton   | daxton@veropwr.com |

Skip automated senders: `notification@coperniq.io`, `noreply@`, `mailer-daemon`, `stripe.com`, `bill.com`, `powerclerk`, `scribehow`.

---

## 6. Proactive Communication Bonus (10%)

Rewards employees who initiate communication rather than only responding reactively.

### 6.1 What Counts as Proactive

- **Slack:** Messages that are **first in a thread** or **unprompted** (not a reply to a rep message or @mention) in monitored channels.
- **Email:** Outbound emails that **start a new thread** (not a reply).

### 6.2 Scoring

`proactive_rate = proactive_messages / total_messages` across Slack and Email combined for the scoring window.

| Score  | Proactive Rate |
| ------ | -------------- |
| 90–100 | 30%+           |
| 80–89  | 20–29%         |
| 70–79  | 15–19%         |
| 40–69  | 10–14%         |
| 0–39   | < 10%          |

> **Calibration note:** Proactive rate thresholds are initial proposals. Adjust after first scoring run with real data to ensure the rubric differentiates meaningfully.

---

## 7. Scoring Jobs

### 7.1 Data Sync (Daily)

Runs once per day (early morning). Ensures all data sources are fresh for scoring.

**Scripts and schedules:**

| Data Source | Script                             | Schedule                                                 | Cache                                      |
| ----------- | ---------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| Coperniq    | `scripts/coperniq-sync.ts --quick` | LaunchAgent every 15 min (`scripts/coperniq-sync.plist`) | `~/.openclaw/cache/coperniq/`              |
| Slack       | `scripts/slack-sync.ts`            | LaunchAgent every 15 min (`scripts/slack-sync.plist`)    | `~/.openclaw/cache/slack/{channelId}.json` |
| Email       | `scripts/email-sync.ts`            | LaunchAgent every 15 min (`scripts/email-sync.plist`)    | `email-archive/emails.json`                |

To install LaunchAgents: `cp scripts/*.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/ai.openclaw.*.plist`

### 7.2 Weekly Scorecard

Runs **every Monday morning**. Scores the previous calendar week (Monday–Sunday).

**Output format:**

```
Weekly Scorecard — Week of Mar 30, 2026

Sam LeSueur
  Coperniq: 82 | Slack: B (85) | Email: C (75) | Proactive: 70
  Composite: 80.2 → B (Runner)

Clay Neser
  Coperniq: 74 | Slack: C (75) | Email: B (85) | Proactive: 65
  Composite: 75.0 → C (Carrier)

Daxton Dillon
  Coperniq: 88 | Slack: B (85) | Email: B (85) | Proactive: 80
  Composite: 85.5 → B (Runner)
```

**Delivery:** Posted to Ridge's private Slack channel.

### 7.3 Monthly Scorecard

Runs on the **1st of each month**. Scores the previous calendar month. Same format as weekly but with monthly period label and averages over the full month.

**Delivery:** Posted to Ridge's private Slack channel.

### 7.4 Score Storage

Each scoring run writes a snapshot to `~/.openclaw/cache/grading/`:

```json
{
  "period": "2026-03-30 → 2026-04-05",
  "type": "weekly",
  "employees": {
    "sam": {
      "coperniq": 82,
      "slack": 85,
      "email": 75,
      "proactive": 70,
      "composite": 80.2,
      "grade": "B"
    }
  }
}
```

File naming: `weekly/YYYY-MM-DD.json`, `monthly/YYYY-MM.json`.

---

## 8. Output & Delivery

### 8.1 Ridge: Private Channel Scorecards

Weekly and monthly scorecards are posted to a **private Slack channel** visible only to Ridge. Use the `channel:<ID>` format (channel ID to be configured).

### 8.2 Employees: Grade on Request

When an employee messages `@JR` asking for their grade, JR responds with **only that employee's** current scores. Never reveal other employees' grades.

Example response:

```
Your current scores (week of Mar 30):
  Coperniq: 82 | Slack: B | Email: C | Proactive: 70
  Composite: 80.2 → B (Runner)
```

---

## 9. Employee Reference Data

### 9.1 Coperniq IDs

| Name          | Email                       | Coperniq ID |
| ------------- | --------------------------- | ----------- |
| Ridge Payne   | ridge@veropwr.com           | 14200       |
| Sam LeSueur   | sam@veropwr.com             | 14206       |
| Clay Neser    | clay@veropwr.com            | 14204       |
| Daxton Dillon | daxton@veropwr.com (verify) | 14205       |

### 9.2 Slack User IDs

| Employee      | Slack User ID                              |
| ------------- | ------------------------------------------ |
| Sam LeSueur   | `U0AB51A9J9H`                              |
| Clay Neser    | `U0ABF0QGM0C`                              |
| Daxton Dillon | `U0AB9B36PM4`                              |
| Ridge Payne   | `U096S2FQTUZ` (not graded — for reference) |

---

## 10. Data Sources

| Component       | Primary Source                                                                        | Key Signals                                    |
| --------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Coperniq        | `~/.openclaw/cache/coperniq/` (work-orders.json, project-details.json, comments.json) | Completion rate, phase speed, comment activity |
| Slack           | `~/.openclaw/cache/slack/{channelId}.json` (pulled daily)                             | Rep message → ops reply time                   |
| Email           | `email-archive/emails.json` — group by `threadId`, sort by `date`                     | Response speed, open loop rate                 |
| Proactive Bonus | Slack cache + email archive (derived)                                                 | First-in-thread rate, unprompted outreach      |

**Full API details:** `skills/coperniq.io/references/performance-grading-apis.md`

---

## 11. Operational Rules

### 11.1 Override Rule

Ridge can manually override any employee's score with a written reason.

- Override is **logged** in the scoring snapshot with timestamp and note.
- Employee receives a **private DM** with the override value and reason.

### 11.2 OpenClaw Execution Rule

If OpenClaw executes a task autonomously because the employee did not respond, the employee receives **zero credit** on that work order for the Coperniq component. The pipeline moves forward but the employee does not earn the grade.

---

## Appendix A: Bonus / Tier Model (Pending Confirmation)

> The engineering brief states that composite grades "feed directly into bonus decisions." The tier and payout model below is carried forward from prior development and retained here pending confirmation from later sections of the brief. Do not implement payout logic until confirmed.

### Bonus Calculation Models

Run **both models in parallel** every quarter. Report both to Ridge privately. Ridge decides which to pay.

**Model A — Averaged Score:** All projects pool into one composite → one tier → one payout rate × PTOs closed.

**Model B — Per Project:** Each PTO pays at the tier that specific project scored. Same employee can have mixed tiers in one quarter.

### Quarterly Report

Posts on the **first Monday of each new quarter** as a private Slack DM to Ridge.

---

## Dependencies

- **Coperniq:** `COPERNIQ_API_KEY` — work orders, projects, phase instances, comments.
- **Slack:** Existing bot token — `src/slack/actions.ts`, `src/slack/send.ts`. Additional scopes for rep channels: `channels:history`, `groups:history`, `users:read`, `im:history`.
- **Email:** `email-archive/emails.json` — must be kept current via Gmail sync.
- **Slack Canvas API** (separate from grading): `canvases:write`, `canvases:read` — for rep stat boards (see brief §3.3).
- Ridge's Slack user ID for private DM delivery (see AGENTS.md).
- Rep-channel config with channel IDs and user mappings (see §4.3).
- **JR Commands:** `skills/jr-commands/SKILL.md` — unified interactive command reference, natural language intent mapping, and access control for grade requests.
