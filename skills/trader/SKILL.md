# SKILL.md - Trader (Alpaca)

## Description

Autonomous trading skill using Alpaca Markets API. Capable of market data analysis, paper trading, and portfolio management.

## Credentials

- Location: `~/.openclaw/credentials/alpaca_credentials.json`
- Required keys: `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `APCA_API_BASE_URL` (optional, defaults to paper).

## Environment

- Venv: `/home/damon/qwen-venv`
- SDK: `alpaca-py` (Note: `alpaca-trade-api` is legacy)

## Architecture: The Sentinel

The trading system runs as a hybrid of manual execution and automated monitoring.

### Components

1.  **Execution:** Manual scripts (`execute_v1.py`, `execute_mstr_fix.py`) run by the Agent to enter positions.
2.  **Monitoring (`sentinel.py`):**
    - **Type:** Background Python process.
    - **Function:** Connects to Alpaca WebSocket, streams data for active positions (`AMZN`, `MSTR`).
    - **Logic:** Alerts if PnL varies by > +/- 5% from entry.
    - **Notification:** Sends a system event to the **Main Session** (Control Room) via Gateway API (`/api/v1/sessions/send`).
3.  **Scheduling (Cron):**
    - **Start:** 16:25 EET (Mon-Fri) -> `nohup ... sentinel.py &`
    - **Stop:** 23:05 EET (Mon-Fri) -> `pkill -f sentinel.py`

### Protocol: [SENTINEL ALERT]

If you receive a message starting with `[SENTINEL ALERT]`:

1.  **Do Not Panic.** This is an automated notification from your background process.
2.  **Verify:** Check the claimed price against a fresh quote if possible (or trust the stream).
3.  **Report:** Immediately inform the Admin (Damon) in the Control Room.
    - _"Sentinel reports MSTR is down 5%. PnL is -$1,500."_
4.  **Action:** Ask for instructions ("Cut it?" "Hold?") or execute the pre-agreed Stop Loss/Take Profit if explicitly authorized in `MEMORY.md`.

## Scripts

- `check_capabilities.py`: Verify account permissions.
- `execute_v1.py`: Enter initial positions.
- `sentinel.py`: The monitoring daemon.
- `status.py`: Simple account health check.

## Active Strategy: Scouter V1

- **Goal:** +50% PnL (The Gauntlet).
- **Positions:** Long AMZN, Short MSTR.
- **Thesis:** AMZN (Mean Reversion), MSTR (Crypto Contagion).
