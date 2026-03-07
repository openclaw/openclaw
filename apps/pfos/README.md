# Platinum Fang OS (`apps/pfos`)

Experimental Next.js App Router UI for the Platinum Fang OS control surface.

## Run

From repo root:

```bash
pnpm pfos:dev
```

Or from this directory:

```bash
pnpm dev
```

Default URL: <http://localhost:3000>

## Checks

```bash
pnpm pfos:build
pnpm pfos:lint
```

## Orgo Main + Worker Setup

Use this when Main Platinum Fang runs on its own Orgo PC and workers run on separate Orgo PCs.

### Main Fang Orgo PC

From `apps/pfos`:

```bash
npm run orchestrator:main
```

Optional env:

- `PF_MAIN_PORT` (default `18791`)
- `PF_DATA_DIR` (default `./.pf-data`)
- `PF_DB_PATH` (default `./.pf-data/orchestrator.sqlite`)
- `PF_API_TOKEN` (recommended shared token for all API calls)
- `PF_DEFAULT_MAX_ATTEMPTS` (default `3`)
- `PF_DEFAULT_TIMEOUT_MS` (default `60000`)

### Worker Orgo PCs

Set `PF_MAIN_URL` to the Main Fang PC endpoint, then run:

```bash
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_WORKER_ID=pf-worker-001 npm run orchestrator:worker
```

You can scale to any number by starting more workers with unique IDs:

- `pf-worker-001`
- `pf-worker-002`
- `...`
- `pf-worker-00X`

Optional worker env:

- `PF_API_TOKEN` (must match main if enabled)
- `PF_WORKER_CAPS` (comma-separated, default `general`)
- `PF_HEARTBEAT_MS` (default `10000`)
- `PF_POLL_MS` (default `3000`)

### Recommended 3-Agent Layout (Your Use Case)

- Main Platinum Fang (daily/work tasks): profile `main`, worker id `pf-main-operator`
- Sub bot 1 (faceless YouTube): profile `youtube`, worker id `pf-worker-yt`
- Sub bot 2 (forex/crypto): profile `trading`, worker id `pf-worker-trading`

Start commands:

```bash
# Main Fang PC (also runs a worker for your daily tasks)
PF_API_TOKEN=<token> npm run orchestrator:main
PF_MAIN_URL=http://127.0.0.1:18791 PF_API_TOKEN=<token> PF_WORKER_PROFILE=main npm run orchestrator:worker

# YouTube worker PC
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_API_TOKEN=<token> PF_WORKER_PROFILE=youtube npm run orchestrator:worker

# Trading worker PC
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_API_TOKEN=<token> PF_WORKER_PROFILE=trading npm run orchestrator:worker
```

Task routing is automatic by prefix:

- `daily.*`, `work.*`, `ops.*`, `admin.*` -> main operator
- `yt.*`, `youtube.*`, `content.*` -> YouTube worker
- `trade.*`, `forex.*`, `crypto.*`, `market.*` -> trading worker

### Single Worker Mode (Main Worker Handles All 3 Capability Sets)

If you are running only one bot for now, set `PF_SINGLE_WORKER_ID` on Main Fang so all routed tasks
(main + content + trading) target your single worker id.

Main Fang:

```bash
PF_API_TOKEN=<token> PF_SINGLE_WORKER_ID=pf-main-operator npm run orchestrator:main
```

Single worker:

```bash
PF_MAIN_URL=http://127.0.0.1:18791 PF_API_TOKEN=<token> PF_WORKER_PROFILE=main PF_WORKER_ID=pf-main-operator PF_WORKER_CAPS=daily,ops,research,admin,youtube,content,trading,forex,crypto npm run orchestrator:worker
```

Later, when you add dedicated content/trading workers, remove `PF_SINGLE_WORKER_ID` and start those workers normally.

### One Discord Server for All 3 Agents

Yes. Keep all agents in the same Discord server, and route messages by command/mention:

- `!agent main <message>`
- `!agent content <message>`
- `!agent trading <message>`
- `@pf-main <message>`
- `@pf-content <message>`
- `@pf-trading <message>`

Use API endpoint:

```bash
curl -X POST "http://<MAIN_FANG_IP>:18791/discord/dispatch" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"author":"you","channelId":"123","message":"!agent trading run backtest on BTCUSD using tradingview","payload":{"provider":"tradingview","mode":"paper","riskPct":0.5,"dailyDrawdownPct":1.0}}'
```

Response includes selected profile, task type, and target worker id.

### Direct Discord Gateway Bridge (Auto Dispatch)

Run a bridge process on Main Fang PC so Discord messages auto-dispatch without manual API calls:

```bash
DISCORD_BOT_TOKEN=<discord-bot-token> PF_MAIN_URL=http://127.0.0.1:18791 PF_API_TOKEN=<token> npm run orchestrator:discord
```

Optional restrictions:

- `DISCORD_ALLOWED_GUILD_ID=<your-server-id>` to lock one server
- `DISCORD_ALLOWED_CHANNEL_IDS=<id1,id2,...>` to lock specific channels
- `PF_DISCORD_STRICT_ROUTING=1` (recommended): content/trading only on explicit command/mention; everything else routes to main

Discord app settings required:

- Enable `MESSAGE CONTENT INTENT`
- Bot permission to read messages and send messages in target channels

### Queue a Task

From any machine with access to Main Fang:

```bash
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 npm run orchestrator:enqueue -- "research.analyze" "{\"topic\":\"BTC\"}" "pf-worker-001"
```

Last args:

- `targetWorkerId` optional
- `maxAttempts` optional
- `timeoutMs` optional

Example with retries + timeout:

```bash
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_API_TOKEN=<token> npm run orchestrator:enqueue -- "research.analyze" "{\"topic\":\"BTC\"}" "pf-worker-001" "4" "90000"
```

Profile-routed examples:

```bash
# Daily/work
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_API_TOKEN=<token> npm run orchestrator:enqueue -- "daily.plan" "{\"items\":[\"email\",\"calendar\",\"priority tasks\"]}"

# Faceless YouTube
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_API_TOKEN=<token> npm run orchestrator:enqueue -- "yt.script" "{\"niche\":\"finance\",\"durationMin\":8}"

# Faceless YouTube multi-platform pack
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_API_TOKEN=<token> npm run orchestrator:enqueue -- "yt.content.pack" "{\"niche\":\"finance\",\"topic\":\"Dollar-cost averaging\",\"platforms\":[\"youtube\",\"shorts\",\"tiktok\",\"reels\",\"x\",\"linkedin\"],\"multiPlatform\":true}"

# YouTube publish queue (upload)
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_API_TOKEN=<token> npm run orchestrator:enqueue -- "yt.publish.video" "{\"action\":\"upload\",\"title\":\"My Video\",\"description\":\"Desc\",\"privacyStatus\":\"private\",\"videoFilePath\":\"/path/to/video.mp4\",\"mimeType\":\"video/mp4\"}"

# Trading (paper mode)
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_API_TOKEN=<token> npm run orchestrator:enqueue -- "trade.setup.scan" "{\"mode\":\"paper\",\"riskPct\":0.5,\"dailyDrawdownPct\":1.2}"

# Trading backtest adapter example (TradeLocker | MT5 | TradingView)
PF_MAIN_URL=http://<MAIN_FANG_IP>:18791 PF_API_TOKEN=<token> npm run orchestrator:enqueue -- "trade.backtest.run" "{\"provider\":\"mt5\",\"strategy\":\"ema-breakout\",\"symbol\":\"EURUSD\",\"timeframe\":\"15m\",\"period\":\"365d\",\"mode\":\"paper\",\"riskPct\":0.5,\"dailyDrawdownPct\":1.5}"
```

### Retry + Timeout Behavior

- Tasks are leased by workers for `timeoutMs`.
- If lease expires and attempts remain, task returns to queue.
- If max attempts reached, task becomes `failed`.
- If worker reports `failed`, task is re-queued until `maxAttempts` is reached.

### Trading Guardrails

- `PF_TRADE_LIVE_ENABLED=0` by default (live trading blocked).
- Trading task payloads are rejected when:
  - `riskPct` > `PF_TRADE_MAX_RISK_PCT` (default `1`)
  - `dailyDrawdownPct` > `PF_TRADE_MAX_DAILY_DRAWDOWN_PCT` (default `3`)
  - `mode=live` without `confirmLive=true`
- Enable live mode only when ready:

```bash
PF_TRADE_LIVE_ENABLED=1 PF_TRADE_MAX_RISK_PCT=0.5 PF_TRADE_MAX_DAILY_DRAWDOWN_PCT=2 npm run orchestrator:main
```

### TradingView Webhook Integration (Step 1 of external connectors)

Set a webhook secret on Main Fang:

```bash
PF_TRADINGVIEW_WEBHOOK_SECRET=<tv-secret> npm run orchestrator:main
```

Send TradingView strategy payload to:

- `POST /tradingview/webhook`
- Secret via one of:
  - header `X-TradingView-Secret: <tv-secret>`
  - header `Authorization: Bearer <tv-secret>`
  - query `?secret=<tv-secret>`
  - body field `secret`

Payload may include any of:

- `returnsR: number[]`
- `trades: [{ rMultiple | pnlR | pnlPct }]`
- `signals: [{ r | pnlR | pnlPct }]`

When data is present, the trading worker computes real metrics from payload:

- win rate
- expectancy (R)
- net R
- profit factor
- max drawdown

### YouTube Publish Integration (Step 2 of external connectors)

The content worker now supports real YouTube API publish/update via `yt.publish.*` tasks.

Worker env (YouTube worker PC):

- `YOUTUBE_ACCESS_TOKEN=<oauth-access-token>`
- `YOUTUBE_DRY_RUN=1` for safe dry-run mode (default in example env)

Switch to live:

```bash
YOUTUBE_DRY_RUN=0
```

Secure enqueue endpoint on Main Fang:

- `POST /youtube/publish` (requires `PF_API_TOKEN`)

Example:

```bash
curl -X POST "http://<MAIN_FANG_IP>:18791/youtube/publish" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"action":"upload","title":"My Video","description":"Desc","privacyStatus":"private","videoFilePath":"/path/to/video.mp4","mimeType":"video/mp4"}'
```

Metadata update example:

```bash
curl -X POST "http://<MAIN_FANG_IP>:18791/youtube/publish" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"action":"update","videoId":"<youtube-video-id>","title":"New Title","description":"Updated desc","privacyStatus":"public"}'
```

### MT5 Bridge Integration (Step 3 of external connectors)

Trading worker can call an MT5 bridge API for backtests/strategy development.

Worker env (Trading worker PC):

- `MT5_BRIDGE_URL=http://<mt5-bridge-host>:<port>`
- `MT5_BRIDGE_KEY=<optional-bridge-token>`
- `MT5_DRY_RUN=1` by default in example env

Switch to live bridge mode:

```bash
MT5_DRY_RUN=0
```

Secure enqueue endpoint on Main Fang:

- `POST /mt5/backtest` (requires `PF_API_TOKEN`)

Example:

```bash
curl -X POST "http://<MAIN_FANG_IP>:18791/mt5/backtest" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"paper","strategy":"ema-breakout","symbol":"EURUSD","timeframe":"15m","period":"180d","riskPct":0.5,"dailyDrawdownPct":1.5}'
```

Expected MT5 bridge endpoints:

- `POST /backtest` -> returns metrics JSON
- `POST /strategy` -> returns strategy/proposal JSON

### QuasarSeed Product/Service Research

For your main bot research/scraping workflows:

- Route as `work.research.scrape` (or Discord `!agent main scrape ...`).
- Keep scraping legal/compliant with source terms and rate limits.
- Save findings with source URLs and timestamps for review before outreach.

### Autostart on Orgo Linux PCs (systemd user)

Files:

- `orgo/systemd/pf-main.service`
- `orgo/systemd/pf-worker@.service`
- `orgo/systemd/pf-worker-yt.service`
- `orgo/systemd/pf-worker-trading.service`
- `orgo/systemd/pf-discord-bridge.service`
- `orgo/systemd/install-systemd.sh`

Install on each Orgo PC:

```bash
cd apps/pfos/orgo/systemd
chmod +x install-systemd.sh
./install-systemd.sh
```

Then start services:

```bash
systemctl --user enable --now pf-main.service
systemctl --user enable --now pf-worker-yt.service
systemctl --user enable --now pf-worker-trading.service
systemctl --user enable --now pf-discord-bridge.service
```

## Structure

- `app/`: Next.js routes and global styles
- `components/pf/`: PF OS app shell, views, and domain logic
- `components/ui/`: lightweight UI primitives
- `lib/`: shared helpers
