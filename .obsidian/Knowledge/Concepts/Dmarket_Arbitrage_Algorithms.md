# Dmarket Arbitrage & Pricing Algorithms

#v16_knowledge #dmarket #algorithms #pricing #arbitrage

## Table of Contents

- [Bid-Ask Spread Analysis](#bid-ask-spread-analysis)
- [Arbitrage Detection Algorithm](#arbitrage-detection-algorithm)
- [Dynamic Pricing Model](#dynamic-pricing-model)
- [Float Value Premium Calculator](#float-value-premium-calculator)
- [Inventory Optimization](#inventory-optimization)

## Bid-Ask Spread Analysis

```python
def calculate_spread(
    lowest_offer: int,   # Cheapest sell listing (cents)
    highest_target: int,  # Highest buy order (cents)
    fee_rate: float = 0.05,
) -> dict:
    """Calculate bid-ask spread and profitability.

    Returns dict with spread metrics.
    All prices in cents.
    """
    net_sell = int(lowest_offer * (1 - fee_rate))
    spread = lowest_offer - highest_target
    spread_pct = (spread / lowest_offer * 100) if lowest_offer else 0

    # Profit if we buy at target and sell at offer
    profit = net_sell - highest_target
    roi = (profit / highest_target * 100) if highest_target else 0

    return {
        "lowest_offer": lowest_offer,
        "highest_target": highest_target,
        "spread_cents": spread,
        "spread_pct": round(spread_pct, 2),
        "net_proceeds": net_sell,
        "profit_cents": profit,
        "roi_pct": round(roi, 2),
        "profitable": profit > 0,
    }
```

> «A healthy market item has 3-8% spread. Items with >15% spread are illiquid and risky. Items with <2% spread have high volume but razor-thin margins.» — Skin Trading Analytics

## Arbitrage Detection Algorithm

```python
from dataclasses import dataclass

@dataclass
class ArbitrageOpportunity:
    title: str
    buy_price: int        # cents
    sell_price: int       # cents
    profit: int           # cents after fees
    roi_pct: float
    volume_24h: int
    risk_score: float     # 0.0 (safe) to 1.0 (risky)

def scan_arbitrage(
    items: list[dict],
    min_profit: int = 50,       # $0.50 минимум
    min_roi: float = 3.0,       # 3% ROI минимум
    min_volume: int = 5,        # 5 продаж/день минимум
    fee_rate: float = 0.05,
) -> list[ArbitrageOpportunity]:
    """Scan market for arbitrage opportunities."""
    opportunities = []

    for item in items:
        lowest = item.get("lowestOffer", 0)
        highest = item.get("highestTarget", 0)
        volume = item.get("salesLast24h", 0)

        if not lowest or not highest or not volume:
            continue

        net_sell = int(lowest * (1 - fee_rate))
        profit = net_sell - highest
        roi = (profit / highest * 100) if highest > 0 else 0

        if profit >= min_profit and roi >= min_roi and volume >= min_volume:
            # Risk scoring: lower volume + higher spread = higher risk
            risk = min(1.0, (1 / max(volume, 1)) * 10 + (0.01 if roi > 20 else 0))

            opportunities.append(ArbitrageOpportunity(
                title=item["title"],
                buy_price=highest,
                sell_price=lowest,
                profit=profit,
                roi_pct=round(roi, 2),
                volume_24h=volume,
                risk_score=round(risk, 3),
            ))

    # Sort by risk-adjusted profit
    opportunities.sort(key=lambda x: x.profit * (1 - x.risk_score), reverse=True)
    return opportunities
```

## Dynamic Pricing Model

```python
def calculate_optimal_price(
    avg_price_7d: int,
    avg_price_30d: int,
    current_lowest: int,
    inventory_count: int,
    target_sell_time_hours: int = 24,
) -> int:
    """Calculate optimal listing price based on market dynamics.

    Strategy:
    - Price trending up → price closer to avg_7d
    - Price trending down → undercut current_lowest
    - High inventory → more aggressive pricing
    """
    trend = (avg_price_7d - avg_price_30d) / max(avg_price_30d, 1)

    if trend > 0.05:  # Price rising >5%
        base_price = int(avg_price_7d * 1.02)  # Slight premium
    elif trend < -0.05:  # Price falling >5%
        base_price = int(current_lowest * 0.98)  # Undercut
    else:
        base_price = int((avg_price_7d + current_lowest) / 2)

    # Inventory pressure: more items = lower price
    if inventory_count > 5:
        pressure = min(0.10, inventory_count * 0.01)
        base_price = int(base_price * (1 - pressure))

    return max(base_price, 1)  # Minimum 1 cent
```

## Float Value Premium Calculator

```python
FLOAT_BRACKETS = {
    "factory-new":    (0.00, 0.07),
    "minimal-wear":   (0.07, 0.15),
    "field-tested":   (0.15, 0.38),
    "well-worn":      (0.38, 0.45),
    "battle-scarred": (0.45, 1.00),
}

def float_premium_pct(float_value: float, exterior: str) -> float:
    """Calculate premium/discount based on float value within bracket.

    Lower float within bracket = premium.
    Returns multiplier (1.0 = no premium, 1.15 = 15% premium).
    """
    bracket = FLOAT_BRACKETS.get(exterior)
    if not bracket:
        return 1.0

    low, high = bracket
    position = (float_value - low) / (high - low)  # 0.0 = best, 1.0 = worst

    # Premium curve: best float = +20%, worst = -5%
    premium = 0.20 * (1 - position) - 0.05 * position
    return 1.0 + premium
```

## Inventory Optimization

```python
def portfolio_rebalance(
    inventory: list[dict],
    target_allocation: dict[str, float],
) -> list[dict]:
    """Suggest trades to rebalance inventory toward target allocation.

    target_allocation: {"rifle": 0.4, "knife": 0.3, "pistol": 0.2, "other": 0.1}
    """
    total_value = sum(item["price"] for item in inventory)

    current = {}
    for item in inventory:
        cat = item.get("category", "other").lower()
        current[cat] = current.get(cat, 0) + item["price"]

    actions = []
    for category, target_pct in target_allocation.items():
        current_pct = current.get(category, 0) / max(total_value, 1)
        diff = target_pct - current_pct

        if abs(diff) > 0.05:  # >5% deviation
            action = "buy" if diff > 0 else "sell"
            amount = abs(int(diff * total_value))
            actions.append({
                "category": category,
                "action": action,
                "amount_cents": amount,
                "current_pct": round(current_pct * 100, 1),
                "target_pct": round(target_pct * 100, 1),
            })

    return actions
```

---

_Сгенерировано Knowledge Expansion v16.5_
