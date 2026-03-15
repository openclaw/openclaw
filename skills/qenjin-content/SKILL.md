---
name: qenjin-content
description: Content pipeline — weekly calendar, clip extraction, draft generation, performance stats.
user-invocable: true
disable-model-invocation: false
triggers:
  - /content
  - /clips
  - /schedule
---

# qenjin-content

Content pipeline management for Hudafilm. Substack, LinkedIn, Instagram, Mautic.

Minimum volume: 1 Substack/wk, 4 Reels/wk, 2 LinkedIn/wk.

## On `/content plan`

This week's content calendar.

Reply format:
```
Week of <date>
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tue: Substack article — <topic>
Wed: 2 Reels + 1 LinkedIn post
Thu: 2 Reels + Mautic newsletter
Fri: 1 LinkedIn post
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Delivered: <n>/9   Behind: <n>
```

Check existing content state:

```bash
python3 -c "
from datetime import datetime, timedelta
today = datetime.now()
monday = today - timedelta(days=today.weekday())
sunday = monday + timedelta(days=6)
print(f'Week: {monday.strftime(\"%b %d\")} — {sunday.strftime(\"%b %d, %Y\")}')
print()
print('Tue: Substack article')
print('Wed: 2 Reels + 1 LinkedIn post')
print('Thu: 2 Reels + Mautic newsletter')
print('Fri: 1 LinkedIn post')
print()
print('9 deliverables total.')
"
```

Fill in topics based on conversation context or ask user.

## On `/content extract [url]`

Extract 4 clip scripts from a Substack article.

```bash
python3 -c "
import sys
url = sys.argv[1] if len(sys.argv) > 1 else ''
if not url:
    print('Usage: /content extract <substack-url>')
    exit()
print(f'Extracting clips from: {url}')
print()
print('Clip 1 — Number Hook (30-45s)')
print('  Format: lead with the hardest number, one stat, one implication')
print()
print('Clip 2 — Myth vs Fact (45-60s)')
print('  Format: state the myth, pause, deliver the data that breaks it')
print()
print('Clip 3 — Science Plain (60-90s)')
print('  Format: mechanism explained at grade 7 level, one analogy')
print()
print('Clip 4 — Local Angle (45-60s)')
print('  Format: South Dakota/Sioux Falls connection, why it matters here')
" <url>
```

After fetching article content (use Apify RAG browser or curl), generate 4 scripts following these rules:
- Number hook: 30-45s. Most important number first sentence.
- Myth vs fact: 45-60s. Common misconception, then data correction.
- Science plain: 60-90s. Mechanism in plain language. One analogy max.
- Local angle: 45-60s. South Dakota or Sioux Falls tie-in.

Voice: calm, precise. No em dashes. No hype. Short sentences land facts.

## On `/content draft linkedin [topic]`

Generate LinkedIn post. Two angles allowed:
1. Data insight from psychedelic therapeutics / wellness tech
2. OpenBodhi builder angle (what we shipped, what we learned)

Rules:
- Hook line under 15 words.
- 3-5 short paragraphs.
- End with a question or clear CTA.
- No em dashes. No "this isn't just X, it's Y" patterns.
- Numbers and data first when available.

Reply: the draft, ready to paste.

## On `/content draft ig [topic]`

Generate Instagram caption.

Rules:
- Under 150 words.
- First line is the hook (visible before "more").
- 2-3 body lines max.
- 3-5 relevant hashtags at the end.
- No em dashes. Buddhist writer tone.

Reply: the caption, ready to paste.

## On `/content stats`

Query Plausible Analytics for this week's content performance.

```bash
python3 -c "
import subprocess, json, os
from datetime import datetime, timedelta

today = datetime.now()
monday = today - timedelta(days=today.weekday())
date_from = monday.strftime('%Y-%m-%d')
date_to = today.strftime('%Y-%m-%d')

# Plausible API
TOKEN = os.environ.get('PLAUSIBLE_API_KEY', '')
SITE = 'hudafilm.com'
BASE = 'https://analytics.huda20.fun'

r = subprocess.run([
    'curl', '-s',
    '-H', f'Authorization: Bearer {TOKEN}',
    f'{BASE}/api/v1/stats/aggregate?site_id={SITE}&period=custom&date={date_from},{date_to}&metrics=visitors,pageviews,bounce_rate,visit_duration'
], capture_output=True, text=True)

try:
    data = json.loads(r.stdout)
    results = data.get('results', {})
    visitors = results.get('visitors', {}).get('value', 0)
    pageviews = results.get('pageviews', {}).get('value', 0)
    bounce = results.get('bounce_rate', {}).get('value', 0)
    duration = results.get('visit_duration', {}).get('value', 0)
    print(f'Visitors: {visitors}')
    print(f'Pageviews: {pageviews}')
    print(f'Bounce rate: {bounce}%')
    print(f'Avg duration: {duration}s')
except:
    print('Stats unavailable — check PLAUSIBLE_API_KEY.')
"
```

Reply: numbers only. No commentary unless asked.

## Rules

- Deliverable items with deadlines. No filler.
- Voice in all drafts: calm, clear, precise. Buddhist writer tone.
- No em dashes anywhere in generated content.
- No "this isn't just X, it's Y" patterns. No hype escalation.
- Reading level: grade 7-8. Technical only where precision requires.
- Section divider for Substack: `https://hudafilm-media.nbg1.your-objectstorage.com/assets/dividers/paragraph-splitter.png`
- Numbers first: p-values, vote counts, dollar figures, dates.
- "Done." is a complete response when appropriate.
