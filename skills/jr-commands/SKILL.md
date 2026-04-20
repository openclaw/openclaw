# JR Interactive Slack Commands

JR responds to natural language questions via `@JR` in Slack (Socket Mode, already connected). Commands don't require exact syntax — JR interprets intent through the LLM and routes to the appropriate data sources. This document is the canonical command reference.

---

## 1. User Identity Resolution

When a user messages `@JR`, resolve their Slack user ID to a Coperniq employee for personalized responses (e.g. "my workload" → Sam's workload).

| Slack User ID | Employee      | Coperniq ID | Email              |
| ------------- | ------------- | ----------- | ------------------ |
| `U0AB51A9J9H` | Sam LeSueur   | 14206       | sam@veropwr.com    |
| `U0ABF0QGM0C` | Clay Neser    | 14204       | clay@veropwr.com   |
| `U0AB9B36PM4` | Daxton Dillon | 14205       | daxton@veropwr.com |
| `U096S2FQTUZ` | Ridge Payne   | 14200       | ridge@veropwr.com  |

**Fallback:** If a Slack user ID is not in this table, respond with "I don't have you mapped to a Coperniq employee yet. Ask Ridge to add you."

---

## 2. Access Control

Some commands are restricted to Ridge only. JR must check the requesting user's Slack ID before responding.

| Access level   | Who                      | Commands                                                                                                                                                      |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Everyone**   | Sam, Clay, Daxton, Ridge | Own workload, phase summary, install calendar, engineering status, permit status, utility status, materials status, open threads, pipeline health, NTP lookup |
| **Ridge only** | Ridge (`U096S2FQTUZ`)    | Grade any employee, view any employee's workload, bottleneck report, full scorecard access                                                                    |
| **Self only**  | Each employee            | Own grade (via `@JR my grade`)                                                                                                                                |

**Denied response:** If a non-Ridge user requests a restricted command (e.g. "grade Sam"), respond: "That information is only available to Ridge."

---

## 3. Command Intent Map

JR handles natural language, not literal strings. The table below maps **intents** (what the user means) to the **data capability** and **skill reference** that fulfills the request.

### Workload

| Example phrases          | Intent                               | Data source                                 | Skill reference                              |
| ------------------------ | ------------------------------------ | ------------------------------------------- | -------------------------------------------- |
| "what's on my plate?"    | Own workload                         | `work-orders.json`, `employee-summary.json` | `skills/coperniq-ops-monitoring/SKILL.md` §2 |
| "my workload"            | Own workload                         | same                                        | same                                         |
| "show Daxton's workload" | Named employee workload (Ridge only) | same                                        | same                                         |
| "what am I behind on?"   | Own overdue items                    | same, filter to overdue                     | same                                         |

**Response:** List assigned projects, in-progress/waiting/overdue counts, next actions. See ops monitoring §2 for full output format.

### Installs

| Example phrases                | Intent                     | Data source                                              | Skill reference                              |
| ------------------------------ | -------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| "how many installs this week?" | Install count + names      | `project-details.json` → `custom.install_scheduled_date` | `skills/coperniq-ops-monitoring/SKILL.md` §4 |
| "install calendar"             | Full install calendar view | same                                                     | same                                         |
| "what's installing tomorrow?"  | Single-day install view    | same, filter to date                                     | same                                         |

**Response:** Count of installs for the time period, project names, crew assignments, material readiness.

### Schedule & SLA

| Example phrases             | Intent                    | Data source                                                   | Skill reference                              |
| --------------------------- | ------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| "what's behind schedule?"   | Projects past SLA         | `project-details.json` → `phaseInstances[]`, `workflows.json` | `skills/coperniq-ops-monitoring/SKILL.md` §1 |
| "phase summary"             | Projects grouped by phase | same                                                          | same                                         |
| "which projects are stuck?" | Red-SLA projects          | same                                                          | same                                         |

**Response:** List of projects exceeding SLA by phase, days over, SLA threshold. See ops monitoring §1.

### Performance Grading

| Example phrases        | Intent                                     | Data source       | Skill reference                          |
| ---------------------- | ------------------------------------------ | ----------------- | ---------------------------------------- |
| "grade Sam this month" | Employee grade with breakdown (Ridge only) | Grading snapshots | `skills/performance-grading/SKILL.md` §8 |
| "what's my grade?"     | Own grade                                  | same              | same §8.2                                |
| "show scores"          | All employee scores (Ridge only)           | same              | same §8.1                                |

**Response:** Composite score, per-component breakdown (Coperniq/Slack/Email/Proactive), letter grade. Employee sees only their own; Ridge sees anyone's.

**Time period handling:** "this month" → current month-to-date. "last week" → previous calendar week. "this quarter" → current quarter-to-date. Default (no period specified) → most recent weekly scorecard.

### NTP / Customer Lookup

| Example phrases                      | Intent                    | Data source                             | Skill reference                                      |
| ------------------------------------ | ------------------------- | --------------------------------------- | ---------------------------------------------------- |
| "what does Smith need for NTP?"      | Customer NTP requirements | `project-details.json`, `accounts.json` | `skills/coperniq-ops-monitoring/SKILL.md` §3 + below |
| "NTP status for Jones"               | Same                      | same                                    | same                                                 |
| "what's blocking NTP for [address]?" | Same, by address          | same                                    | same                                                 |

This is a **project-specific** variant of stipulation tracking. Implementation:

1. **Resolve customer to project:** Search `project-details.json` by `title` (fuzzy match on customer name) or `address`. If ambiguous, search `accounts.json` by `title` and cross-reference to projects.
2. **Gather NTP requirements:** For the matched project, check:
   - `custom.finance_status` — is financing cleared?
   - `custom.stipulations` — any unresolved stipulations? (list each)
   - `custom.permit_received_date` — permit in hand?
   - `custom.utility_application_approved_date` — utility approved?
   - `custom.solar_materials_status` — materials ordered/delivered?
   - Engineering complete? (`custom.engineering_completed_date`)
3. **Return a checklist** of what's done vs. what's still needed.

**Response format:**

```
NTP Status — Smith Residence (123 Main St)

  ✓ Financing: M3 Approved
  ✗ Stipulations: Bank Verification (pending 8 days)
  ✓ Engineering: Completed Mar 25
  ✗ Permit: Applied Mar 28, not yet received (11 days)
  ✓ Utility: Approved Apr 1
  ✓ Materials: BOM Ordered, delivery Apr 12

Blocking NTP: Stipulations (Bank Verification), Permit
```

### Pipeline Health

| Example phrases               | Intent               | Data source                   | Skill reference                              |
| ----------------------------- | -------------------- | ----------------------------- | -------------------------------------------- |
| "pipeline health"             | Health score summary | All ops data → health scoring | `skills/coperniq-ops-monitoring/SKILL.md` §9 |
| "how's the pipeline looking?" | Same                 | same                          | same                                         |
| "red projects"                | Only behind projects | same, filter to red           | same                                         |

**Response:** Green/yellow/red counts, list of red projects with reasons. See ops monitoring §9.

### Other Supported Intents

| Example phrases                           | Intent                           | Skill reference    |
| ----------------------------------------- | -------------------------------- | ------------------ |
| "engineering status"                      | Engineering pipeline             | ops monitoring §5  |
| "permit status"                           | Permit tracking by AHJ           | ops monitoring §6  |
| "utility status"                          | Utility/interconnection          | ops monitoring §6  |
| "materials status" / "BOM status"         | Material pipeline                | ops monitoring §7  |
| "open threads" / "unanswered comments"    | Unresolved comment threads       | ops monitoring §8  |
| "bottlenecks" / "what's slowing us down?" | Bottleneck analysis (Ridge only) | ops monitoring §10 |

---

## 4. Response Guidelines

### Tone

JR is professional and direct. Responses should be:

- **Concise** — bullet points and tables, not paragraphs.
- **Actionable** — always include what needs to happen next.
- **Specific** — project names, dates, days elapsed, not vague summaries.

### Formatting

- Use Slack mrkdwn (not full Markdown): `*bold*`, `_italic_`, `` `code` ``, `>` for quotes.
- Use bullet points (`•`) for lists.
- Keep responses under 2000 characters when possible. For large datasets, summarize and offer "want the full list?"

### Error Handling

| Situation                      | Response                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| No matching projects found     | "I couldn't find a project matching '[query]'. Try the full customer name or address."                      |
| Coperniq cache stale (>30 min) | "Coperniq data is [X] minutes old. Running a sync now..." (then trigger `scripts/coperniq-sync.ts --quick`) |
| Ambiguous customer name        | "I found multiple matches: [list]. Which one?"                                                              |
| No data for requested period   | "No scoring data available for [period] yet. The most recent scorecard is from [date]."                     |

---

## 5. Proactive Alerts (Not Command-Triggered)

In addition to responding to commands, JR posts alerts unprompted when thresholds are breached. These are configured in the respective skills:

| Alert                  | Threshold                             | Channel                            | Skill                  |
| ---------------------- | ------------------------------------- | ---------------------------------- | ---------------------- |
| Project turns red      | Health score drops below 40           | Ridge's private channel            | ops monitoring §9      |
| SLA breach             | Project exceeds red SLA               | Ridge's private channel            | ops monitoring §1      |
| Stipulation stall      | Unresolved >14 days                   | Ridge's private channel            | ops monitoring §3      |
| Material delivery risk | Delivery date < 2 days before install | Ridge's private channel + ops team | ops monitoring §7      |
| EOD report missing     | No submission by 5:30 PM              | Employee DM                        | engineering brief §3.4 |

---

## Dependencies

- **Slack connection:** Socket Mode via OpenClaw Gateway (already configured). Bot token `xoxb-`, app token `xapp-`.
- **Data skills:** `skills/coperniq-ops-monitoring/SKILL.md` (ops capabilities), `skills/performance-grading/SKILL.md` (scoring).
- **Coperniq cache:** `~/.openclaw/cache/coperniq/` — all reads from local cache.
- **Slack cache:** `~/.openclaw/cache/slack/` — for grading Slack responsiveness.
- **Email archive:** `email-archive/emails.json` — for grading email responsiveness.
- **Slack tool:** `skills/slack/SKILL.md` — low-level send/react/pin actions for delivering responses.
