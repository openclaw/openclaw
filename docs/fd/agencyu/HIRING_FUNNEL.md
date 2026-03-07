# Hiring Funnel

## Overview

Hiring treated as a funnel: job description 2.0 with KPIs, structured intake form, Loom response screening, and calibrated interviews.
Ties into the internal assignment engine for capacity-aware work distribution.

## JD 2.0 Format

Each role definition includes:

| Field                | Description                                    |
|----------------------|------------------------------------------------|
| `role_id`            | Unique role identifier                         |
| `title`              | Role title (e.g., "Senior Motion Designer")    |
| `description`        | What the role does (outcome-focused)           |
| `kpis`               | Measurable performance indicators              |
| `deliverables`       | What they produce per cycle                    |
| `tools_required`     | Software proficiency requirements              |
| `capacity_units`     | How many client boards they can handle         |
| `compensation_range` | Pay range or per-deliverable rate              |

## KPI Schema

| KPI                    | Target    | Measurement Period |
|------------------------|-----------|--------------------|
| Deliverables / week    | Role-specific | Weekly           |
| On-time delivery rate  | 90%+      | Monthly            |
| Revision rate          | < 20%     | Monthly            |
| Client satisfaction    | 4.5+ / 5  | Per project        |
| Response time          | < 4h      | Daily              |

## Intake Form Schema

Applicants submit:

| Field                  | Type      | Required |
|------------------------|-----------|----------|
| `name`                 | text      | Yes      |
| `email`                | email     | Yes      |
| `portfolio_url`        | url       | Yes      |
| `role_applied`         | select    | Yes      |
| `years_experience`     | int       | Yes      |
| `tools_proficiency`    | multiselect | Yes   |
| `availability_hours`   | int       | Yes      |
| `rate_expectation`     | text      | Yes      |
| `loom_url`             | url       | Yes      |

## Loom Response Rubric

Applicants record a 3–5 minute Loom covering:

| Criteria               | Weight | Scoring (1–5)                       |
|------------------------|--------|-------------------------------------|
| Communication clarity  | 25%    | Can they explain their process?     |
| Portfolio quality      | 30%    | Does work match our standard?       |
| Tool proficiency       | 20%    | Comfortable with required tools?    |
| Culture fit            | 15%    | Professional, proactive, coachable? |
| Availability match     | 10%    | Hours align with our needs?         |

## Capacity Planning

- Each role has a `capacity_units` value (e.g., 1 unit = 1 client board)
- The assignment engine tracks current load per team member
- New hires are needed when: `total_boards > sum(capacity_units) * 0.8`
- Hiring pipeline should have candidates ready before capacity crunch

## Integration with Internal Board

- Hired team members are added to the internal fulfillment Trello board
- Assignment labels (`Assigned: {name}`) auto-applied per existing system
- Workload visible via admin UI

## Safety

- No automated hiring decisions — system surfaces candidates and scores
- All applicant data handled with care (no external sharing)
- Intake webhook endpoint added later (not in v1 scaffolding)
