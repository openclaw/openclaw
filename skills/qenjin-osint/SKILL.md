---
name: qenjin-osint
description: Market intelligence and OSINT — competitive briefs, company research, FDA tracking, contact enrichment.
user-invocable: true
disable-model-invocation: false
triggers:
  - /intel
  - /osint
  - /research
---

# qenjin-osint

Market intelligence and open-source intelligence for Qenjin's three-product portfolio and target niches.

Uses Apify MCP RAG browser for web research.
Output stored to SiYuan notebooks (Qenjin-Competitors, Qenjin-Research) when available.

**OPUS ONLY for OSINT on real people.** If model is not Opus, refuse people research and state: `People OSINT requires Opus. Switch with /model opus confirm.`

## Brand Reference

Internal brand strategy: `docs/qenjin/brand-strategy.md`

Read this before any competitive research to align positioning. Key context:
- Qenjin = three-product portfolio (Open Bodhi + Console + Webbing)
- Moat: Whonix-style security + AI-guided UX + multi-use-case ops — no competitor combines all three
- Target niche: ketamine clinics (Console validation), wellness practitioners, small businesses
- Pricing anchors: Bodhi $29-99/mo, Console $49-99/mo, Webbing $199-499/mo
- Differentiator phrase: "Organize your signal. Secure your source."

## On `/intel weekly`

Weekly competitive intelligence brief.

Scan and summarize:
1. Competitor content output (clinics, retreat centers, wellness brands in SD/Midwest)
2. FDA announcements relevant to psychedelic therapeutics, AI in health
3. Market trends: funding rounds, acquisitions, regulatory shifts
4. Reddit/community sentiment (r/TherapeuticKetamine, r/PsychedelicTherapy)

Reply format:
```
Intel Brief — Week of <date>
━━━━━━━━━━━━━━━━━━━━━━━━━━━

COMPETITORS (<count> signals)
  <bullet points, most important first>

FDA / REGULATORY (<count> items)
  <bullet points with dates and docket numbers>

MARKET (<count> signals)
  <dollar figures, deal names>

SENTIMENT
  <1-2 sentence summary of community tone>
```

Use Apify RAG browser to fetch current data. Cite sources with URLs.

## On `/intel company [name]`

Deep dive on a specific company.

Research via Apify RAG browser:
- Website, social profiles, key team members
- Recent news, press releases
- Funding history if available
- Content strategy (posting frequency, platforms, topics)
- Tech stack (BuiltWith or similar)

Reply format:
```
<company name>
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Website: <url>
Founded: <year>
Team: <key names and titles>
Funding: <amount if known>
Content: <frequency and platform summary>
Recent news: <1-3 items>
```

## On `/intel trends`

Market trend summary from scientific and clinical sources.

Sources to scan:
- PubMed: recent publications on psilocybin, ketamine, MDMA therapeutics
- ClinicalTrials.gov: new trial registrations
- Reddit: community discussion themes

Reply: 5-7 bullet points. Most significant first. Include dates and numbers.

## On `/intel fda`

Latest FDA announcements relevant to AI, health tech, psychedelic therapeutics.

```bash
python3 -c "
print('Scan FDA.gov, FDANews, STAT News for:')
print('  - Breakthrough therapy designations')
print('  - Expanded access programs')
print('  - AI/ML medical device guidance')
print('  - Advisory committee meetings')
print()
print('Use Apify RAG browser for current data.')
"
```

Use Apify RAG browser to fetch. Reply: bullet list with dates, docket numbers, drug names.

## On `/intel enrich [name]`

Find decision-maker contacts for a company.

**OPUS ONLY.** Refuse on Sonnet or Haiku with: `People OSINT requires Opus. Switch with /model opus confirm.`

Research via Apify RAG browser:
- Marketing Director / CMO
- Operations Manager / COO
- Owner / CEO / Founder
- Extract: name, title, email (if public), LinkedIn URL, phone (if public)

```bash
python3 -c "
import sys
name = ' '.join(sys.argv[1:])
if not name:
    print('Usage: /intel enrich <company name>')
    exit()
print(f'Enriching: {name}')
print('Searching LinkedIn, company website, press releases...')
" <name>
```

Reply format:
```
<company name> — Decision Makers
━━━━━━━━━━━━━━━━━━━━━━━━━━━
<name> | <title> | <linkedin> | <email if public>
<name> | <title> | <linkedin> | <email if public>
```

After enrichment, offer: `Add to Twenty CRM? /crm add <name>`

## Rules

- Numbers and dates first. No narrative filler.
- Cite sources. Include URLs when available.
- OPUS ONLY for any research involving real people's contact info.
- No treatment claims in any intelligence output.
- Clinical peer respect when writing about competitors.
- All output suitable for SiYuan storage (clean markdown).
- Never expose API tokens or internal URLs in output meant for external use.
- "Done." is a complete response when appropriate.
