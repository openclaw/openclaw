---
name: qenjin-outreach
description: LinkedIn DM generation, outreach tracking, follow-up automation.
user-invocable: true
disable-model-invocation: false
triggers:
  - /outreach
  - /dm
  - /follow-up
---

# qenjin-outreach

LinkedIn outreach pipeline. DM generation, funnel tracking, follow-up cycles.

Volume target: 25 connections/day. Track in Twenty CRM.

## On `/outreach today`

DM queue: connections accepted 24-48h ago needing first DM.

```bash
python3 -c "
import json, subprocess, os
from datetime import datetime, timedelta

TOKEN = os.environ.get('TWENTY_API_KEY', '')
BASE = 'https://crm.huda20.fun/rest/core'

# Get people with recent linkedIn connection (filter by updatedAt in last 48h)
cutoff_start = (datetime.utcnow() - timedelta(hours=48)).strftime('%Y-%m-%dT%H:%M:%S')
cutoff_end = (datetime.utcnow() - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%S')

r = subprocess.run([
    'curl', '-s', '-H', f'Authorization: Bearer {TOKEN}',
    f'{BASE}/people?limit=50'
], capture_output=True, text=True)

try:
    data = json.loads(r.stdout)
    people = data.get('data', {}).get('people', [])
    print(f'{len(people)} contacts in queue.')
    print('Review manually — filter by LinkedIn connection date.')
except:
    print('API error — check TWENTY_API_KEY.')
"
```

Reply: count first. List names needing DMs.

## On `/outreach dm [name]`

Generate personalized DM for an accepted LinkedIn connection.

Structure (connect-deep logic):
- Line 1: Specific observation about their work. Not generic.
- Line 2-3: Relevant detail. Specific to their role or company.
- Line 4: One sentence positioning. "We build video content systems for clinics and retreats."
- Line 5: Real question. Not rhetorical.
- Total: 4-6 lines.

Rules:
- No em dashes.
- No hype words (revolutionary, game-changing, incredible).
- No treatment claims.
- No patient references.
- Clinical peer respect throughout.
- First line must reference something real about them.

Example output:
```
Saw your panel at the Ketamine Research Foundation event last month. Sharp framing on provider burnout.

Most clinic owners I talk to spend 8-10 hours a week on content that gets 200 views. The ones systematically repurposing clinical education content see 5-8x that reach with half the time.

We build video content systems for clinics and retreats.

What does your content workflow look like right now?
```

If no context about the person is provided, ask: `Need context. What do they do? Recent post or event?`

## On `/outreach stats`

Funnel metrics.

Reply format:
```
Outreach funnel (this week):
  Connections sent: <n>
  Accepted: <n> (<rate>%)
  DMs sent: <n>
  Responses: <n> (<rate>%)
  Calls booked: <n>
```

Pull from Twenty CRM activity data or ask user for manual counts.

## On `/outreach follow-up`

Generate re-engagement DM for non-responders. 90-day cycle.

Rules:
- Reference original conversation thread if available.
- Lead with value (new data point, relevant article, industry shift).
- One question. Not "just checking in."
- 3-4 lines max.

Example:
```
FDA just moved psilocybin to Phase 3 review — 47 clinics in the expanded access program now. Changes the content calculus for providers in that space.

Still building out your clinic's video presence?
```

## Rules

- Numbers first, action second.
- 25 connections/day target. Track shortfall.
- Compliance: no treatment claims, no patient references, clinical peer respect.
- Never expose tokens or CRM IDs in DM text.
- All DMs must be personalized. If insufficient context, ask for it.
- "Done." is a complete response when appropriate.
