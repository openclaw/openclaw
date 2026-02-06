import json
import os
import requests
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce

# Load credentials
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")

def load_creds():
    with open(CRED_PATH, 'r') as f:
        return json.load(f)

def get_current_price(symbol, api_key, secret_key):
    # Use Alpaca Data API (REST) for single snapshot
    # Or simplified: use the trading client to get a quote (if supported) or just estimate from latest trade
    # Constructing raw request to Data API for simplicity
    url = f"https://data.alpaca.markets/v2/stocks/{symbol}/trades/latest"
    headers = {
        "APCA-API-KEY-ID": api_key,
        "APCA-API-SECRET-KEY": secret_key
    }
    r = requests.get(url, headers=headers)
    if r.status_code == 200:
        return r.json()["trade"]["p"]
    else:
        raise Exception(f"Failed to fetch price for {symbol}: {r.text}")

def main():
    creds = load_creds()
    client = TradingClient(creds["APCA_API_KEY_ID"], creds["APCA_API_SECRET_KEY"], paper=True)
    
    ALLOCATION_MSTR = 30000
    SYMBOL = "MSTR"
    
    print(f"--- Correcting MSTR Short ---")
    
    try:
        price = get_current_price(SYMBOL, creds["APCA_API_KEY_ID"], creds["APCA_API_SECRET_KEY"])
        print(f"Current {SYMBOL} Price: ${price}")
        
        # Calculate integer shares
        qty = int(ALLOCATION_MSTR // price)
        print(f"Calculated Qty: {qty} shares (~${qty * price:.2f})")
        
        if qty > 0:
            order_mstr = MarketOrderRequest(
                symbol=SYMBOL,
                qty=qty,
                side=OrderSide.SELL,
                time_in_force=TimeInForce.DAY
            )
            client.submit_order(order_mstr)
            print("-> MSTR Short Order Submitted (Integer Qty).")
        else:
            print("-> Qty is 0, allocation too small?")
            
    except Exception as e:
        print(f"-> MSTR Short Failed: {e}")

if __name__ == "__main__":
    main()
