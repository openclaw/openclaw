import time
import random

class MockDMarketAPI:
    def __init__(self):
        self.order_book = {
            "AK-47 | Slate (Field-Tested)": {
                "bids": [1.45, 1.44, 1.40], # Users willing to buy (Targets)
                "asks": [1.60, 1.62, 1.65]  # Users selling (Offers)
            }
        }
        self.inventory = []
        self.balance = 100.00
        self.fee = 0.05 # 5% DMarket Fee
        
        print("[System] DMarket Sandbox API Initialized. Balance: $100.00")

    def get_market_data(self, item_name):
        return self.order_book.get(item_name)
        
    def place_buy_target(self, item_name, price):
        print(f"[API] Placed Buy Target for {item_name} at ${price:.2f}")
        self.balance -= price
        # Simulate someone instantly fulfilling the target
        time.sleep(0.5)
        print(f"[API] 🟢 Target Fulfilled! {item_name} added to inventory.")
        self.inventory.append({"name": item_name, "bought_at": price})
        
    def place_sell_offer(self, item_name, price):
        print(f"[API] Placed Sell Offer for {item_name} at ${price:.2f}")
        # Simulate someone buying our offer
        time.sleep(0.5)
        print(f"[API] 🟢 Offer Bought! Sold {item_name} for ${price:.2f}.")
        revenue = price * (1 - self.fee)
        self.balance += revenue
        print(f"[API] Net Revenue after 5% fee: ${revenue:.2f}")
        

class ArkadyHFTLogic:
    def __init__(self, api: MockDMarketAPI):
        self.api = api
        
    def analyze_and_trade(self, item_name):
        print(f"\n[Arkady] Analyzing {item_name}...")
        market = self.api.get_market_data(item_name)
        if not market:
            return
            
        best_bid = max(market["bids"])
        best_ask = min(market["asks"])
        
        print(f"[Arkady] Order Book - Best Bid: ${best_bid:.2f} | Best Ask: ${best_ask:.2f}")
        
        # Calculate optimal strategy: overcut bid, undercut ask
        my_bid = best_bid + 0.01
        my_ask = best_ask - 0.01
        
        # Expected Net Profit
        expected_revenue = my_ask * (1 - self.api.fee)
        expected_profit = expected_revenue - my_bid
        roi = (expected_profit / my_bid) * 100
        
        print(f"[Arkady] Strategy: Buy @ ${my_bid:.2f}, Sell @ ${my_ask:.2f} (Fee: 5%)")
        print(f"[Arkady] Projected Net Profit: ${expected_profit:.2f} | Expected ROI: {roi:.2f}%")
        
        if expected_profit > 0:
            print("[Arkady] Strategy is PROFITABLE. Executing trade sequence...")
            self.api.place_buy_target(item_name, my_bid)
            item = self.api.inventory.pop(0)
            self.api.place_sell_offer(item_name, my_ask)
            
            actual_profit = self.api.balance - 100.00
            print(f"[Arkady] Trade Complete. Total Actual Profit: ${actual_profit:.2f}. Final Balance: ${self.api.balance:.2f}")
        else:
            print("[Arkady] 🛑 ERROR: Negative spread after fees. Trade aborted.")

if __name__ == "__main__":
    print("=== DMarket HFT Sandbox Simulator ===")
    mock_api = MockDMarketAPI()
    arkady = ArkadyHFTLogic(mock_api)
    
    arkady.analyze_and_trade("AK-47 | Slate (Field-Tested)")
