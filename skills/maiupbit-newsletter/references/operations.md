# M.AI.UPbit Newsletter — Operations Reference

## Key Endpoints

| Item                | Value                                 |
| ------------------- | ------------------------------------- |
| **Substack**        | https://jinilee.substack.com          |
| **GitHub repo**     | https://github.com/jini92/M.AI.UPbit  |
| **Draft folder**    | `C:\TEST\M.AI.UPbit\blog\drafts\`     |
| **n8n Cloud**       | https://mai-n8n.app.n8n.cloud         |
| **n8n workflow ID** | `tcqab8TejqOgwxMt`                    |
| **n8n schedule**    | Mon 00:00 UTC (= 07:00 KST)           |
| **GitHub Actions**  | `.github/workflows/weekly-report.yml` |

## Manual Newsletter Generation

```powershell
# Generate quant data
cd C:\TEST\M.AI.UPbit
python scripts/ci_weekly_report.py > /tmp/report.json

# Generate newsletter draft
python scripts/generate_newsletter.py

# Check drafts
Get-ChildItem blog\drafts\ | Sort-Object LastWriteTime -Descending | Select-Object -First 3
```

After checking draft → publish at https://jinilee.substack.com/publish/posts

## GitHub Actions Manual Trigger

```powershell
gh workflow run weekly-report.yml -R jini92/M.AI.UPbit
gh run list -R jini92/M.AI.UPbit --limit 3
```

## n8n Workflow Status/Control

n8n API Key: check `memory/2026-03-10.md` (expires 2026-04-09)

```powershell
$key = "<n8n API key>"
# Check status
Invoke-RestMethod -Uri "https://mai-n8n.app.n8n.cloud/api/v1/workflows/tcqab8TejqOgwxMt" `
  -Headers @{"X-N8N-API-KEY"=$key} | Select-Object name, active

# Activate
Invoke-RestMethod -Uri "https://mai-n8n.app.n8n.cloud/api/v1/workflows/tcqab8TejqOgwxMt/activate" `
  -Headers @{"X-N8N-API-KEY"=$key; "Content-Type"="application/json"} `
  -Method POST -Body "null"
```

## Discord Notification (Manual)

```powershell
$token = "<DISCORD_BOT_TOKEN>"
$msg = "📬 AI Quant Letter 초안 준비됨! https://jinilee.substack.com/publish/posts"
Invoke-RestMethod -Uri "https://discord.com/api/v10/channels/1466624220632059934/messages" `
  -Headers @{"Authorization"="Bot $token"; "Content-Type"="application/json"} `
  -Method POST -Body (ConvertTo-Json @{content=$msg})
```

## GitHub Secrets (jini92/M.AI.UPbit)

| Secret              | Description                             | Status  |
| ------------------- | --------------------------------------- | ------- |
| `SUBSTACK_SID`      | Substack session ID                     | ✅      |
| `SUBSTACK_URL`      | https://jinilee.substack.com            | ✅      |
| `SUBSTACK_COOKIE`   | substack.lli JWT (extract from browser) | ✅      |
| `DISCORD_BOT_TOKEN` | MAIBOT Discord Bot Token                | ✅      |
| `UPBIT_ACCESS_KEY`  | UPbit API key (optional)                | Not set |

## SUBSTACK_COOKIE Renewal

When cookie expires:

1. Log in to jinilee.substack.com in Chrome
2. DevTools (F12) → Application → Cookies → copy `substack.lli` value
3. `gh secret set SUBSTACK_COOKIE --body "substack.lli=<value>" -R jini92/M.AI.UPbit`

## Known Constraints

- **No Substack official API** — unofficial `/api/v1/posts` returns 403 from GitHub Actions
- **SUBSTACK_COOKIE expiry** — `substack.lli` JWT expires ~30 days. Re-extract from browser on expiry
- **n8n API Key expiry** — 2026-04-09. Renew at `Settings → API → Create an API Key`
