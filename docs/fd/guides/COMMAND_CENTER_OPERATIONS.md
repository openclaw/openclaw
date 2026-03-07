# Command Center — Operations Guide

Day-to-day startup, troubleshooting, and operational reference for the
Command Center local web UI.

---

## Startup

### Development (recommended for daily use)

```bash
# Terminal 1 — Backend
cd ~/openclaw/fd
uvicorn services.webhook_gateway.main:app --host 0.0.0.0 --port 8000

# Terminal 2 — Frontend dev server
cd ~/openclaw
pnpm cc:dev
```

Open: **http://localhost:5174**

The Vite dev server proxies all `/admin/*` requests to the FastAPI backend
on port 8000. Hot-reload is enabled for frontend changes.

### Production

```bash
# Build the frontend (once, or after changes)
cd ~/openclaw
pnpm cc:build

# Start backend — it auto-detects the built frontend
cd ~/openclaw/fd
uvicorn services.webhook_gateway.main:app --host 0.0.0.0 --port 8000
```

Open: **http://localhost:8000/cc/**

The FastAPI server mounts `packages/command-center/dist/` at `/cc/`
using `StaticFiles(html=True)` for SPA routing.

---

## URLs

| Surface       | URL                                      | Requires                |
| ------------- | ---------------------------------------- | ----------------------- |
| Dev UI        | `http://localhost:5174`                  | Vite + FastAPI running  |
| Production UI | `http://localhost:8000/cc/`              | FastAPI + built `dist/` |
| API panels    | `http://localhost:8000/admin/cc/panels`  | FastAPI + token         |
| API prompt    | `http://localhost:8000/admin/cc/prompt`  | FastAPI + token         |
| API guide     | `http://localhost:8000/admin/cc/guide/*` | FastAPI + token         |

---

## Token / Auth Flow

1. On first visit, a browser `prompt()` asks for your Admin Token.
2. The token is stored in `localStorage` as `openclaw_admin_token`.
3. Every API request sends it as `X-Admin-Token` header.
4. The backend validates it via `require_admin_ops_token`.

**To reset the token:** Open DevTools > Application > Local Storage >
delete `openclaw_admin_token`, then refresh.

**To check token status:** Look at the footer — it shows "Token set" (green)
or "No token" (red).

---

## Connection Indicator

The header shows a connection dot:

| Color  | Label        | Meaning                         |
| ------ | ------------ | ------------------------------- |
| Green  | Connected    | Last panel fetch succeeded      |
| Red    | Disconnected | Network error or backend down   |
| Yellow | Auth Error   | 401 — token is wrong or missing |

---

## Dev vs Production: How They Differ

| Aspect             | Dev (port 5174)    | Production (port 8000/cc/) |
| ------------------ | ------------------ | -------------------------- |
| Frontend served by | Vite dev server    | FastAPI StaticFiles        |
| Hot reload         | Yes                | No (rebuild required)      |
| API routing        | Vite proxy → :8000 | Direct (same server)       |
| Source maps        | Yes                | No                         |
| Build required     | No                 | Yes (`pnpm cc:build`)      |

Both modes use the same FastAPI backend and the same SQLite database.
There is no separate "dev database."

---

## Event Log

The Command Center logs key user actions to an in-memory ring buffer
(200 entries max). Access it from the browser console:

```js
// Show all logged events
window.__ccLog();

// Show last 10 events
window.__ccLog(10);
```

Logged actions include: boot, auth, prompt submissions, prompt responses,
Start the Day, walkthrough start/complete, manual refreshes, refresh errors.

---

## Common Troubleshooting

### Panels show "Error" or never load

1. **Check backend is running:** `curl http://localhost:8000/health/`
2. **Check token:** Look at the connection indicator in the header.
   If yellow ("Auth Error"), reset your token (see above).
3. **Check console:** Open DevTools > Console for JavaScript errors.
4. **Check backend logs:** Look at the uvicorn terminal for Python exceptions.

### "Disconnected" indicator (red dot)

The frontend can't reach the backend.

- Is uvicorn running on port 8000?
- In dev mode: is the Vite proxy correctly pointing to localhost:8000?
- Firewall blocking local connections?

### Production route `/cc/` returns 404

The `dist/` folder doesn't exist or the path resolution is wrong.

1. Run `pnpm cc:build` to create `packages/command-center/dist/`.
2. Restart uvicorn so it picks up the new static mount.
3. Verify: `ls packages/command-center/dist/index.html` should exist.

### "Start the Day" says "Skipped (cooldown active)"

The cooldown system prevents repeated sync operations. Wait for the
cooldown to expire, or clear it via the admin system endpoints.

### Walkthrough keeps appearing

Clear the localStorage flag: in DevTools > Application > Local Storage,
delete `openclaw_walkthrough_done`.

### Stale panel data

- Click the refresh button (circular arrow) in the footer for an immediate
  refresh.
- Auto-refresh runs every 30 seconds.
- If data looks very stale, the schedule sync or cron jobs may have stopped.
  Check `Start the Day` to force a sync.

---

## Panel Reference

| Panel     | Primary data source           | Update trigger      |
| --------- | ----------------------------- | ------------------- |
| Today     | `_build_today_data()`         | Every refresh (30s) |
| Schedule  | schedule sync engine          | Every refresh       |
| KPI Chips | brand metrics from Today      | Every refresh       |
| Health    | cooldown + queue + compliance | Every refresh       |
| Approvals | `scheduled_actions` table     | Every refresh       |

All panel data comes from a single aggregated endpoint
(`GET /admin/cc/panels`) to minimize API calls.

---

## File Locations

| What                | Path                                                   |
| ------------------- | ------------------------------------------------------ |
| Frontend source     | `packages/command-center/src/`                         |
| Built output        | `packages/command-center/dist/`                        |
| Backend aggregator  | `fd/services/webhook_gateway/routes/admin_cc.py`       |
| Backend main        | `fd/services/webhook_gateway/main.py`                  |
| Architecture docs   | `docs/fd/guides/DUAL_SURFACE_ARCHITECTURE.md`          |
| Sync model docs     | `docs/fd/guides/SYNC_PROJECTION_MODEL.md`              |
| UI spec docs        | `docs/fd/guides/COMMAND_CENTER_LOCAL_UI_SPEC.md`       |
| Verification report | `docs/fd/guides/COMMAND_CENTER_VERIFICATION_REPORT.md` |
