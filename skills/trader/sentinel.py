import os
import json
import time
import requests
import asyncio
import logging
from alpaca.data.live import StockDataStream
from alpaca.trading.client import TradingClient

# --- Configuration ---
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")
GATEWAY_URL = "http://localhost:18789"
TARGET_CHANNEL_ID = "1469273412357718048"  # #saiabets
SYMBOLS = ["AMZN", "MSTR"]
THRESHOLDS = 0.05  # +/- 5%

# Setup Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def load_creds():
    with open(CRED_PATH, 'r') as f:
        return json.load(f)

def find_target_session():
    """Finds the session key for the Trader Channel."""
    try:
        url = f"{GATEWAY_URL}/api/v1/sessions/list"
        resp = requests.get(url)
        if resp.status_code != 200:
            logging.error(f"Failed to list sessions: {resp.text}")
            return None
            
        sessions = resp.json().get("sessions", [])
        
        # Priority: Exact Channel Match
        for sess in sessions:
            if TARGET_CHANNEL_ID in sess["sessionKey"]:
                return sess["sessionKey"]
                
        # Fallback: any session containing the channel ID in name/key
        for sess in sessions:
             if TARGET_CHANNEL_ID in sess.get("displayName", ""):
                 return sess["sessionKey"]

        return None
    except Exception as e:
        logging.error(f"Error finding session: {e}")
        return None

def notify_session(message):
    session_key = find_target_session()
    if not session_key:
        logging.warning("No target session found. Cannot notify.")
        return

    try:
        url = f"{GATEWAY_URL}/api/v1/sessions/send"
        payload = {
            "sessionKey": session_key,
            "message": f"[SENTINEL ALERT] {message}"
        }
        requests.post(url, json=payload)
        logging.info(f"Notified session {session_key}: {message}")
    except Exception as e:
        logging.error(f"Failed to notify session: {e}")

async def run_sentinel():
    creds = load_creds()
    api_key = creds["APCA_API_KEY_ID"]
    secret_key = creds["APCA_API_SECRET_KEY"]
    
    # Initialize Clients
    trade_client = TradingClient(api_key, secret_key, paper=True)
    stream = StockDataStream(api_key, secret_key)
    
    # State tracking
    initial_prices = {}
    
    # Get initial positions to track entry price
    try:
        positions = trade_client.get_all_positions()
        for p in positions:
            if p.symbol in SYMBOLS:
                initial_prices[p.symbol] = float(p.avg_entry_price)
                logging.info(f"Tracking {p.symbol} from entry: ${initial_prices[p.symbol]}")
    except Exception as e:
        logging.error(f"Failed to fetch positions: {e}")
        return

    # If we don't have positions, fetch current price as baseline
    # (Simplified: we only alert on existing positions for now)
    
    async def handle_trade(data):
        symbol = data.symbol
        price = data.price
        
        if symbol not in initial_prices:
            return

        entry = initial_prices[symbol]
        change_pct = (price - entry) / entry
        
        # Check thresholds
        if abs(change_pct) >= THRESHOLDS:
            direction = "UP" if change_pct > 0 else "DOWN"
            msg = f"{symbol} is {direction} {change_pct*100:.2f}% (Price: ${price}, Entry: ${entry})"
            
            # Simple rate limiting (in-memory) could be added here to avoid spam
            # For now, we alert on every tick crossing. 
            # Ideally: alert once, then mute for X mins.
            notify_session(msg)
            
            # Optional: Sleep/Cooldown logic logic would go here
            # removing from tracking to prevent spam for this run?
            # initial_prices.pop(symbol) 

    # Subscribe
    stream.subscribe_trades(handle_trade, *SYMBOLS)

    logging.info(f"Sentinel started. Monitoring {SYMBOLS} for +/- {THRESHOLDS*100}% moves.")
    await stream._run_forever()

if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(run_sentinel())
