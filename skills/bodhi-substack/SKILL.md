---
name: bodhi-substack
description: Full investigative article engine for weekly Substack posts — psychedelic therapeutics, mental health policy, wellness. Research, write, checklist, save draft, extract clips. Feeds n8n workflow.
user-invocable: true
disable-model-invocation: false
triggers:
  - /article
  - /research
  - /substack
  - /clips
---

# bodhi-substack

Full Substack article pipeline for the weekly psychedelic therapeutics / conscious wellness publication. Buddhist writer voice. 12-section investigative template. South Dakota grounded.

Template file: `~/Desktop/substack-research-template.json` (canonical spec — read it if you need to re-anchor on structure).
Drafts saved to: `~/.openclaw/substack-drafts/`
SiYuan notebook: `OpenBodhi-Substack`
Divider image: `![](https://YOUR_S3_BUCKET.nbg1.your-objectstorage.com/assets/dividers/paragraph-splitter.png)`

---

## On `/article <topic> [bill=X] [drug=X] [state=SD] [angle=X] [exclude=X]`

Full article generation. Research first, write second, checklist third, output fourth.

Parse parameters from the message:
- `topic` — required. The main subject.
- `bill=` — optional. Legislative bill identifier (e.g. `bill=HB1099`)
- `drug=` — optional. Primary compound (e.g. `drug=COMP360`)
- `state=` — optional. Defaults to `South Dakota`
- `angle=` — optional. Specific editorial hook
- `exclude=` — optional. Topics already covered recently

Get current date context:

```bash
python3 -c "
from datetime import datetime, timedelta
now = datetime.now()
week_start = now - timedelta(days=now.weekday())
print('current_week:', week_start.strftime('week of %B %-d %Y'))
print('current_month:', now.strftime('%B'))
print('current_year:', now.year)
"
```

---

### PHASE 1 — RESEARCH (section by section)

For each section below, search the web using the provided query examples. Use Apify MCP RAG browser where available; fall back to WebSearch. Minimum 3 unique sources per section. Prefer peer-reviewed journals, FDA communications, government data over press releases or advocacy org self-reports.

Source priority order:
1. Peer-reviewed journals — PubMed, NEJM, Lancet, JAMA
2. FDA official communications
3. Government data — SD Dept of Health, VA, CDC
4. Company investor relations (verified press releases only)
5. STAT News, BioPharma Dive, Psychedelic Alpha
6. Major news — Reuters, NPR, CNN
7. Market research firms — Precedence Research, Grand View Research

Flag any source older than 2 years. Reject any source that cannot be URL-verified.

**S1 — Headline + Hook**
Find the single most newsworthy data point, vote, approval, study result, or event from this week on the topic.
Queries:
- `{topic} latest news {current_week}`
- `{topic} FDA update {current_month} {current_year}`
- `{topic} South Dakota {current_month} {current_year}`

**S2 — Human Cost**
Find mortality stats, treatment failure rates, veteran/first responder data, population-level mental health burden. South Dakota-specific data first; national second; global only if no US data.
Queries:
- `South Dakota suicide statistics {current_year}`
- `treatment resistant depression prevalence statistics {current_year}`
- `veteran PTSD suicide rate {current_year}`
- `antidepressant failure rate treatment resistant depression`

**S3 — What It Actually Does**
Find exact bill language, specific drug mechanism, regulatory category, what changes and what stays the same.
Queries:
- `{bill_number} {state} full text {current_year}`
- `{drug_name} schedule reclassification what it means`
- `{topic} what it does and does not do explained`

**S4 — The Science**
Find Phase 2/3 trial results. Required data: p-value, primary endpoint metric and scale, difference from placebo, response rate %, duration of effect, adverse events.
Queries:
- `{drug_name} phase 3 results {current_year} primary endpoint`
- `{drug_name} MADRS score clinical trial data`
- `{drug_name} effect size clinical significance debate`
- `{drug_name} safety tolerability adverse events`

**S5 — FDA / Regulatory Timeline**
Find FDA meeting dates, NDA submission timelines, breakthrough therapy status, PDUFA dates.
Queries:
- `{drug_name} FDA submission timeline {current_year}`
- `{drug_name} NDA rolling submission FDA meeting`
- `FDA psilocybin approval date expected {current_year}`
- `{drug_name} PDUFA date FDA decision`

**S6 — What Went Wrong Before**
Find prior FDA rejections, retracted studies, trial design failures, adverse event controversies.
Queries:
- `MAPS MDMA FDA rejection what went wrong 2024`
- `{drug_name} prior setbacks FDA criticism`
- `psychedelic therapy trial design problems blinding issues`
- `Lykos Therapeutics complete response letter FDA`

**S7 — The Debate Nobody Talks About**
Find debates within the clinical community — protocol disagreements, therapy model arguments, AI integration tensions, commercialization vs access concerns.
Queries:
- `psilocybin therapy model debate psychotherapy hours Compass MAPS`
- `AI psychedelic therapy integration human in loop FDA {current_year}`
- `psychedelic commercialization access equity concerns`
- `{drug_name} therapy protocol controversy`

**S8 — Bigger Picture Trend**
Find market size projections, AI regulation developments relevant to mental health, FDA guidance updates, state policy movement.
Queries:
- `psychedelic therapeutics market size forecast {current_year}`
- `FDA AI mental health devices regulation {current_year}`
- `psilocybin policy states {current_year} trigger bills`
- `AI assisted therapy regulation human in loop {current_year}`

**S9 — South Dakota / Sioux Falls Local**
Find South Dakota-specific data, local clinics, state legislative updates, Sioux Falls mental health infrastructure.
Queries:
- `Sioux Falls South Dakota mental health wellness {current_year}`
- `South Dakota {bill_or_topic} vote legislators`
- `ketamine clinic Sioux Falls South Dakota`
- `South Dakota behavioral health expansion {current_year}`
- `Avera behavioral health Sioux Falls {current_year}`

**S10 — What to Watch Next**
Find upcoming trial data releases, FDA meeting dates, legislative hearings, Senate votes.
Queries:
- `{drug_name} next data release date {current_year}`
- `South Dakota {bill_or_topic} Senate vote date {current_year}`
- `{drug_name} FDA rolling submission meeting date`
- `psychedelic clinical trial upcoming results {current_year}`

**S11 — TL;DR Summary**
Do not research. Synthesize from S1–S10 after all other sections are written. One sentence. Under 40 words. Contains: who did what, what it means, why it matters. No adjectives that are not data.

**S12 — Sources**
Compile all sources cited across S1–S10. Markdown hyperlinks, one per line, grouped by section if more than 10 sources.

---

### PHASE 2 — WRITE

Write the full article following all voice rules below. Write all sections S1–S10 first. Write S11 last. Place S11 first in the final document.

#### VOICE RULES (non-negotiable)

**Tone:** Calm, clear, precise. Buddhist writer who reports facts. No performance. No persuasion theater. No emotional decoration. Words as they are.

**Sentence rhythm:** Short sentence lands the fact. Medium sentence eases in. Longer sentence carries complex logic with internal structure, not padding. Then short again.
Example: "198 people died by suicide in South Dakota in 2024. That is a 10 percent increase from the year before. The bill does not legalize psilocybin; it reschedules a specific FDA-approved pharmaceutical compound to Schedule IV, the same tier as Xanax, and only after federal approval triggers it. One dose. Six weeks of data. The result held."

**Reading level:** Grade 7–8. Technical only where precision requires it.

**Numbers:** Always numerals above 10. Never spelled out. Always include raw numbers: p-values, vote counts, dollar figures, dates.

**Forbidden words (scan and remove every instance):**
em dashes, "game-changer", "revolutionary", "in conclusion", "it's worth noting", "delve", "utilize", "transformative journey", "landscape", "unprecedented", "the fact of the matter", "at the end of the day", "make no mistake", "importantly", "crucially", "needless to say", "simply put", "in other words", "what that means is", "to put it simply", "here is the thing", "the bottom line", "let's dive in"

**Forbidden patterns (rewrite as direct statements):**
- Comparative dismissal: "this isn't just X, it's Y"
- False contrast: "not X, but Y"
- Hype escalation: "not just significant, it's historic"
- Filler throat-clearing before the point
- Rhetorical questions to build suspense
- Meta commentary ("now let's look at", "here is what you need to know")
- Transitions between sections (the divider handles the break — end sections cleanly)

**Rhetorical framework:**
- Pathos opens — human cost, real stakes, real numbers. Do not linger.
- Logos carries the middle — p-values, vote counts, dollar figures, dates, sample sizes.
- Ethos closes — sources named inline, debates acknowledged, effect sizes reported as they are.

**Section headings:**
Under 10 words. A statement, a number, or a question. Never use the template section name as the heading.
Bad: "The Science" → Good: "Two Trials. Both Hit. Here Are the Numbers."
Bad: "The Human Cost" → Good: "198 South Dakotans Died by Suicide in 2024"

**Section openers:**
First sentence of every section = a fact, a number, or a direct statement. Never a transition. Never a setup.

**Bullet format:**
- One data point per bullet. One sentence max. Most important word or number first.
- Each bullet must stand alone without a follow-up explanation sentence.
- If a bullet needs explanation, rewrite the bullet until it contains everything.
- For raw clinical data: fragment style. "p < 0.001" or "-3.6 points on MADRS at week 6"
- For clinical commentary: "The effect size is modest. For people who have tried everything else, modest is meaningful."

**Paragraphs:** 2–3 sentences max. Break early. White space is not wasted space.

**Effect sizes:** State both statistical significance AND a plain-language qualifier. If modest relative to hype, say so explicitly.

**Section divider:** Between EVERY major section:
```
![](https://YOUR_S3_BUCKET.nbg1.your-objectstorage.com/assets/dividers/paragraph-splitter.png)
```
Never a plain horizontal rule. Never blank lines as a substitute.

**TL;DR placement:** S11 is written last but placed FIRST in the final document, before all body sections. Label it `**TL;DR:**`.

---

### PHASE 3 — PRE-OUTPUT CHECKLIST

Run every item before outputting the draft. Fix any failures before continuing.

1. **HEADINGS** — Is every section heading specific to this week's actual content, under 10 words, and not a copy of the template section_name label?
2. **SECTION OPENERS** — Does every section open with a fact, a number, or a direct statement? Remove any sentence that sets up, transitions, or announces what is coming.
3. **FORBIDDEN WORDS** — Scan every sentence against the forbidden list. Remove or rewrite every match.
4. **FORBIDDEN PATTERNS** — Scan for "this is not just X", "not X but Y", "not just significant", or any variation of comparative dismissal. Rewrite as direct statements.
5. **EM DASHES** — Search the full document for em dashes. Replace every instance with a semicolon, a period, or remove entirely.
6. **BULLETS** — Does every bullet stand alone without needing a follow-up sentence? If a bullet has an explanation sentence after it: delete the explanation and rewrite the bullet to contain everything.
7. **EFFECT SIZES** — In every section that reports data: is each result reported with both its statistical value and an honest plain-language qualifier? Is nothing inflated?
8. **HONEST FRAMING** — In S1, S5, S8, and S10 specifically: is the language accurate without optimism bias? These sections drift toward hype most often.
9. **DIVIDERS** — Is the divider image tag placed between every major section?
10. **TL;DR PLACEMENT** — Is S11 placed at the top of the final document, before all body sections?
11. **SOURCES** — Does every claim in the article have a corresponding source in S12?

---

### PHASE 4 — SAVE AND NOTIFY

Save the draft:

```bash
python3 -c "
import pathlib, os
from datetime import datetime

DRAFT_DIR = pathlib.Path.home() / '.openclaw' / 'substack-drafts'
DRAFT_DIR.mkdir(parents=True, exist_ok=True)

slug = os.environ.get('BODHI_SLUG', 'draft').strip().lower().replace(' ', '-')[:60]
ts = datetime.now().strftime('%Y-%m-%d')
filename = DRAFT_DIR / f'{ts}-{slug}.md'
content = os.environ.get('BODHI_CONTENT', '')

tmp = filename.with_suffix('.tmp')
tmp.write_text(content)
tmp.replace(filename)
print(f'Saved: {filename}')
print(f'Words: {len(content.split())}')
print(f'Read time: {round(len(content.split()) / 200)} min')
"
```

Then save to SiYuan (fire-and-forget):

```bash
python3 -c "
import os, sys
sys.path.insert(0, os.path.expanduser('~/openbodhi/packages/bodhi_vault/src'))
try:
    from bodhi_vault.siyuan_sync import get_client
    title = os.environ.get('BODHI_TITLE', 'Substack Draft')
    content = os.environ.get('BODHI_CONTENT', '')
    client = get_client()
    nb = client.find_notebook('OpenBodhi-Substack')
    if nb:
        client.create_doc(nb['id'], title, content)
        print('SiYuan: saved')
    else:
        print('SiYuan: notebook not found')
except Exception as e:
    print(f'SiYuan: skipped ({e})')
"
```

Telegram reply format:
```
Draft complete: [Article headline]
Words: [N] — Read time: [N] min
Key data: [2-3 most striking numbers from the article]
Saved to SiYuan: OpenBodhi-Substack
File: ~/.openclaw/substack-drafts/[filename]

Review and publish on Substack when ready.
/substack clips [topic] to extract video scripts.
```

---

## On `/research <topic>`

Research brief only — no article generation. Use when you want to evaluate a topic before committing to a full article.

This research phase feeds directly into `/q intel` — treat findings as OSINT input. Surface not just public health data but regulatory signal, market movement, competitive positioning, and industry voice patterns. What is the space not saying publicly that the data implies?

Search S1 and S2 queries only (newsworthiness + human cost). Return:
- 3–5 key findings with citations
- The single best data hook (the number that would make the strongest article lead)
- Suggested angle
- Any conflicting evidence or live debate
- Freshness rating: how much activity is there this week vs. last month?
- OSINT signal: notable actors, funding moves, legislative sponsors, trial sponsors, advocacy org positions — who has skin in the game and what are they pushing?

Reply in Bo's voice. "Here is what the data shows." No filler.

Store brief in SiYuan OpenBodhi-Substack notebook as a research note (not a full doc).

Cross-post research brief to OSINT notebook (`OSINT-Research`) if the topic has competitive or market intelligence value. Flag with `[OSINT]` prefix.

---

## On `/substack clips <topic or draft filename>`

Extract 4 short-form video scripts from a written article draft.

If given a topic, retrieve the most recent matching draft from `~/.openclaw/substack-drafts/`. If given a filename, read it directly.

Generate 4 clip scripts:

**C1 — The Number Hook (30–45s)**
Source: S2 (Human Cost)
Format: Open with the single most shocking statistic. Explain why it matters in 2 sentences. End with a question.
Hook must grab in 3 seconds. First word should be a number.

**C2 — Myth vs Fact (45–60s)**
Source: S3 (What It Actually Does)
Format: "Myth: [common misconception]. Fact: [what it actually does]. Here is the difference." 3 sentences max.

**C3 — The Science Plain (60–90s)**
Source: S4 (The Science)
Format: Here is what the clinical trial actually showed. Here is what the numbers mean in plain language. Here is what is still unknown.

**C4 — Local Angle (45–60s)**
Source: S9 (South Dakota)
Format: This is happening in South Dakota right now. Here is what it means for people here specifically.

Output each clip as:
```
CLIP [N]: [TYPE]
Duration: [Xs]
Hook: [First line — must grab in 3 seconds]
Script: [Full script, spoken at natural pace]
Visual notes: [What to show on screen]
CTA: [End frame — subscribe to [publication name] on Substack]
```

---

## On `/substack stats`

Pull recent performance from Plausible analytics.

```bash
python3 -c "
import subprocess, json, os

PLAUSIBLE_URL = 'https://YOUR_PLAUSIBLE_URL'
PLAUSIBLE_KEY = os.environ.get('PLAUSIBLE_API_KEY', '')

if not PLAUSIBLE_KEY:
    print('PLAUSIBLE_API_KEY not set in environment. Add to ~/.openclaw/.env')
    exit()

r = subprocess.run([
    'curl', '-s', '-H', f'Authorization: Bearer {PLAUSIBLE_KEY}',
    f'{PLAUSIBLE_URL}/api/v1/stats/aggregate?site_id=substack&period=30d&metrics=pageviews,visitors,bounce_rate,visit_duration'
], capture_output=True, text=True)

try:
    d = json.loads(r.stdout)
    results = d.get('results', {})
    print(f'Last 30 days:')
    print(f'  Pageviews:     {results.get(\"pageviews\", {}).get(\"value\", \"n/a\")}')
    print(f'  Visitors:      {results.get(\"visitors\", {}).get(\"value\", \"n/a\")}')
    print(f'  Bounce rate:   {results.get(\"bounce_rate\", {}).get(\"value\", \"n/a\")}%')
    print(f'  Avg duration:  {results.get(\"visit_duration\", {}).get(\"value\", \"n/a\")}s')
except Exception:
    print(r.stdout[:500] or 'No response from Plausible.')
"
```

---

## On `/substack schedule`

Show the upcoming content calendar.

```bash
python3 -c "
import pathlib
from datetime import datetime

DRAFT_DIR = pathlib.Path.home() / '.openclaw' / 'substack-drafts'
if not DRAFT_DIR.exists():
    print('No drafts directory found.')
    exit()

drafts = sorted(DRAFT_DIR.glob('*.md'), reverse=True)
if not drafts:
    print('No drafts saved yet.')
    exit()

for d in drafts[:10]:
    words = int(d.stat().st_size / 5.5)
    print(f'{d.stem}  (~{words} words)')
"
```

---

## Rules

- Research before writing. Never generate an article without running the research phase first.
- Every claim needs a citation. No unsourced assertions.
- Buddhist writer voice is non-negotiable. Re-read the voice rules above before generating if unsure.
- S11 (TL;DR) is ALWAYS written last and placed FIRST in the final document.
- Section headings must be specific to this week's content — never use template label names as headings.
- Run the full pre-output checklist before sending the draft. Fix every failure.
- Article drafts go to SiYuan first. Owner reviews before publishing.
- Clips are scripts, not finished videos. Owner records from scripts.
- Weekly cadence: 1 article every Tuesday. No skipping.
- Opus for full article generation. Sonnet for research briefs and clips.
- If research turns up no fresh data (all sources 12+ months old): report that clearly. Do not write a stale article.
- Research output is dual-use: journalism AND OSINT. Flag market signal, regulatory signal, and actor positioning to the OSINT operator when relevant.
