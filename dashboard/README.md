# Control4 Home Dashboard

A browser-based dashboard for the Control4 home automation system.
Shows live home state (lights, thermostats, audio, locks) with click-based
controls and a natural language input bar powered by Claude.

## Requirements

- Node.js 20+
- The `.env` file in the project root with:
  - `CONTROL4_EMAIL`
  - `CONTROL4_PASSWORD`
  - `CONTROL4_CONTROLLER_IP`
  - `CONTROL4_CONTROLLER_NAME`
  - `ANTHROPIC_API_KEY`

## Development (two terminals)

```bash
# Terminal 1 — backend (auto-restarts on change)
cd dashboard && npx tsx watch server/index.ts

# Terminal 2 — frontend (HMR at http://localhost:5173)
cd dashboard && npx vite
```

Vite proxies `/api/*` → `http://localhost:3001` so no CORS issues.

## Production

```bash
cd dashboard
npx vite build           # build React app → dist/
npx tsx server/index.ts  # serves API + static files on :3001
```

Access from any LAN device: `http://192.168.86.x:3001`

## Architecture

- **Backend**: Express + tsx, port 3001, binds `0.0.0.0`
- **Frontend**: React 18 + Tailwind CSS + Vite
- **State delivery**: Server-Sent Events — browser `EventSource`
- **NL route**: Anthropic `claude-sonnet-4-6` with tool loop
- **Imports directly** from `extensions/control4/src/` — no duplication

### Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/state` | Full home state snapshot |
| GET | `/api/events` | SSE stream (init / patch / ping events) |
| POST | `/api/command` | Fire a device command |
| POST | `/api/nl` | Natural language → Claude → commands |
