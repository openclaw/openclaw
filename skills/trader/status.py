import json
import os
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import GetAssetsRequest
from alpaca.trading.enums import AssetClass

# Load credentials
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")

def load_creds():
    with open(CRED_PATH, 'r') as f:
        return json.load(f)

def main():
    creds = load_creds()
    api_key = creds.get("APCA_API_KEY_ID")
    secret_key = creds.get("APCA_API_SECRET_KEY")
    paper = True # Always paper for now

    trading_client = TradingClient(api_key, secret_key, paper=paper)

    account = trading_client.get_account()

    print(f"--- Alpaca Account Status ---")
    print(f"ID: {account.id}")
    print(f"Status: {account.status}")
    print(f"Currency: {account.currency}")
    print(f"Cash: ${account.cash}")
    print(f"Portfolio Value: ${account.portfolio_value}")
    print(f"Buying Power: ${account.buying_power}")
    print(f"Daytrade Count: {account.daytrade_count}")
    
    if float(account.portfolio_value) < 100000:
        print("\nNote: Portfolio is below starting paper balance ($100k).")
    elif float(account.portfolio_value) > 100000:
        gain = float(account.portfolio_value) - 100000
        print(f"\nNote: Current Gain: +${gain:.2f}")

if __name__ == "__main__":
    main()
