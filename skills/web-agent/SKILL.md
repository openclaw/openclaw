---
name: web-agent
description: "Browser-based web automation agent (CUA). Use when automating web tasks without APIs - price monitoring, form filling, data scraping, account management. Supports multi-step workflows with error recovery. Triggers on '웹 자동화', '가격 모니터링', '스크래핑', '브라우저 자동화', 'web agent', 'CUA', 'web scraping', '폼 입력', '자동 입력'. NOT for: tasks with existing APIs (use API directly), simple URL fetching (use web_fetch), or browser GUI setup (use openclaw-browser skill)."
---

# Web Agent (CUA)

browser 도구 기반 Computer-Using Agent. API가 없는 웹사이트를 자동화한다.

## Core Workflow

1. **Goal decomposition** — break user request into browser action steps
2. **Snapshot first** — `browser snapshot refs="aria"` to understand page structure
3. **Act** — click, type, press, fill, select via `browser act`
4. **Verify** — snapshot again to confirm success
5. **Extract** — pull text data from snapshot, structure as JSON/markdown

## Key Commands

```
browser action=navigate targetUrl="https://example.com" profile=openclaw
browser action=snapshot refs="aria"
browser action=act request={ kind: "click", ref: "e12" }
browser action=act request={ kind: "type", ref: "e15", text: "query", submit: true }
browser action=screenshot
```

## Error Recovery

| Situation         | Action                                          |
| ----------------- | ----------------------------------------------- |
| Popup/modal       | snapshot → close button (X, Close, 닫기)        |
| Loading delay     | `act: { kind: "wait", timeMs: 3000 }` (max 10s) |
| Element not found | scroll down, re-snapshot                        |
| CAPTCHA           | notify user via Discord DM, wait                |
| Session expired   | re-login attempt                                |
| Page error        | navigate to re-access                           |

## Result Storage

- **One-off data** → `memory/*.md`
- **Time-series** → date-stamped files (e.g., `docs/prices/2026-02-20.md`)
- **Alerts** → Discord DM for price changes / anomalies
- **Bulk data** → JSON files

## Tips

- `targetId` — reuse from snapshot response for same-tab operations
- `profile="openclaw"` — isolated browser; `profile="chrome"` — user's Chrome via Relay
- Always snapshot before and after actions for reliable automation

## References

- `references/shopee-monitor.md` — Shopee price monitoring workflow
- `references/lazada-monitor.md` — Lazada price monitoring
- `references/tiktok-shop-monitor.md` — TikTok Shop monitoring
- `references/generic-scraper.md` — generic web scraping template
- `references/form-filler.md` — form filling template
- `references/error-recovery.md` — detailed error recovery strategies
- `references/browser-actions.md` — full browser tool action reference
