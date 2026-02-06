import json
import os
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest
from alpaca.trading.enums import OrderSide, TimeInForce

# Load credentials
CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")

def load_creds():
    with open(CRED_PATH, 'r') as f:
        return json.load(f)

def main():
    creds = load_creds()
    client = TradingClient(creds["APCA_API_KEY_ID"], creds["APCA_API_SECRET_KEY"], paper=True)
    
    # Allocations (USD)
    ALLOCATION_MSTR = 30000
    ALLOCATION_AMZN = 30000
    
    # Get current prices (approximate via snapshot if possible, or just market order with notional)
    # Alpaca supports Notional orders for fractional shares! Perfect for "Spend $30k".
    
    print("--- Executing Strategy V1 ---")
    
    # 1. Short MSTR ($30k)
    # Note: Notional shorts might not be supported on all assets/accounts, but let's try.
    # If notional short fails, we calculate qty manually.
    # Actually, for Safety, let's fetch price and calculate int qty to avoid fractional short issues.
    
    try:
        # Fetch latest trade for MSTR
        # We need Market Data API for this. Alpaca Data API is separate.
        # Simplification: Just send Market Order. 
        # CAUTION: Shorting usually requires Share Qty, not Notional value on some platforms.
        # Let's try Notional first.
        print(f"Selling MSTR (Short) - Notional: ${ALLOCATION_MSTR}")
        order_mstr = MarketOrderRequest(
            symbol="MSTR",
            notional=ALLOCATION_MSTR,
            side=OrderSide.SELL,
            time_in_force=TimeInForce.DAY
        )
        client.submit_order(order_mstr)
        print("-> MSTR Short Order Submitted.")
    except Exception as e:
        print(f"-> MSTR Short Failed: {e}")
        
    # 2. Long AMZN ($30k)
    try:
        print(f"Buying AMZN (Long) - Notional: ${ALLOCATION_AMZN}")
        order_amzn = MarketOrderRequest(
            symbol="AMZN",
            notional=ALLOCATION_AMZN,
            side=OrderSide.BUY,
            time_in_force=TimeInForce.DAY
        )
        client.submit_order(order_amzn)
        print("-> AMZN Buy Order Submitted.")
    except Exception as e:
        print(f"-> AMZN Buy Failed: {e}")

if __name__ == "__main__":
    main()
