import os
import json
import time
import subprocess
import asyncio
import logging
from alpaca.data.live import StockDataStream
from alpaca.trading.client import TradingClient

# --- Configuration ---
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")
TARGET_CHANNEL_ID = "1469273412357718048"  # #saiabets
SYMBOLS = ["AMZN", "MSTR", "POET"]
THRESHOLDS = 0.05  # +/- 5%

# Setup Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def load_creds():
    with open(CRED_PATH, 'r') as f:
        return json.load(f)

def find_target_session_id_cli():
    """Finds the session UUID via openclaw CLI."""
    try:
        cmd = ["openclaw", "sessions", "--json"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            logging.error(f"CLI sessions list failed: {result.stderr}")
            return None
            
        data = json.loads(result.stdout)
        sessions = data.get("sessions", [])
        
        for sess in sessions:
            key = sess.get("key", "")
            if TARGET_CHANNEL_ID in key:
                return sess.get("sessionId") # Return UUID
        
        return None
    except Exception as e:
        logging.error(f"Failed to resolve session via CLI: {e}")
        return None

def notify_session(message):
    session_id = find_target_session_id_cli()
    if not session_id:
        logging.warning("No target session found. Cannot notify.")
        return

    try:
        cmd = [
            "openclaw", "agent", 
            "--session-id", session_id,
            "--message", f"[SENTINEL ALERT] {message}"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            logging.info(f"Notified session {session_id}: {message}")
        else:
            logging.error(f"CLI Error: {result.stderr}")
    except Exception as e:
        logging.error(f"Failed to notify session: {e}")

async def run_sentinel():
    creds = load_creds()
    api_key = creds["APCA_API_KEY_ID"]
    secret_key = creds["APCA_API_SECRET_KEY"]
    
    trade_client = TradingClient(api_key, secret_key, paper=True)
    stream = StockDataStream(api_key, secret_key)
    
    initial_prices = {}
    last_alert_bucket = {}
    
    try:
        positions = trade_client.get_all_positions()
        for p in positions:
            if p.symbol in SYMBOLS:
                initial_prices[p.symbol] = float(p.avg_entry_price)
                logging.info(f"Tracking {p.symbol} from entry: ${initial_prices[p.symbol]}")
    except Exception as e:
        logging.error(f"Failed to fetch positions: {e}")
        return
    
    async def handle_trade(data):
        symbol = data.symbol
        price = data.price
        
        if symbol not in initial_prices:
            return

        entry = initial_prices[symbol]
        change_pct = (price - entry) / entry
        pct_value = change_pct * 100
        
        # Logic: Alert every 5% step (5, 10, 15...)
        # Calculate current bucket (e.g. 6.3% -> 5, 11% -> 10, -7% -> -5)
        step = 5.0
        
        # If below first threshold, clear state and return
        if abs(pct_value) < step:
            if symbol in last_alert_bucket:
                # Optional: Alert "Back to Normal"? For now, just reset silently.
                last_alert_bucket.pop(symbol)
            return

        # Determine bucket
        # int(6.3 / 5) * 5 = 5
        # int(-6.3 / 5) * 5 = -5 (Wait, int(-1.2) is -1. Correct.)
        current_bucket = int(pct_value / step) * int(step)
        
        # Only alert if we moved to a NEW bucket
        last_bucket = last_alert_bucket.get(symbol, 0)
        
        if current_bucket != last_bucket:
            last_alert_bucket[symbol] = current_bucket
            direction = "UP" if change_pct > 0 else "DOWN"
            msg = f"{symbol} hit {current_bucket}% threshold ({direction} {pct_value:.2f}%) (Price: ${price}, Entry: ${entry})"
            notify_session(msg)

    try:
        stream.subscribe_trades(handle_trade, *SYMBOLS)
        logging.info(f"Sentinel started. Monitoring {SYMBOLS} for +/- {THRESHOLDS*100}% moves.")
        await stream._run_forever()
    except Exception as e:
        logging.error(f"Stream error: {e}")

if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(run_sentinel())
