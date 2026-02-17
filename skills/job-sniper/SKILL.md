---
name: job-sniper
description: "Monitor job boards for hiring signals that indicate sales opportunities. When a company posts 'Hiring Marketing Manager', they need help NOW and will spend $120K/yr. Pitch your AI agent/tool as a faster, cheaper alternative."
metadata: { "openclaw": { "emoji": "🎯", "requires": { "bins": ["curl"] } } }
---

# Job Sniper

Turn public job postings into sales leads. Every "Hiring: [Role]" post is a company admitting they have a problem and budget to solve it.

## Logic

```
Company posts "Hiring: Marketing Manager" ($120K/yr)
→ They need marketing help RIGHT NOW
→ They have budget ($120K/yr = $10K/mo)
→ Pitch: "Before you hire, try our AI agent at $500/mo that starts today"
```

## Target Job Titles

Map job titles to your product's value proposition:

```
Job Title                  → Your Pitch Angle
──────────────────────────────────────────────
Marketing Manager          → AI marketing automation
Content Writer             → AI content generation
SEO Specialist             → AI SEO agent
Social Media Manager       → AI social automation
Customer Support Rep       → AI support chatbot
Sales Development Rep      → AI outreach agent
Data Analyst               → AI analytics dashboard
Virtual Assistant          → AI personal assistant
Community Manager          → AI community engagement
Growth Hacker              → AI growth automation
```

## Job Board Monitoring

### Platforms to Monitor

```
LinkedIn Jobs      — linkedin.com/jobs
Indeed              — indeed.com
Glassdoor           — glassdoor.com
AngelList/Wellfound — wellfound.com
Hacker News         — news.ycombinator.com/item?id=whoishiring
RemoteOK            — remoteok.com
WeWorkRemotely      — weworkremotely.com
Greenhouse (boards) — boards.greenhouse.io
Lever (boards)      — jobs.lever.co
```

### Search Queries

```
"hiring [target role]" site:linkedin.com
"[target role]" site:wellfound.com
"marketing manager" OR "content writer" site:greenhouse.io
```

## Lead Qualification

Score each lead 1-5:

| Score | Criteria                                                          |
| ----- | ----------------------------------------------------------------- |
| 5     | Startup/SMB, exactly your product's domain, budget evident        |
| 4     | Mid-size company, strong overlap, likely decision-maker reachable |
| 3     | Good fit but large company (slower sales cycle)                   |
| 2     | Tangential fit, worth a cold email                                |
| 1     | Weak fit, skip                                                    |

Only pursue score 3+.

## Contact Discovery

For each qualified lead:

1. **Find the hiring manager**: Usually listed on the job post or the team page
2. **Find their boss**: The person who approved the budget (VP/Director/CEO)
3. **Find emails**: Use patterns like first@company.com, first.last@company.com
4. **Verify via web search**: Confirm the person and role

## Outreach Templates

### Template 1: Direct Pitch

```
Subject: Re: Your [Role] opening — AI alternative that starts today

Hi [Name],

Saw you're hiring a [Role]. Before you go through a 3-month hiring process,
worth considering: our AI [product] handles [key tasks] at $[price]/mo.

It's not a replacement for a great hire — but it can cover the gap while you
search, and keep running alongside them after.

[One specific result/proof point]

Happy to show you a 15-min demo this week?

[Your name]
```

### Template 2: Consultative Approach

```
Subject: Quick thought on your [Role] search

Hi [Name],

Noticed you're building out your [department] team. Curious question:
have you considered augmenting with AI before (or alongside) hiring?

We're seeing companies save $[amount]/mo by automating [specific tasks]
while their team focuses on strategy.

Not sure if it's a fit — but happy to share what's working for
[similar company/industry]. 15 min?

[Your name]
```

### Template 3: Social Proof

```
Subject: How [Similar Company] replaced their [Role] opening with AI

Hi [Name],

[Similar Company] was in the same position — looking for a [Role].
Instead, they tried our AI agent for [specific task]. Result: [specific metric].

They eventually hired too, but the AI handles [X%] of the volume now.

Worth a quick look? I can share their setup in a 10-min call.

[Your name]
```

## Rate Limits

- Max 30 outreach emails per day
- Max 20 LinkedIn connection requests per day
- Space out by 15-30 minutes
- Never email the same person twice within 14 days

## Output

Log to `$VIBECLAW_WORKSPACE/logs/job-sniper.jsonl`:

```json
{
  "timestamp": "2026-02-16T10:30:00Z",
  "company": "Acme Corp",
  "jobTitle": "Marketing Manager",
  "jobUrl": "https://...",
  "salary": "$120K",
  "contactName": "Jane Doe",
  "contactTitle": "VP Marketing",
  "contactEmail": "jane@acme.com",
  "leadScore": 4,
  "outreachTemplate": "direct_pitch",
  "status": "email_sent"
}
```
