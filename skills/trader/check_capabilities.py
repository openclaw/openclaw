import json
import os
from alpaca.trading.client import TradingClient

# Load credentials
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")

def load_creds():
    with open(CRED_PATH, 'r') as f:
        return json.load(f)

def main():
    creds = load_creds()
    api_key = creds.get("APCA_API_KEY_ID")
    secret_key = creds.get("APCA_API_SECRET_KEY")
    
    client = TradingClient(api_key, secret_key, paper=True)
    account = client.get_account()

    print(f"--- Account Capabilities ---")
    print(f"Shorting Enabled: {account.shorting_enabled}")
    print(f"Multiplier: {account.multiplier}")
    print(f"Buying Power: ${account.buying_power}")
    print(f"RegT Buying Power: ${account.regt_buying_power}")
    print(f"Daytrading Buying Power: ${account.daytrading_buying_power}")
    
    # Check if we can find MSTR and if it's shortable
    try:
        asset = client.get_asset("MSTR")
        print(f"\n--- MSTR Asset Status ---")
        print(f"Tradable: {asset.tradable}")
        print(f"Shortable: {asset.shortable}")
        print(f"Easy to Borrow: {asset.easy_to_borrow}")
        print(f"Marginable: {asset.marginable}")
    except Exception as e:
        print(f"Error checking MSTR: {e}")

if __name__ == "__main__":
    main()
