import os
import json
import time
import subprocess
import asyncio
import logging
import sys
from alpaca.data.live import StockDataStream
from alpaca.trading.client import TradingClient

# --- Configuration ---
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")
TARGET_CHANNEL_ID = "1469273412357718048"  # #saiabets
SYMBOLS = ["AMZN", "APLD"]
THRESHOLDS = 0.05  # +/- 5%

# Setup Logging
# Force flush to ensure logs appear immediately in tail -f
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(os.path.join(os.path.dirname(__file__), "sentinel.log"))
    ]
)

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

async def notify_session_async(session_id, message):
    if not session_id:
        logging.warning("No target session ID. Cannot notify.")
        return

    try:
        cmd = [
            "openclaw", "agent", 
            "--session-id", session_id,
            "--message", f"[SENTINEL ALERT] {message}",
            "--timeout", "10"  # Enforce 10s timeout on the agent turn
        ]
        # Non-blocking subprocess call
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        # Add asyncio timeout for the subprocess itself
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
            
            if proc.returncode == 0:
                logging.info(f"Notified session {session_id}: {message}")
            else:
                logging.error(f"CLI Error: {stderr.decode()}")
        except asyncio.TimeoutError:
            logging.error("Notification Timed Out (Subprocess hung)")
            try:
                proc.kill()
            except:
                pass
                
    except Exception as e:
        logging.error(f"Failed to notify session: {e}")

async def heartbeat_loop():
    """Logs a heartbeat every 60 seconds to prove aliveness."""
    while True:
        await asyncio.sleep(60)
        logging.info("HEARTBEAT: Sentinel is running...")

async def run_sentinel():
    creds = load_creds()
    api_key = creds["APCA_API_KEY_ID"]
    secret_key = creds["APCA_API_SECRET_KEY"]
    
    # Resolve Session ID ONCE at startup
    session_id = find_target_session_id_cli()
    if not session_id:
        logging.error("CRITICAL: Could not find Target Session for #saiabets. Notifications disabled.")
    else:
        logging.info(f"Target Session Resolved: {session_id}")

    trade_client = TradingClient(api_key, secret_key, paper=True)
    
    # Main Retry Loop
    while True:
        try:
            stream = StockDataStream(api_key, secret_key)
            initial_prices = {}
            last_alert_bucket = {}
            
            # Fetch positions
            try:
                positions = trade_client.get_all_positions()
                for p in positions:
                    if p.symbol in SYMBOLS:
                        initial_prices[p.symbol] = float(p.avg_entry_price)
                        logging.info(f"Tracking {p.symbol} from entry: ${initial_prices[p.symbol]}")
            except Exception as e:
                logging.error(f"Failed to fetch positions: {e}. Retrying in 10s...")
                await asyncio.sleep(10)
                continue

            async def handle_trade(data):
                symbol = data.symbol
                price = data.price
                
                if symbol not in initial_prices:
                    return

                entry = initial_prices[symbol]
                change_pct = (price - entry) / entry
                pct_value = change_pct * 100
                
                step = 5.0
                if abs(pct_value) < step:
                    if symbol in last_alert_bucket:
                        last_alert_bucket.pop(symbol)
                    return

                current_bucket = int(pct_value / step) * int(step)
                last_bucket = last_alert_bucket.get(symbol, 0)
                
                if current_bucket != last_bucket:
                    last_alert_bucket[symbol] = current_bucket
                    direction = "UP" if change_pct > 0 else "DOWN"
                    msg = f"{symbol} hit {current_bucket}% threshold ({direction} {pct_value:.2f}%) (Price: ${price}, Entry: ${entry})"
                    logging.info(f"ALERT TRIGGERED: {msg}")
                    # Fire and forget async task
                    asyncio.create_task(notify_session_async(session_id, msg))

            stream.subscribe_trades(handle_trade, *SYMBOLS)
            logging.info(f"Sentinel connected. Monitoring {SYMBOLS}.")
            
            # Run stream and heartbeat concurrently
            await asyncio.gather(
                stream._run_forever(),
                heartbeat_loop()
            )
            
        except Exception as e:
            logging.error(f"Stream crashed: {e}. Reconnecting in 5s...")
            await asyncio.sleep(5)

if __name__ == "__main__":
    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(run_sentinel())
    except KeyboardInterrupt:
        logging.info("Sentinel stopped by user.")