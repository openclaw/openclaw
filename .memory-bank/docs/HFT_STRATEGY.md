# HFT Strategy on Steam & DMarket for CS2 (2025/2026)

## 1. High-Frequency Trading & Arbitrage Basics
High-Frequency Trading (HFT) conceptually relies on making a large number of trades at extremely fast speeds to capture tiny profit margins (spreads) with minimal risk exposure. In the context of CS2 (Counter-Strike 2) items on platforms like Steam and DMarket:
- **Order Book Mechanics**: DMarket operates an order book with Buy Targets (bids) and Sell Offers (asks).
- **Spread**: The difference between the highest Buy Target and the lowest Sell Offer. Arbitrageurs aim to buy at the bid and sell at the ask.
- **Liquidity**: Mil-Spec grade weapons, cases, and popular stickers provide the highest trading volume, enabling bots to flip items quickly without getting stuck with illiquid capital.

## 2. Platform Mechanics & The 7-Day Trade Hold
### Steam's 7-Day Hold
When a CS2 item is traded on Steam, it receives a 7-day trade lock. This is the **primary bottleneck** for true HFT in CS2:
- You cannot buy an item and immediately transfer it to another user or bot account. 
- Fast "flipping" is restricted to marketplaces that hold the items in their own P2P infrastructure or internal economy (like DMarket's balance system).

### DMarket Mechanics (Targets vs Targets)
1. **Target (Buy Order)**: You place a commitment to buy a specific item at a specific price. If a user tries to instant-sell, your target is filled.
2. **Offer (Sell Listing)**: You list an item you own for a specific price.

Because of the 7-day lock, if you buy an item on DMarket via a Target, returning it to the market as a Sell Offer means it will be listed with an existing trade lock (e.g., "Tradeable in 7 days"). Items with trade locks traditionally sell at a discount compared to instantly tradeable items.

## 3. Mathematical Formula for Spread & ROI
To ensure a trade is profitable, the Gross Spread must overcome all platform fees. DMarket typically charges a base sale fee (often around 1-5% depending on subscriptions/volume, standard is ~3-5% for CS2 items).

Let:
- $P_{buy}$ = Execution price of Buy Target
- $P_{sell}$ = Execution price of Sell Offer
- $F_{DMarket}$ = DMarket sale fee (e.g., 5% or 0.05)

**Net Profit ($) = P_{sell} * (1 - F_{DMarket}) - P_{buy}**

**ROI (%) = (Net Profit / P_{buy}) * 100**

### Arbitrage Conditions
For a bot to place a Target, the current lowest Sell Offer ($Ask_{current}$) must satisfy:
$Ask_{current} * (1 - F_{DMarket}) > P_{buy} + Minimum\_Desired\_Profit$

### DMarket Specifics:
Target placement is highly competitive. An HFT bot must:
1. Identify high-volume items (AK-47 | Slate, Redline, Prisma Cases).
2. Scan the current best Target ($Bid_{current}$).
3. Overcut the target by $0.01 ($Bid_{current} + 0.01) if the projected ROI > threshold (e.g., 2%).
4. Manage exposure (don't buy 500 items if the daily volume is 50).

## 4. Conclusion
True HFT (microseconds) does not exist in CS2 due to API rate limits (DMarket restricts to <= 2 Requests Per Second). Instead, this is **Medium-Frequency Statistical Arbitrage**. The 7-day lock forces us to rely heavily on items where the discount for locked items is negligible, or to use the exchange loops purely within DMarket's internal system if they allow listing locked items for sale.
