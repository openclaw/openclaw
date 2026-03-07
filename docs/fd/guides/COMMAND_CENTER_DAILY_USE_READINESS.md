# Command Center — Daily Use Readiness

Practical guide for using the Command Center as a founder's daily
operational surface. Covers real friction points, workflows, and
what should be automatic vs manual.

---

## Day 1 Operator Workflow

First time opening the Command Center.

### Step 1: Start the backend (30 seconds)

```bash
cd ~/openclaw/fd
uvicorn services.webhook_gateway.main:app --host 0.0.0.0 --port 8000
```

### Step 2: Start the frontend (10 seconds)

```bash
cd ~/openclaw
pnpm cc:dev
```

### Step 3: Open the dashboard

Go to **http://localhost:5174**

### Step 4: Enter your token

A prompt appears asking for your Admin Token. Paste it. It's saved in
localStorage — you won't be asked again unless you clear browser data.

If you enter the wrong token, click "Token set" in the bottom-right
footer to re-enter it.

### Step 5: Verify panels load

You should see 5 panels: Today, Schedule, KPI Chips, Health, Approvals.
The connection indicator in the header should show a green dot with
"Connected."

### Step 6: Run "Start the Day"

Click the blue "Start the Day" button in the Today panel. This triggers
a full schedule sync (GCal + Trello), then refreshes all panels with
fresh data.

### Step 7: Take the tour (optional)

Click the "?" button in the header for a walkthrough of each panel.
This auto-appears on first visit.

---

## Daily 5-Minute Check-in Workflow

For a morning check-in after Day 1.

| Step | Action                                                           | Time |
| ---- | ---------------------------------------------------------------- | ---- |
| 1    | Open http://localhost:5174 (assuming backend is already running) | 5s   |
| 2    | Glance at connection indicator — should be green                 | 2s   |
| 3    | Click "Start the Day" — syncs schedule, refreshes KPIs           | 15s  |
| 4    | Scan Today panel — brand chips, up-next, overdue items           | 30s  |
| 5    | Scan Approvals panel — anything waiting for your decision?       | 15s  |
| 6    | Scan Health panel — any warnings or cooldown active?             | 10s  |
| 7    | If needed: type a question in the prompt bar                     | 30s  |
| 8    | Leave tab open — auto-refreshes every 30 seconds                 | 0s   |

**Total: ~2 minutes for a full morning check-in.**

---

## Top 5 Friction Points (found and addressed)

### 1. Backend not running = infinite loading

**What happens:** You open the dashboard but forgot to start uvicorn.
Panels show loading skeletons that never resolve.

**Fix applied:** API requests now timeout after 15 seconds instead of
hanging indefinitely. After timeout, the connection indicator turns red
("Disconnected") and panels show a clear error message instead of
infinite loading.

**What you'll see:** "Request timed out — is the backend running?"

### 2. Wrong token = opaque auth errors

**What happens:** Token is wrong or expired. Every panel fails with
generic error text at the bottom. Panels stay as loading skeletons.

**Fix applied:** Auth errors (401) now display a clear message on every
panel: "Auth error — click Token set in the footer to update your token."
The connection indicator turns yellow ("Auth Error"). The token status
in the footer is now a clickable button — click it to enter a new token
without opening DevTools.

### 3. "Start the Day" button re-registered every 30 seconds

**What happens:** The refresh cycle re-rendered panels and re-attached
a new click listener on each cycle. After 10 refreshes, clicking once
could fire 10 listeners.

**Fix applied:** Replaced per-panel `addEventListener` with a single
document-level event delegation listener that fires once and handles
all clicks on `#start-day-btn`. No matter how many refreshes happen,
only one handler ever runs.

### 4. No way to change token without DevTools

**What happens:** Token stored in localStorage. If wrong, the only
recovery was: DevTools > Application > Local Storage > edit manually.

**Fix applied:** The "Token set" / "No token" text in the footer is
now a clickable button. Click it to re-enter your token via prompt.
After changing, panels auto-refresh.

### 5. Stale panels after connection loss

**What happens:** Backend drops mid-session. Panels keep showing old
data from the last successful fetch. Only the small "Last refresh" text
in the footer shows the error.

**Partial fix applied:** When a refresh fails, any panels still showing
loading skeletons now show the error message instead. For panels with
real data, the data persists (intentional — stale data is better than
no data). The connection indicator turns red immediately.

**Remaining:** Panels don't yet show a "STALE" visual badge. This is
a follow-up item — not blocking daily use.

---

## What Should Be Automatic vs Manual

### Automatic (no user action needed)

| What                    | How it works                          | Frequency                  |
| ----------------------- | ------------------------------------- | -------------------------- |
| Panel data refresh      | `setInterval` polling                 | Every 30 seconds           |
| Connection status       | Updated on each fetch success/failure | Real-time                  |
| Token persistence       | localStorage                          | Until browser data cleared |
| Simple mode preference  | localStorage                          | Persists across sessions   |
| Walkthrough suppression | localStorage flag after completion    | Permanent                  |

### Manual (requires user action)

| What                 | How to trigger                 | Why manual                                      |
| -------------------- | ------------------------------ | ----------------------------------------------- |
| "Start the Day" sync | Click button in Today panel    | Triggers real external API calls (GCal, Trello) |
| Token entry/change   | Click footer token status      | Security — no auto-auth                         |
| Force refresh        | Click refresh button in footer | For immediate updates                           |
| Tour restart         | Click "?" in header            | Intentional re-education                        |
| Simple mode toggle   | Checkbox in header             | Personal preference                             |

### Should be automatic but isn't yet

| What                  | Current behavior           | Ideal behavior                  |
| --------------------- | -------------------------- | ------------------------------- |
| Schedule sync on open | Must click "Start the Day" | Auto-sync on first morning load |
| Stale data warning    | Error text in footer only  | Visual badge on panels with age |
| Backend auto-start    | Manual terminal command    | LaunchAgent / systemd service   |
| Build auto-trigger    | Manual `pnpm cc:build`     | Auto-build on save (dev only)   |

---

## When Things Go Wrong

### Dashboard won't load at all

1. Check if uvicorn is running: `curl http://localhost:8000/health/`
2. If not, start it: `cd ~/openclaw/fd && uvicorn services.webhook_gateway.main:app --host 0.0.0.0 --port 8000`
3. Check if Vite is running: look for the terminal running `pnpm cc:dev`

### Green dot but panels show errors

Backend is reachable but individual data sources are failing.

- Check uvicorn logs for Python exceptions
- Try `curl -H "X-Admin-Token: YOUR_TOKEN" http://localhost:8000/admin/cc/panels | python3 -m json.tool` to see raw response
- Each panel section in the response can independently have an `"error"` field

### Yellow dot ("Auth Error")

Click "Token set" in the footer → enter correct token → panels auto-refresh.

### Red dot ("Disconnected")

Backend is down or unreachable. Start/restart uvicorn.

---

## Monitor These in Your First Week

Use these as your daily confidence checks:

1. **Connection indicator stays green** — backend is healthy
2. **"Start the Day" completes without error** — external integrations work
3. **Health panel shows "All Clear"** — no cooldown, no drift, no queue backup
4. **Approvals count stays low** — you're processing decisions
5. **KPI chips show real data** — brand metrics are flowing

If any of these break, check the event log: `window.__ccLog(20)` in the
browser console for the last 20 events with timestamps.
