#!/usr/bin/env python3
"""OpenBB query helper for OpenClaw skill."""

import argparse
import json
import sys
from datetime import datetime, timedelta


def get_obb():
    """Import and return the OpenBB SDK."""
    try:
        from openbb import obb
        return obb
    except ImportError:
        print("Error: openbb not installed. Run: pip install openbb", file=sys.stderr)
        sys.exit(1)


def format_table(df, max_rows=20):
    """Format a DataFrame as a readable table."""
    if df is None or df.empty:
        return "No data available."
    if len(df) > max_rows:
        df = df.tail(max_rows)
    return df.to_string()


def format_output(result, output_format="table", max_rows=20):
    """Format OpenBB result based on output preference."""
    try:
        df = result.to_dataframe()
    except Exception:
        # Some results don't have to_dataframe
        try:
            return json.dumps(result.to_dict(), indent=2, default=str)
        except Exception:
            return str(result)

    if output_format == "json":
        return df.to_json(orient="records", indent=2, date_format="iso")
    elif output_format == "csv":
        return df.to_csv()
    else:
        return format_table(df, max_rows)


def cmd_price(args):
    obb = get_obb()
    start = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
    result = obb.equity.price.historical(
        args.symbols[0],
        start_date=start,
        provider=args.provider,
    )
    print(format_output(result, args.output))


def cmd_quote(args):
    obb = get_obb()
    for symbol in args.symbols:
        try:
            result = obb.equity.price.historical(
                symbol, provider=args.provider,
            )
            df = result.to_dataframe()
            if not df.empty:
                last = df.iloc[-1]
                prev = df.iloc[-2] if len(df) > 1 else last
                change = ((last["close"] - prev["close"]) / prev["close"]) * 100
                arrow = "📈" if change > 0 else "📉" if change < 0 else "➡️"
                print(f"{symbol}: ${last['close']:.2f} {arrow} {change:+.2f}% | Vol: {int(last['volume']):,}")
        except Exception as e:
            print(f"{symbol}: Error - {e}", file=sys.stderr)


def cmd_search(args):
    obb = get_obb()
    query = " ".join(args.symbols)
    result = obb.equity.search(query, provider=args.provider)
    print(format_output(result, args.output, max_rows=args.limit))


def cmd_news(args):
    obb = get_obb()
    symbol = args.symbols[0] if args.symbols else None
    try:
        if symbol:
            result = obb.news.company(symbol=symbol, limit=args.limit, provider=args.provider)
        else:
            result = obb.news.world(limit=args.limit, provider=args.provider)
        print(format_output(result, args.output, max_rows=args.limit))
    except Exception as e:
        print(f"News query failed: {e}", file=sys.stderr)


def cmd_fundamentals(args, statement_type):
    obb = get_obb()
    symbol = args.symbols[0]
    fn_map = {
        "income": obb.equity.fundamental.income,
        "balance": obb.equity.fundamental.balance,
        "cash": obb.equity.fundamental.cash,
    }
    fn = fn_map[statement_type]
    result = fn(symbol, period=args.period, limit=args.limit, provider=args.provider)
    print(format_output(result, args.output))


def cmd_crypto(args):
    obb = get_obb()
    symbol = args.symbols[0]
    start = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
    result = obb.crypto.price.historical(symbol, start_date=start, provider=args.provider)
    print(format_output(result, args.output))


def cmd_forex(args):
    obb = get_obb()
    pair = args.symbols[0].replace("/", "")
    start = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
    result = obb.currency.price.historical(pair, start_date=start, provider=args.provider)
    print(format_output(result, args.output))


def cmd_etf(args):
    obb = get_obb()
    symbol = args.symbols[0]
    start = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
    result = obb.etf.historical(symbol, start_date=start, provider=args.provider)
    print(format_output(result, args.output))


def cmd_index(args):
    obb = get_obb()
    symbol = args.symbols[0]
    start = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
    result = obb.index.price.historical(symbol, start_date=start, provider=args.provider)
    print(format_output(result, args.output))


def cmd_economy(args):
    obb = get_obb()
    indicator = args.symbols[0] if args.symbols else "GDP"
    try:
        result = obb.economy.gdp.nominal(provider="oecd")
        print(format_output(result, args.output))
    except Exception as e:
        print(f"Economy query failed: {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="OpenBB query helper for OpenClaw")
    parser.add_argument("--provider", "-p", default="yfinance", help="Data provider")
    parser.add_argument("--output", "-o", default="table", choices=["table", "json", "csv"])
    parser.add_argument("--days", "-d", type=int, default=30, help="Lookback days")
    parser.add_argument("--period", default="annual", choices=["annual", "quarter"])
    parser.add_argument("--limit", "-l", type=int, default=10, help="Result limit")

    subparsers = parser.add_subparsers(dest="command", required=True)

    for cmd in ["price", "quote", "search", "news", "crypto", "forex", "etf", "index", "economy"]:
        p = subparsers.add_parser(cmd)
        p.add_argument("symbols", nargs="*", default=[])

    for cmd in ["income", "balance", "cash"]:
        p = subparsers.add_parser(cmd)
        p.add_argument("symbols", nargs="+")

    args = parser.parse_args()

    cmd_map = {
        "price": cmd_price,
        "quote": cmd_quote,
        "search": cmd_search,
        "news": cmd_news,
        "income": lambda a: cmd_fundamentals(a, "income"),
        "balance": lambda a: cmd_fundamentals(a, "balance"),
        "cash": lambda a: cmd_fundamentals(a, "cash"),
        "crypto": cmd_crypto,
        "forex": cmd_forex,
        "etf": cmd_etf,
        "index": cmd_index,
        "economy": cmd_economy,
    }

    cmd_map[args.command](args)


if __name__ == "__main__":
    main()
