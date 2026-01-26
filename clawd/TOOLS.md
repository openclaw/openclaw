# Tools Notes

*Tool-specific notes and preferences. You can update this freely.*

## gog (Google Workspace)

- **YOUR account:** clawdbot@puenteworks.com
- **NEVER use:** simon@puenteworks.com (Simon's personal email)
- Gmail, Calendar access configured
- **Installation (WSL2):** Installed via Linux binary in `~/.local/bin/gog`.
- **Keyring:** Uses encrypted file backend with `GOG_KEYRING_PASSWORD` in `~/.profile`.
- **Config:** `~/.config/gogcli/config.json`

## Slack

- Primary communication channel with Simon
- Post summaries and alerts here

## iMessage

- Read-only mode
- Can read from: +15623746790, gonzalez.simon@icloud.com
- Responses disabled

## CLI

- Local access via `clawdbot agent --local`

## ZAI (GLM-4.7)

**IMPORTANT**: ZAI requires explicit configuration in `~/.clawdbot/clawdbot.json` with the **coding endpoint**.

**Correct endpoint**: `https://api.z.ai/api/coding/paas/v4` (NOT `/v1`)

**Config location**: `models.providers.zai` in clawdbot.json

**If ZAI starts failing with "fetch failed"**:
1. Check if `zai` provider exists in `models.providers`
2. Verify baseUrl is `https://api.z.ai/api/coding/paas/v4`
3. Test with: `curl -s "https://api.z.ai/api/coding/paas/v4/models" -H "Authorization: Bearer $ZAI_API_KEY"`

**Reference**: https://docs.z.ai/devpack/tool/others

## nano-banana-pro (Image Generation)

**Location:** `/home/liam/skills/nano-banana-pro/SKILL.md`  
**Requires:** `uv` (installed at `~/.local/bin/uv`), `GEMINI_API_KEY` (configured in clawdbot.json)

**IMPORTANT:** This is NOT an llm-task model. Use `exec` to run the Python script directly.

**Generate an image:**
```bash
GEMINI_API_KEY="$(jq -r '.env.GEMINI_API_KEY' ~/.clawdbot/clawdbot.json)" \
  uv run /home/liam/skills/nano-banana-pro/scripts/generate_image.py \
  --prompt "your description" \
  --filename "/tmp/output.png" \
  --resolution 1K
```

**Edit an existing image:**
```bash
GEMINI_API_KEY="$(jq -r '.env.GEMINI_API_KEY' ~/.clawdbot/clawdbot.json)" \
  uv run /home/liam/skills/nano-banana-pro/scripts/generate_image.py \
  --prompt "edit instructions" \
  --filename "output.png" \
  --input-image "/path/to/input.png" \
  --resolution 2K
```

**Resolutions:** `1K` (default), `2K`, `4K`  
**Output:** Script prints `MEDIA: /path/file.png` for auto-attach on chat providers

**Common mistakes to avoid:**
- Do NOT use `llm-task` with `google/gemini-3-pro-image-preview` — it's not in allowed models
- Do NOT look in `/home/liam/clawdbot/skills/` — skill is at `/home/liam/skills/`
- Use `exec` tool to run the Python script with `uv run`

---
*Add tool-specific notes as you learn them.*

## Data Analytics (`data-analytics` skill)

**Location:** `~/clawdbot/skills/data-analytics/SKILL.md`
**Created:** 2026-01-26 14:51 PST

**Capabilities:**
- **SQL/SQLite Querying:** Full SQL with JOINs, subqueries, window functions, exports to CSV/JSON/tables
- **Python/Pandas Analysis:** Load CSV/JSON/Excel/Parquet, descriptive stats, data cleaning, groupby aggregations, pivot tables, time series
- **Excel Processing:** Read/write .xlsx files, multiple sheets, formatting preservation, formula support, VLOOKUP via pandas merge
- **Visualization:** Bar/line/scatter/histogram/box/heatmap/pie charts in PNG/SVG/HTML formats

**Using the skill:**
```bash
# Use venv Python directly
~/clawdbot/skills/data-analytics/.venv/bin/python ~/clawdbot/skills/data-analytics/analyze.py <command>
~/clawdbot/skills/data-analytics/.venv/bin/python ~/clawdbot/skills/data-analytics/excel.py <command>
~/clawdbot/skills/data-analytics/.venv/bin/python ~/clawdbot/skills/data-analytics/visualize.py <command>
```

**Expertise areas:** Workday, SAP SuccessFactors, Salesforce CRM data

## Calendar Enhanced (`calendar-enhanced` skill)

**Location:** `~/clawdbot/skills/calendar-enhanced/SKILL.md`
**Created:** 2026-01-26 00:09 PST

**Capabilities:**
- **Natural Language Parsing:** "Schedule a meeting with John on Tuesday at 2pm" → automatic calendar creation
- **Time Parsing:** "tomorrow" = next day, "morning" = 9 AM, "afternoon" = 2 PM, "evening" = 6 PM (1 hour default)
- **PARA Project Linking:** Events tagged with `[Project: name]` for linking to PARA projects
- **Smart Reminders:** 24h alerts, 2h reminders, conflict detection via HEARTBEAT

**Integration:** Google Calendar API (clawdbot@puenteworks.com), all interactions via Telegram
