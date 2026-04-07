# Content Factory Config & Workflow

All automation hooks into `~/openclaw-work/clients/<client>/config.json`. Minimum viable schema:

```jsonc
{
  "client": "pulse-labs",
  "timezone": "America/New_York",
  "persona": "Growth marketing",
  "cta": "Book a stack audit",
  "sources": [
    {
      "name": "Futurepedia",
      "type": "html-list",
      "url": "https://www.futurepedia.io/",
      "item_selector": "div.tools-card",
      "title_selector": "h3",
      "description_selector": "p",
      "link_selector": "a",
      "limit": 6,
    },
    {
      "name": "AIToolsClub RSS",
      "type": "rss",
      "url": "https://aitoolsclub.com/rss",
    },
  ],
  "articles": [
    {
      "slug": "ai-tools-for-demand-gen",
      "title": "7 AI Tools Changing Demand Gen in 2026",
      "primary_keyword": "ai tools for demand generation",
      "keywords": ["ai demand gen tools", "marketing automation 2026"],
      "angle": "Demand Gen",
      "hook": "Your buyers expect tailored journeys—here's how to keep pace.",
      "meta_description": "See which AI demand-gen tools move pipeline fastest in 2026.",
      "outline": [
        "1. Why demand teams are under pressure",
        "2. Where AI personalization wins",
        "3. Featured tools by funnel stage",
        "4. Rollout plan",
        "5. FAQ",
      ],
      "sections": [
        [
          "Pilot AI on low-risk campaigns",
          "Start with retargeting or newsletter journeys before scaling.",
        ],
        ["Connect tools to revenue", "Define attribution KPIs and instrumentation up front."],
      ],
      "faq": [
        [
          "How accurate are AI-written sequences?",
          "Pair AI drafts with human QA, then measure reply lift.",
        ],
        ["What data do we need?", "Clean CRM intent data + content tagging gets you 80% there."],
      ],
    },
    {
      "slug": "ai-stack-for-content-teams",
      "title": "Build a 2026-Ready AI Stack for Content Teams",
      "primary_keyword": "ai stack content team",
      "keywords": ["ai content tools", "content ops automation"],
      "angle": "Content Ops",
      "hook": "Ship briefs, drafts, and campaigns in hours, not weeks.",
      "cta": "Download the Content Ops scorecard",
    },
  ],
}
```

## Key Fields

- **persona**: Drives tone in intros, outline copy, FAQ answers.
- **sources**: Provide at least one `html-list`, `rss`, or `api` entry. CSS selectors are evaluated inside each tool card for HTML sources.
- **articles**: Provide **≥ 2** entries; each run emits exactly two markdown files (the first two entries). Optional arrays `outline`, `sections`, and `faq` override defaults.
- **meta_description**: If omitted, the script synthesizes a generic SEO description from persona + primary keyword.
- **keywords**: Rendered in frontmatter plus the "Meta" block. Include the focus keyword + semantically-related terms.

## Output Layout

```
~/openclaw-work/
└── out/
    └── articles/
        └── YYYY-MM-DD/
            ├── article-1-slug.md
            └── article-2-slug.md
```

Each file contains: title, meta description, outline, three narrative sections, featured tool table, FAQ, CTA, and source notes.

## Fetching Strategy

1. Fetch and deduplicate tool cards across HTML + RSS (and optional API) sources.
2. Limit per source with `limit` or `--max-per-source` CLI flag.
3. Pass the resulting pool into the template so every section, outline bullet, tool table, and FAQ reference fresh examples.

## Article Quality Checklist

- Ensure the `primary_keyword` string shows up in intro, meta description, and CTA.
- Outline must include five ordered bullets (numbers or markdown list).
- Table should list ≥3 tools with descriptions + links; edit after run if fewer signals are available.
- FAQ includes at least three Q&A pairs. Provide overrides in config when you need specific messaging.
