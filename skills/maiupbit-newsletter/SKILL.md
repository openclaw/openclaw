---
name: maiupbit-newsletter
description: "M.AI.UPbit AI Quant Letter newsletter publishing and pipeline management. Use when: generating weekly quant data, checking/publishing newsletter drafts, Substack publishing guidance, n8n automation pipeline status/repair, cookie renewal. Triggers: '뉴스레터 발행', '퀀트 레터', 'AI Quant Letter', 'Substack 발행', 'n8n 뉴스레터', 'newsletter publish', '주간 레터 초안', '발행 파이프라인 확인', 'Substack 쿠키 갱신', 'n8n 상태'. NOT for: M.AI.UPbit trading/analysis (use maiupbit memory), general crypto data, Substack account setup."
---

# M.AI.UPbit AI Quant Letter 🦞

Weekly crypto quant newsletter published on Substack.

## Pipeline Flow

```
n8n Schedule (Mon 07:00 KST)
  → GitHub Actions (workflow_dispatch)
    → Quant data generation (ci_weekly_report.py)
    → Newsletter draft (generate_newsletter.py)
    → README badge update
    → git push (blog/drafts/)
    → Discord DM notification
  → 지니: Click "Publish" on Substack (1 click)
```

## Quick Commands

```powershell
# Generate draft manually
cd C:\TEST\M.AI.UPbit
python scripts/ci_weekly_report.py
python scripts/generate_newsletter.py

# Trigger GitHub Actions
gh workflow run weekly-report.yml -R jini92/M.AI.UPbit

# Check recent runs
gh run list -R jini92/M.AI.UPbit --limit 3
```

## Key Info

| Item                   | Value                              |
| ---------------------- | ---------------------------------- |
| Substack               | https://jinilee.substack.com       |
| Draft folder           | `C:\TEST\M.AI.UPbit\blog\drafts\`  |
| n8n workflow           | `tcqab8TejqOgwxMt` (Mon 00:00 UTC) |
| n8n API key expiry     | 2026-04-09                         |
| SUBSTACK_COOKIE expiry | ~30 days (re-extract from browser) |

## Cookie Renewal (When Substack publish fails)

1. Log in to jinilee.substack.com in Chrome
2. DevTools (F12) → Application → Cookies → copy `substack.lli`
3. `gh secret set SUBSTACK_COOKIE --body "substack.lli=<value>" -R jini92/M.AI.UPbit`

## References

- `references/operations.md` — Detailed commands, secrets, n8n API, Discord notification
- `references/pipeline.md` — Pipeline architecture, file structure, troubleshooting, monetization plans

---

_Skill version: v2.0 — Refactored 2026-03-13_
