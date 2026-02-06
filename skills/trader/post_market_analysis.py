import os
import json
import logging
import subprocess
import requests
from datetime import datetime

# --- Configuration ---
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")
TARGET_CHANNEL_ID = "1469273412357718048"  # #saiabets
MEMORY_DIR = os.path.expanduser("~/.openclaw/workspace/memory/market_lessons")
os.makedirs(MEMORY_DIR, exist_ok=True)

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
                return sess.get("sessionId")
        return None
    except Exception as e:
        logging.error(f"Failed to resolve session via CLI: {e}")
        return None

def notify_session(message):
    session_id = find_target_session_id_cli()
    if not session_id:
        logging.warning("No target session found.")
        return

    try:
        cmd = ["openclaw", "agent", "--session-id", session_id, "--message", message]
        subprocess.run(cmd, capture_output=True, text=True)
        logging.info("Sent analysis to session.")
    except Exception as e:
        logging.error(f"Failed to notify: {e}")

def get_market_movers(creds):
    """Fetches Top Gainers and Losers via Alpaca Screener API."""
    url = "https://data.alpaca.markets/v1beta1/screener/stocks/movers"
    headers = {
        "APCA-API-KEY-ID": creds["APCA_API_KEY_ID"],
        "APCA-API-SECRET-KEY": creds["APCA_API_SECRET_KEY"]
    }
    params = {"top": 10} 
    
    try:
        r = requests.get(url, headers=headers, params=params, timeout=10)
        if r.status_code == 200:
            return r.json()
        else:
            logging.error(f"Alpaca API Error: {r.text}")
            return {"gainers": [], "losers": []}
    except Exception as e:
        logging.error(f"Failed to fetch movers: {e}")
        return {"gainers": [], "losers": []}

def format_section(title, movers, is_gainers=True):
    lines = [f"**{title}**"]
    count = 0
    for m in movers:
        sym = m.get("symbol")
        price = float(m.get("price", 0))
        pct = float(m.get("percent_change", 0))
        
        # Filter: Ignore penny stocks < $2 to keep it relevant
        if price > 2.0:
            icon = "🟢" if is_gainers else "🔴"
            lines.append(f"{icon} **${sym}**: {pct:+.2f}% (${price:.2f})")
            count += 1
            if count >= 5: break # Top 5 relevant
            
    if count == 0:
        lines.append("_No significant movers >$2 found._")
        
    return "\n".join(lines)

def main():
    creds = load_creds()
    data = get_market_movers(creds)
    
    today = datetime.now().strftime("%Y-%m-%d")
    report = [f"📊 **Daily Market Movers Report ({today})**\n"]
    
    report.append(format_section("🚀 Top Gainers", data.get("gainers", []), True))
    report.append("") # Spacer
    report.append(format_section("📉 Top Losers", data.get("losers", []), False))
    
    final_msg = "\n".join(report)
        
    # Save to memory for record keeping
    with open(f"{MEMORY_DIR}/{today}.md", "w") as f:
        f.write(final_msg)
            
    notify_session(final_msg)

if __name__ == "__main__":
    main()
