# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "robin_stocks",
#     "pyotp",
# ]
# ///
"""
Robinhood CLI - Query positions, portfolio, and account info.

Usage:
    uv run robinhood.py positions       # List current positions
    uv run robinhood.py portfolio       # Portfolio summary
    uv run robinhood.py quote SYMBOL    # Get quote for symbol
    uv run robinhood.py account         # Account info
    uv run robinhood.py orders          # Recent orders
    uv run robinhood.py dividends       # Dividend history
"""

import argparse
import json
import os
import sys
from pathlib import Path

import robin_stocks.robinhood as rh

# Cache directory for session token
CACHE_DIR = Path.home() / ".cache" / "robinhood"
TOKEN_FILE = CACHE_DIR / "session.json"


def get_credentials():
    """Get credentials from environment or 1Password."""
    username = os.environ.get("ROBINHOOD_USERNAME")
    password = os.environ.get("ROBINHOOD_PASSWORD")
    totp_secret = os.environ.get("ROBINHOOD_TOTP")
    
    if not username or not password:
        print("Error: ROBINHOOD_USERNAME and ROBINHOOD_PASSWORD required", file=sys.stderr)
        print("Set via environment or use: op run --env-file=.env -- uv run robinhood.py ...", file=sys.stderr)
        sys.exit(1)
    
    return username, password, totp_secret


def login():
    """Login to Robinhood with cached session support."""
    username, password, totp_secret = get_credentials()
    
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    
    # Try to use cached session
    if TOKEN_FILE.exists():
        try:
            with open(TOKEN_FILE) as f:
                cached = json.load(f)
            # Attempt login with cached token
            rh.login(username, password, 
                    store_session=True,
                    pickle_name=str(TOKEN_FILE.with_suffix(".pickle")))
            return True
        except Exception:
            pass
    
    # Fresh login
    try:
        if totp_secret:
            import pyotp
            totp = pyotp.TOTP(totp_secret)
            mfa_code = totp.now()
            rh.login(username, password, 
                    mfa_code=mfa_code,
                    store_session=True,
                    pickle_name=str(TOKEN_FILE.with_suffix(".pickle")))
        else:
            # Will prompt for MFA if needed
            rh.login(username, password,
                    store_session=True, 
                    pickle_name=str(TOKEN_FILE.with_suffix(".pickle")))
        
        # Save session info
        with open(TOKEN_FILE, "w") as f:
            json.dump({"username": username}, f)
        
        return True
    except Exception as e:
        print(f"Login failed: {e}", file=sys.stderr)
        sys.exit(1)


def cmd_positions():
    """Show current stock positions."""
    positions = rh.get_open_stock_positions()
    
    if not positions:
        print("No open positions")
        return
    
    print(f"{'Symbol':<8} {'Qty':>10} {'Avg Cost':>12} {'Current':>12} {'P/L':>12} {'P/L %':>8}")
    print("-" * 70)
    
    total_value = 0
    total_cost = 0
    
    for pos in positions:
        symbol = rh.get_symbol_by_url(pos['instrument'])
        qty = float(pos['quantity'])
        avg_cost = float(pos['average_buy_price'])
        
        # Get current price
        quote = rh.get_latest_price(symbol)[0]
        current = float(quote) if quote else 0
        
        position_cost = qty * avg_cost
        position_value = qty * current
        pl = position_value - position_cost
        pl_pct = (pl / position_cost * 100) if position_cost > 0 else 0
        
        total_value += position_value
        total_cost += position_cost
        
        pl_str = f"+${pl:.2f}" if pl >= 0 else f"-${abs(pl):.2f}"
        pl_pct_str = f"+{pl_pct:.1f}%" if pl_pct >= 0 else f"{pl_pct:.1f}%"
        
        print(f"{symbol:<8} {qty:>10.2f} ${avg_cost:>10.2f} ${current:>10.2f} {pl_str:>12} {pl_pct_str:>8}")
    
    total_pl = total_value - total_cost
    total_pl_pct = (total_pl / total_cost * 100) if total_cost > 0 else 0
    
    print("-" * 70)
    print(f"{'TOTAL':<8} {'':<10} ${total_cost:>10.2f} ${total_value:>10.2f} "
          f"{'+$' if total_pl >= 0 else '-$'}{abs(total_pl):.2f} "
          f"{'+' if total_pl_pct >= 0 else ''}{total_pl_pct:.1f}%")


def cmd_portfolio():
    """Show portfolio summary."""
    profile = rh.load_portfolio_profile()
    
    if not profile:
        print("Could not load portfolio")
        return
    
    equity = float(profile.get('equity', 0))
    cash = float(profile.get('withdrawable_amount', 0))
    
    # Get extended hours equity if available
    extended_equity = profile.get('extended_hours_equity')
    if extended_equity:
        extended_equity = float(extended_equity)
    
    print("📊 Portfolio Summary")
    print("-" * 40)
    print(f"Total Equity:      ${equity:,.2f}")
    if extended_equity and extended_equity != equity:
        print(f"Extended Hours:    ${extended_equity:,.2f}")
    print(f"Cash Available:    ${cash:,.2f}")
    print(f"Invested:          ${equity - cash:,.2f}")


def cmd_quote(symbol: str):
    """Get quote for a symbol."""
    symbol = symbol.upper()
    
    quote = rh.get_quotes(symbol)[0]
    fundamentals = rh.get_fundamentals(symbol)[0]
    
    if not quote:
        print(f"Could not find {symbol}")
        return
    
    price = float(quote.get('last_trade_price', 0))
    prev_close = float(quote.get('previous_close', 0))
    change = price - prev_close
    change_pct = (change / prev_close * 100) if prev_close > 0 else 0
    
    bid = quote.get('bid_price', 'N/A')
    ask = quote.get('ask_price', 'N/A')
    
    print(f"📈 {symbol}")
    print("-" * 40)
    print(f"Price:          ${price:.2f}")
    print(f"Change:         {'+' if change >= 0 else ''}{change:.2f} ({'+' if change_pct >= 0 else ''}{change_pct:.2f}%)")
    print(f"Bid/Ask:        ${bid} / ${ask}")
    
    if fundamentals:
        market_cap = fundamentals.get('market_cap')
        pe_ratio = fundamentals.get('pe_ratio')
        div_yield = fundamentals.get('dividend_yield')
        
        if market_cap:
            mc = float(market_cap)
            if mc >= 1e12:
                mc_str = f"${mc/1e12:.2f}T"
            elif mc >= 1e9:
                mc_str = f"${mc/1e9:.2f}B"
            else:
                mc_str = f"${mc/1e6:.2f}M"
            print(f"Market Cap:     {mc_str}")
        
        if pe_ratio:
            print(f"P/E Ratio:      {float(pe_ratio):.2f}")
        
        if div_yield:
            print(f"Div Yield:      {float(div_yield):.2f}%")


def cmd_account():
    """Show account info."""
    account = rh.load_account_profile()
    
    if not account:
        print("Could not load account")
        return
    
    print("👤 Account Info")
    print("-" * 40)
    print(f"Account Number: {account.get('account_number', 'N/A')}")
    print(f"Buying Power:   ${float(account.get('buying_power', 0)):,.2f}")
    print(f"Cash:           ${float(account.get('cash', 0)):,.2f}")
    print(f"Type:           {account.get('type', 'N/A')}")


def cmd_orders():
    """Show recent orders."""
    orders = rh.get_all_stock_orders()
    
    if not orders:
        print("No orders found")
        return
    
    print(f"{'Date':<12} {'Symbol':<8} {'Side':<6} {'Qty':>8} {'Price':>10} {'Status':<12}")
    print("-" * 60)
    
    for order in orders[:10]:  # Last 10 orders
        created = order.get('created_at', '')[:10]
        symbol = rh.get_symbol_by_url(order['instrument'])
        side = order.get('side', '').upper()
        qty = order.get('quantity', '0')
        price = order.get('average_price') or order.get('price', '0')
        status = order.get('state', '').title()
        
        print(f"{created:<12} {symbol:<8} {side:<6} {float(qty):>8.2f} ${float(price):>9.2f} {status:<12}")


def cmd_dividends():
    """Show dividend history."""
    dividends = rh.get_dividends()
    
    if not dividends:
        print("No dividends found")
        return
    
    total = 0
    print(f"{'Date':<12} {'Symbol':<8} {'Amount':>12} {'Status':<12}")
    print("-" * 50)
    
    for div in dividends[:20]:  # Last 20 dividends
        paid_at = div.get('paid_at', div.get('payable_date', ''))[:10]
        symbol = rh.get_symbol_by_url(div['instrument'])
        amount = float(div.get('amount', 0))
        status = div.get('state', '').title()
        
        total += amount
        print(f"{paid_at:<12} {symbol:<8} ${amount:>11.2f} {status:<12}")
    
    print("-" * 50)
    print(f"{'Total':<12} {'':<8} ${total:>11.2f}")


def main():
    parser = argparse.ArgumentParser(description="Robinhood CLI")
    parser.add_argument("command", choices=["positions", "portfolio", "quote", "account", "orders", "dividends"])
    parser.add_argument("symbol", nargs="?", help="Stock symbol (for quote command)")
    
    args = parser.parse_args()
    
    # Login first
    login()
    
    if args.command == "positions":
        cmd_positions()
    elif args.command == "portfolio":
        cmd_portfolio()
    elif args.command == "quote":
        if not args.symbol:
            print("Error: quote requires a symbol", file=sys.stderr)
            sys.exit(1)
        cmd_quote(args.symbol)
    elif args.command == "account":
        cmd_account()
    elif args.command == "orders":
        cmd_orders()
    elif args.command == "dividends":
        cmd_dividends()


if __name__ == "__main__":
    main()
