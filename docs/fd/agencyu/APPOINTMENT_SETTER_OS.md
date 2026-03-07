# Appointment Setter OS

## Overview

Hybrid model: automation for speed + tagging, humans for rapport + booking.
Even if the founder is the only setter, the system surface enforces accountability and makes the role delegatable later.

## Daily Workflow Blocks

| Block         | Time        | Activity                                      |
|---------------|-------------|-----------------------------------------------|
| Morning       | 9:00–10:00  | Review hot leads queue, send opening DMs       |
| Midday        | 12:00–13:00 | Follow up on conversations, handle objections  |
| Afternoon     | 15:00–16:00 | Second follow-up pass, booking nudges          |
| EOD           | 17:00–17:30 | Complete EOD form, review metrics              |

## Give / Give / Give Script Framework

The setter leads with value before asking for anything:

1. **Give 1**: Acknowledge their situation — show you understand their pain
2. **Give 2**: Share a relevant result (case study, before/after, metric)
3. **Give 3**: Offer a specific, low-commitment next step (free audit, strategy call)
4. **Ask**: "Would it make sense to hop on a quick call to see if we can help?"

Scripts are templated per segment (revenue tier + pain tags).

## EOD Form Fields

| Field                  | Type    | Description                           |
|------------------------|---------|---------------------------------------|
| `date`                 | date    | Report date                           |
| `dms_sent`             | int     | Total DMs sent                        |
| `convos_started`       | int     | New conversations initiated           |
| `followups_sent`       | int     | Follow-up messages sent               |
| `appointments_booked`  | int     | Calls successfully booked             |
| `appointments_showed`  | int     | Calls that actually happened          |
| `no_shows`             | int     | Booked but didn't show                |
| `notes`                | text    | Free-form observations                |

## KPIs + Thresholds

| KPI                    | Target    | Warning Threshold |
|------------------------|-----------|-------------------|
| DMs sent / day         | 30+       | < 15              |
| Convos started / day   | 10+       | < 5               |
| Book rate (convos→booked) | 20%+  | < 10%             |
| Show rate              | 70%+      | < 50%             |
| Close rate (showed→won)| 30%+      | < 15%             |

## Hot Leads Queue

Leads are surfaced as "hot" when:
- Tagged `status:qualified` in ManyChat but not yet `status:booked`
- Have engaged in last 48 hours (DM reply, page visit, etc.)
- Not in cooldown (recently contacted within 24h)

## Admin Actions

| Action                  | Effect                                |
|-------------------------|---------------------------------------|
| Mark followup sent      | Logs followup, updates last_contact   |
| Mark booked             | Updates status tag, creates booking   |
| Mark no-show            | Updates status, triggers rescue flow  |

## Safety

- All external calls (ManyChat tag updates, GHL contact updates) respect `DRY_RUN` / `SAFE_MODE`
- Setter activity is audit-logged
- No automated DM sending without human trigger
