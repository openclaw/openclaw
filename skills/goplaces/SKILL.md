---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: goplaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Query Google Places API (New) via the goplaces CLI for text search, place details, resolve, and reviews. Use for human-friendly place lookup or JSON output for scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://github.com/steipete/goplaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📍",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["goplaces"], "env": ["GOOGLE_PLACES_API_KEY"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "primaryEnv": "GOOGLE_PLACES_API_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/goplaces",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["goplaces"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install goplaces (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# goplaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Modern Google Places API (New) CLI. Human output by default, `--json` for scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Homebrew: `brew install steipete/tap/goplaces`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `GOOGLE_PLACES_API_KEY` required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional: `GOOGLE_PLACES_BASE_URL` for testing/proxying.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Search: `goplaces search "coffee" --open-now --min-rating 4 --limit 5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bias: `goplaces search "pizza" --lat 40.8 --lng -73.9 --radius-m 3000`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pagination: `goplaces search "pizza" --page-token "NEXT_PAGE_TOKEN"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Resolve: `goplaces resolve "Soho, London" --limit 5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Details: `goplaces details <place_id> --reviews`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JSON: `goplaces search "sushi" --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-color` or `NO_COLOR` disables ANSI color.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Price levels: 0..4 (free → very expensive).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Type filter sends only the first `--type` value (API accepts one).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
