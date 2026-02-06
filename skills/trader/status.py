import os
import json
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import GetOrdersRequest
from alpaca.trading.enums import OrderStatus, QueryOrderStatus

CRED_PATH = os.path.expanduser("~/.openclaw/credentials/alpaca_credentials.json")

def main():
    with open(CRED_PATH, 'r') as f:
        creds = json.load(f)
    
    client = TradingClient(creds["APCA_API_KEY_ID"], creds["APCA_API_SECRET_KEY"], paper=True)
    
    try:
        # Check Positions
        positions = client.get_all_positions()
        print(f"--- POSITIONS ({len(positions)}) ---")
        for p in positions:
            print(f"[{p.symbol}] {p.qty} @ ${float(p.avg_entry_price):.2f} | PnL: {p.unrealized_plpc}")

        # Check Open Orders (Correct V2 Syntax)
        request_params = GetOrdersRequest(status=QueryOrderStatus.OPEN)
        orders = client.get_orders(filter=request_params)
        
        print(f"\n--- OPEN ORDERS ({len(orders)}) ---")
        for o in orders:
            # Calculate value if possible
            qty = float(o.qty) if o.qty else 0
            # For market orders, price might be None, estimate?
            print(f"[{o.symbol}] {o.side} {qty} shares ({o.type}) | ID: {o.id}")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()
