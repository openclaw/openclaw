import os
import json
import logging
import requests
import subprocess
from datetime import datetime

# --- Configuration ---
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")
TARGET_CHANNEL_ID = "1469273412357718048"  # #saiabets
SYMBOLS = ["AMZN", "MSTR", "BTCUSD", "POET"]
STATE_FILE = os.path.expanduser("~/.openclaw/workspace/memory/news_scanner_state.json")

# Setup Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def load_creds():
    with open(CRED_PATH, 'r') as f:
        return json.load(f)

def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, 'r') as f:
                return json.load(f)
        except:
            return {"last_seen_ids": []}
    return {"last_seen_ids": []}

def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f)

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
                return sess.get("sessionId") # Return UUID, not Key
        
        return None
    except Exception as e:
        logging.error(f"Failed to resolve session via CLI: {e}")
        return None

def notify_session(headline, summary, url, symbol):
    session_id = find_target_session_id_cli()
    if not session_id:
        logging.warning("No target session found.")
        return

    msg = f"📰 **NEWS ALERT (${symbol}):** {headline}\n_{summary}_\n{url}"
    
    try:
        # Use openclaw agent command (injects directly into runtime)
        cmd = [
            "openclaw", "agent", 
            "--session-id", session_id,
            "--message", msg
        ]
        
        # We run it detached/background or wait? 
        # Waiting is safer to ensure delivery.
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode == 0:
            logging.info(f"Sent news to session: {headline}")
        else:
            logging.error(f"Failed to send via CLI: {result.stderr}")
            
    except Exception as e:
        logging.error(f"Failed to notify: {e}")

def main():
    creds = load_creds()
    state = load_state()
    last_seen_ids = set(state.get("last_seen_ids", []))
    new_seen_ids = set(last_seen_ids)
    
    headers = {
        "APCA-API-KEY-ID": creds["APCA_API_KEY_ID"],
        "APCA-API-SECRET-KEY": creds["APCA_API_SECRET_KEY"]
    }
    
    url = "https://data.alpaca.markets/v1beta1/news"
    params = {
        "symbols": ",".join(SYMBOLS),
        "limit": 5,
        "include_content": "false"
    }
    
    try:
        r = requests.get(url, headers=headers, params=params, timeout=10)
        if r.status_code == 200:
            news_items = r.json().get("news", [])
            
            for item in news_items:
                item_id = str(item.get("id"))
                
                if item_id not in last_seen_ids:
                    headline = item.get("headline")
                    summary = item.get("summary", "")[:150] + "..." if item.get("summary") else ""
                    link = item.get("url")
                    symbols = item.get("symbols", [])
                    primary_symbol = symbols[0] if symbols else "MARKET"
                    
                    print(f"New Story: {headline}")
                    notify_session(headline, summary, link, primary_symbol)
                    new_seen_ids.add(item_id)
            
            # Keep state manageable (keep last 100 IDs)
            final_ids = list(new_seen_ids)
            if len(final_ids) > 100:
                final_ids = final_ids[-100:]
                
            save_state({"last_seen_ids": final_ids})
            
        else:
            logging.error(f"News API Error: {r.text}")
            
    except Exception as e:
        logging.error(f"Scanner failed: {e}")

if __name__ == "__main__":
    main()
