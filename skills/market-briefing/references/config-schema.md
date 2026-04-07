# Client Config Schema (`~/openclaw-work/clients/<client>/config.json`)

Each client folder under `~/openclaw-work/clients/` must provide a JSON config file with the following structure:

```jsonc
{
  "client": "acme-industries", // Folder name, kebab-case
  "timezone": "America/New_York", // Any IANA zone
  "currency": "USD", // Optional, drives KPI units
  "persona": "IR team weekly note", // Who the briefing is for
  "focus": ["macroeconomics", "sector"], // Ordered priorities
  "sources": [
    {
      "name": "WSJ Markets",
      "url": "https://www.wsj.com/news/markets",
      "type": "html", // html | rss | api
      "selector": "article h3 a", // CSS selector (html only)
      "limit": 5, // Max items per run
      "notes": "Prioritize Fed commentary",
    },
  ],
  "custom_sections": [
    {
      "title": "Commodities Watch",
      "template": "bullet",
    },
  ],
}
```

## Field Notes

- **client**: Hyphenated slug. Used to resolve all other paths.
- **timezone**: Used to stamp `briefing_date`. Default to `UTC` if missing.
- **focus**: Drives summary ordering. When condensing, keep this order.
- **sources**: At least one entry. Supported `type`s:
  - `html`: scrape a web page. Requires `selector` pointing to anchor/title nodes.
  - `rss`: parse feed entries. Script auto-pulls title + link + published date.
  - `api`: script will `GET` the URL and expect JSON list/dict. Provide `path` (dot-separated) and optional `mapping` dict to rename fields.
- **custom_sections**: Optional list to append bespoke sections. `template` can be `bullet`, `table`, or `freeform`.

## Directory Layout Expected by the Skill

```
~/openclaw-work/
├── clients/
│   └── <client>/
│       └── config.json
└── out/
    └── <client>/
        └── briefing_YYYY-MM-DD.md   # auto-created
```

Ensure folders exist or run `python scripts/generate_briefing.py --client <client> --init-dirs` once to create them.
