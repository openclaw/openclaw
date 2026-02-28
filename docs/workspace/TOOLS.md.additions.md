---
title: TOOLS.md Workspace Updates
note: Append these sections to /data/.openclaw/workspace/TOOLS.md after v2026.2.27-ws23+ deployment
---

## Tool Guidance (v2026.2.27-ws23+)

### session_status — Channel-Agnostic Tool

**✅ NOW WORKS in LINE channel sessions** (fixed in v2026.2.27-ws23)

The `session_status()` tool now reliably returns:
- Current timestamp (use `session_status.created_at` for "What time is it?")
- Active model and provider
- Thinking level and token usage

**When to use:**
- User asks "ตอนนี้กี่โมง" (What time is it?) → Call `session_status()`, return `datetime_str` (no timezone offset needed; server is UTC+07)
- User asks "ใช้โมเดลไหน" (Which model?) → Call `session_status()`, show `model`, `provider`, `thinking_level`
- Statistics: token usage, session duration

**Technical Note:**
- Previously failed with "Unknown sessionId" due to docker-compose volume mount path mismatch
- Fixed in v2026.2.27-ws23: volume now mounts to `/data/.openclaw/` (correct HOME path)
- Session persistence guaranteed across container restarts

---

### exec — Pre-Approved Command Execution

**Host Rule:** Always use `host: "gateway"` (no sandbox available on VPS)

**Pre-Approved Safe Commands** (no approval prompt required):
- Time/Info: `date`, `uptime`, `whoami`, `hostname`
- System: `ps`, `crontab`
- Processing: `tree`, `curl`, `wget`, `jq`, `head`, `tail`, `wc`, `cut`, `tr`, `uniq`
- Docker (read-only): `docker ps`, `docker logs`, `docker stats`, `docker inspect`

**Approval Loop Rules:**
- LINE has no UI for command approval prompts
- When LLM requests unapproved command:
  - If `ask: "on-miss"` is set → system prompts LLM internally
  - If no approval possible → request fails silently (LINE user sees no error, command doesn't run)
  - Avoid unnecessary exec calls; prefer built-in tools when available

**Never-Allow Vectors** (always blocked):
- Container escape: `docker exec`, `docker run`
- Destructive: `rm -rf`, `dd if=/dev/zero`
- Privilege escalation: `sudo`, `su`, permissions: `chmod 777`

**Example Flow:**
1. User: "รันคำสั่ง date" (Run command: date)
2. LLM: `exec(command="date", host="gateway")`
3. System: date is pre-approved → runs immediately
4. LLM receives: `"Tue Feb 17 15:32:45 +07 2026"`
5. Bot: "เวลา 15:32 น. ค่ะ"

---

### browser — Availability Check

**Status:** ✅ Available in v2026.2.27-ws23+ (if image built with `OPENCLAW_INSTALL_BROWSER=1`)

**When Available:**
- Docker image compiled with build arg: `docker build --build-arg OPENCLAW_INSTALL_BROWSER=1`
- Chromium installed in `/home/node/.cache/ms-playwright/`
- `browser()` tool can scrape golden-price, news sites, dynamic JS content

**When NOT Available:**
- Image built without `OPENCLAW_INSTALL_BROWSER=1` (size savings, ~300MB)
- Falls back to `web_search()` automatically
- `browser()` call returns error: "Can't reach the OpenClaw browser control service"

**Fallback Strategy:**
- If user requests page content from JavaScript-rendered site:
  - First try: `browser(url=..., action="screenshot_full_page")`
  - If timeout (5s): use `web_search(query=...)` for alternative search results
  - Inform user: "ไม่สามารถดึงข้อมูลแบบเรียลไทม์ได้ลองค้นหาทางออนไลน์แทน"

---

### web_search — Information Sources

**Primary API:** Brave Search API

**Required:** `BRAVE_API_KEY` environment variable (NOT empty)

**Usage:**
- User: "ราคาทองวันนี้เท่าไหร่" (Gold price today?)
- LLM: `web_search(query="ราคาทองคำวันนี้ thailand")`
- Returns: Top 10 results with snippet text
- Bot constructs answer from snippet text (no web scraping)

**Fallback When Key Missing:**
- `web_search()` returns error: `MissingEnvVarError: ${BRAVE_API_KEY}`
- Pre-deployment check: `bash docker/scripts/check-env.sh` to verify all API keys set

---

### Limits & Constraints

| Tool | Timeout | Max Calls/Session | Notes |
|------|---------|------|-------|
| `session_status()` | 2s | Unlimited | No cost, instant |
| `exec()` | 30s | ~10 (safety) | Per-command ~1-3s overhead |
| `browser()` | 5s | 2-3 (expensive) | 100+ requests/month quota, ~5MB screenshot |
| `web_search()` | 3s | 10 (per-day quota: ~100) | Heavy use → add billing plan |

---

## Multi-Agent Notes (WS-3+)

### Task Queue & Session Replication

When asking for multi-method solutions (e.g., "ค้นหาราคาทองหลายช่องทาง"):

1. **Method A:**  `web_search(query="ราคาทองคำ thai gold today")` → Brave API
2. **Method B:** `browser(url="https://example.com/gold", action="screenshot_full_page")` → Screenshot
3. **Fallback:** If both fail ↔ synthesize from cache or return "ขณะนี้ไม่สามารถดึงข้อมูล"

### Cron Jobs & Scheduled Tasks

Use `exec(command="crontab -l")` to verify cron jobs are set, or reference SOUL.md for time-based automation rules.

---

## Debugging Checklist

✅ Before each session, verify:
- `session_status()` returns timestamp and model name (fixes KI-009: volume mount)
- `exec(command="date", host="gateway")` returns current time (fixes KI-010: host rule)
- `web_search()` returns results (fixes KI-012: BRAVE_API_KEY set)
- `browser()` available (or gracefully fall back to web_search)
