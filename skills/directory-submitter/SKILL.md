---
name: directory-submitter
description: "Submit your product to 100+ startup directories, review sites, and aggregators. Adapts descriptions per platform. Staggers submissions over weeks for natural discovery. Tracks approval status."
metadata: { "openclaw": { "emoji": "📋", "requires": { "bins": ["curl"] } } }
---

# Directory Submitter

Automatically submit your product to 100+ directories, review sites, and aggregators with adapted descriptions and staggered timing.

## Workflow

1. **Load product info** from Vibeclaw config
2. **Select directories** based on product category
3. **Adapt description** for each directory's format and audience
4. **Submit** via web forms or APIs
5. **Track** submission status and approvals
6. **Follow up** on pending submissions

## Directory Registry

### Tier 1 — High Impact (submit first)

```
Product Hunt        — producthunt.com
BetaList           — betalist.com
Hacker News        — news.ycombinator.com (Show HN)
IndieHackers       — indiehackers.com/products
AlternativeTo      — alternativeto.net
G2                 — g2.com
Capterra           — capterra.com
TrustRadius        — trustradius.com
GetApp             — getapp.com
Software Advice    — softwareadvice.com
```

### Tier 2 — Startup Directories

```
DevHunt            — devhunt.org
Uneed              — uneed.best
LaunchingNext      — launchingnext.com
BetaPage           — betapage.co
StartupStash       — startupstash.com
SaaSHub            — saashub.com
StartupBase        — startupbase.com
Launching Next     — launchingnext.com
KillerStartups     — killerstartups.com
StartupRanking     — startupranking.com
StartupBuffer      — startupbuffer.com
Land-book          — land-book.com
Startup Lift       — startuplift.com
```

### Tier 3 — AI/Tech Specific

```
Futurepedia        — futurepedia.io
There's An AI      — theresanaiforthat.com
AI Tool Directory  — aitoolsdirectory.com
TopAI.tools        — topai.tools
ToolPilot          — toolpilot.ai
AIcyclopedia       — aicyclopedia.com
FutureTools        — futuretools.io
AI Scout           — aiscout.net
```

### Tier 4 — SEO and Link Building

```
Crunchbase         — crunchbase.com
AngelList          — angel.co
F6S                — f6s.com
Gust               — gust.com
SaaSWorthy         — saasworthy.com
SourceForge        — sourceforge.net
Slant              — slant.co
StackShare         — stackshare.io
```

### Tier 5 — Review Sites

```
Trustpilot         — trustpilot.com
G2                 — g2.com
Capterra           — capterra.com
TrustRadius        — trustradius.com
SoftwareSuggest    — softwaresuggest.com
CompareCamp        — comparecamp.com
FinancesOnline     — financesonline.com
```

## Description Adaptation

Each directory needs a different description style:

**Product Hunt**: Punchy, benefit-first. "We built X because Y. It does Z in half the time."

**G2/Capterra**: Professional, feature-complete. List all features, integrations, pricing tiers.

**BetaList**: Early-stage excitement. "Just launched! [Product] helps [audience] do [thing] faster."

**AlternativeTo**: Position as alternative. "Like [Competitor] but with [key differentiator]."

**HackerNews (Show HN)**: Technical, honest, no hype. "Show HN: [Product] — [what it does]. Built with [tech stack]. [Link]"

## Submission Schedule

Stagger submissions to look organic:

```
Week 1: Product Hunt, BetaList, IndieHackers, DevHunt (4)
Week 2: AlternativeTo, SaaSHub, StartupStash, Uneed (4)
Week 3: AI directories batch (6-8)
Week 4: Review sites (submit for listing) (4-6)
Week 5-8: Remaining directories (5-10/week)
```

Never submit to more than 10 directories in a single day.

## Tracking

Store submission status in `$VIBECLAW_WORKSPACE/data/directory-submissions.json`:

```json
[
  {
    "directory": "Product Hunt",
    "url": "https://producthunt.com",
    "submittedAt": "2026-02-16",
    "status": "approved",
    "listingUrl": "https://producthunt.com/posts/...",
    "category": "tier1"
  }
]
```

Status values: `pending`, `submitted`, `approved`, `rejected`, `follow_up_needed`

## Follow-Up Strategy

For directories that require manual review:

- Wait 5-7 days after submission
- Check if listing is live
- If not, send polite follow-up email
- If rejected, adjust description and resubmit once
