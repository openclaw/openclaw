#!/usr/bin/env python3
import asyncio
import json
import os
import sys
import traceback
from decimal import Decimal

from ostium_python_sdk.sdk import OstiumSDK

READ_ACTIONS = {
    "get_pairs",
    "get_open_trades",
    "get_open_trade_metrics",
    "get_target_funding_rate",
    "get_pair_max_leverage",
    "get_pair_overnight_max_leverage",
    "get_rollover_rate",
    "get_funding_rate",
}

WRITE_ACTIONS = {
    "open_trade",
    "close_trade",
    "cancel_limit_order",
    "update_tp",
    "update_sl",
}

SUPPORTED_ACTIONS = READ_ACTIONS | WRITE_ACTIONS
SUPPORTED_NETWORKS = {"mainnet", "testnet"}


MARKET_ORDER = "MARKET"
ORDER_TYPE_VALUES = {"MARKET", "LIMIT", "STOP"}


def to_plain(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes):
        return f"0x{value.hex()}"
    if isinstance(value, bytearray):
        return f"0x{bytes(value).hex()}"
    if isinstance(value, dict):
        return {str(k): to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_plain(v) for v in value]

    if hasattr(value, "items") and callable(getattr(value, "items")):
        try:
            return {str(k): to_plain(v) for k, v in value.items()}
        except Exception:
            pass

    if hasattr(value, "hex") and callable(getattr(value, "hex")):
        try:
            hex_value = value.hex()
            if isinstance(hex_value, str):
                return hex_value if hex_value.startswith("0x") else f"0x{hex_value}"
        except Exception:
            pass

    return value


def _find_value(payload, keys):
    for key in keys:
        if key in payload and payload.get(key) is not None:
            return payload.get(key)

    # Allow top-level aliases to be passed inside tradeParams as well.
    trade_params = payload.get("tradeParams")
    if isinstance(trade_params, dict):
        for key in keys:
            if key in trade_params and trade_params.get(key) is not None:
                return trade_params.get(key)

    return None


def require_int(payload, key, aliases=None):
    keys = [key] + (aliases or [])
    value = _find_value(payload, keys)
    if value is None:
        accepted = ", ".join(keys)
        raise ValueError(f"Missing required field: {key} (accepted: {accepted})")
    return int(value)


def require_float(payload, key, aliases=None):
    keys = [key] + (aliases or [])
    value = _find_value(payload, keys)
    if value is None:
        accepted = ", ".join(keys)
        raise ValueError(f"Missing required field: {key} (accepted: {accepted})")
    return float(value)


def _as_float(value, field_name):
    try:
        return float(value)
    except Exception as error:
        raise ValueError(f"Invalid numeric value for {field_name}: {value}") from error


def _as_int(value, field_name):
    try:
        return int(value)
    except Exception as error:
        raise ValueError(f"Invalid integer value for {field_name}: {value}") from error


def _optional_float(payload, key, aliases=None):
    keys = [key] + (aliases or [])
    value = _find_value(payload, keys)
    if value is None:
        return None
    return _as_float(value, key)


def _optional_str(payload, key, aliases=None):
    keys = [key] + (aliases or [])
    value = _find_value(payload, keys)
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _required_value(payload, key, aliases=None):
    keys = [key] + (aliases or [])
    value = _find_value(payload, keys)
    if value is None:
        accepted = ", ".join(keys)
        raise ValueError(f"Missing required field: {key} (accepted: {accepted})")
    return value


def _normalize_order_type(payload):
    raw_order_type = _find_value(payload, ["order_type", "orderType", "type"])
    if raw_order_type is None:
        return MARKET_ORDER

    if isinstance(raw_order_type, (int, float)):
        enum_value = int(raw_order_type)
        enum_map = {0: "MARKET", 1: "LIMIT", 2: "STOP"}
        if enum_value in enum_map:
            return enum_map[enum_value]
        raise ValueError(
            f"Invalid order_type enum value: {raw_order_type}. Use 0(MARKET), 1(LIMIT), or 2(STOP)."
        )

    order_type = str(raw_order_type).strip().upper()
    if order_type == "MKT":
        order_type = "MARKET"
    if order_type not in ORDER_TYPE_VALUES:
        raise ValueError(f"Invalid order_type: {raw_order_type}. Use MARKET, LIMIT, or STOP.")
    return order_type


def _normalize_direction(payload):
    raw_direction = _find_value(payload, ["direction", "side", "isLong", "is_long", "buy"])
    if raw_direction is None:
        raise ValueError(
            "Missing trade direction. Provide direction as long/short, true/false, or 0/1."
        )

    if isinstance(raw_direction, bool):
        return raw_direction

    if isinstance(raw_direction, (int, float)):
        direction = int(raw_direction)
        # Accept common enum style where 0 = long, 1 = short.
        if direction == 0:
            return True
        if direction == 1:
            return False
        if direction == -1:
            return False
        raise ValueError(
            f"Invalid numeric direction: {raw_direction}. Use 0(long) or 1(short), or true/false."
        )

    direction_value = str(raw_direction).strip().lower()
    if direction_value in {"long", "buy", "bull", "true", "t", "1"}:
        return True
    if direction_value in {"short", "sell", "bear", "false", "f", "0"}:
        return False

    raise ValueError(
        f"Invalid direction: {raw_direction}. Use long/short, true/false, or 0/1."
    )


def _normalize_collateral_symbol(payload):
    raw_collateral_symbol = _find_value(
        payload,
        [
            "collateralSymbol",
            "collateral_symbol",
            "collateralCurrency",
            "collateral_currency",
            "collateralAsset",
            "collateral_asset",
        ],
    )
    if raw_collateral_symbol is None:
        return "USDC"

    collateral_symbol = str(raw_collateral_symbol).strip().upper()
    if collateral_symbol in {"USDC", "USD"}:
        return "USDC"
    raise ValueError(
        f"Unsupported collateral asset: {raw_collateral_symbol}. This runner currently supports USDC collateral only."
    )


async def _resolve_open_trade_pair_id(sdk, payload):
    pair_candidate = _find_value(payload, ["pairIndex", "pair_index", "pairId", "pair_id"])
    asset_type_candidate = _find_value(payload, ["asset_type", "assetType"])

    if pair_candidate is not None and asset_type_candidate is not None:
        pair_id = _as_int(pair_candidate, "pairIndex")
        asset_type = _as_int(asset_type_candidate, "asset_type")
        if pair_id != asset_type:
            raise ValueError(
                f"Conflicting pair values: pairIndex={pair_id} vs asset_type={asset_type}."
            )
        return pair_id

    if pair_candidate is not None:
        return _as_int(pair_candidate, "pairIndex")

    if asset_type_candidate is not None:
        try:
            return _as_int(asset_type_candidate, "asset_type")
        except ValueError:
            pass

    symbol_candidate = _find_value(
        payload,
        ["symbol", "pair", "pairSymbol", "pair_symbol", "market", "instrument"],
    )
    if symbol_candidate is None:
        raise ValueError(
            "Missing pair selector. Provide pairIndex/pair_id/asset_type (numeric), or symbol like BTC/USD."
        )

    symbol = str(symbol_candidate).strip().upper().replace("-", "/")
    if not symbol:
        raise ValueError("Invalid empty symbol for open_trade.")

    if "/" in symbol:
        base, quote = [part.strip() for part in symbol.split("/", 1)]
        if not base:
            raise ValueError(f"Invalid symbol: {symbol_candidate}")
        if not quote:
            quote = "USD"
    else:
        base = symbol
        quote = "USD"

    pairs = await sdk.get_formatted_pairs_details(False)
    matches = [pair for pair in pairs if pair.get("from") == base and pair.get("to") == quote]
    if not matches:
        raise ValueError(
            f"Unable to resolve symbol {symbol_candidate} to a pair id. Use pairIndex or asset_type."
        )
    if len(matches) > 1:
        raise ValueError(
            f"Symbol {symbol_candidate} resolved to multiple pairs. Provide pairIndex explicitly."
        )
    return int(matches[0]["id"])


async def _resolve_market_price_for_pair_id(sdk, pair_id):
    pair_details = await sdk.subgraph.get_pair_details(pair_id)
    base_symbol = str(pair_details.get("from") or "").strip().upper()
    quote_symbol = str(pair_details.get("to") or "").strip().upper()
    if not base_symbol or not quote_symbol:
        raise ValueError(f"Could not resolve pair symbols for pair id {pair_id}.")

    mid_price, is_market_open, is_day_trading_closed = await sdk.price.get_price(
        base_symbol, quote_symbol
    )
    return float(mid_price), {
        "from": base_symbol,
        "to": quote_symbol,
        "isMarketOpen": bool(is_market_open),
        "isDayTradingClosed": bool(is_day_trading_closed),
    }


async def _normalize_open_trade_payload(sdk, payload):
    collateral = _as_float(
        _required_value(
            payload,
            "collateral",
            aliases=["size", "positionSize", "position_size", "amount"],
        ),
        "collateral",
    )
    leverage = _as_float(
        _required_value(payload, "leverage", aliases=["lev", "leverage_x"]),
        "leverage",
    )
    if collateral <= 0:
        raise ValueError("collateral must be greater than 0.")
    if leverage <= 0:
        raise ValueError("leverage must be greater than 0.")

    pair_id = await _resolve_open_trade_pair_id(sdk, payload)
    direction = _normalize_direction(payload)
    order_type = _normalize_order_type(payload)
    collateral_symbol = _normalize_collateral_symbol(payload)

    tp = _optional_float(payload, "tp", aliases=["tpPrice", "tp_price", "takeProfit", "take_profit"])
    sl = _optional_float(payload, "sl", aliases=["slPrice", "sl_price", "stopLoss", "stop_loss"])

    normalized_trade_params = {
        "collateral": collateral,
        "leverage": leverage,
        "asset_type": pair_id,
        "direction": direction,
        "order_type": order_type,
    }

    if tp is not None:
        normalized_trade_params["tp"] = tp
    if sl is not None:
        normalized_trade_params["sl"] = sl

    trader_address = _optional_str(payload, "trader_address", aliases=["traderAddress"])
    if trader_address is not None:
        normalized_trade_params["trader_address"] = trader_address

    builder_address = _optional_str(payload, "builder_address", aliases=["builderAddress"])
    builder_fee = _optional_float(payload, "builder_fee", aliases=["builderFee"])
    if (builder_address is None) != (builder_fee is None):
        raise ValueError("builder_address and builder_fee must be provided together.")
    if builder_address is not None and builder_fee is not None:
        normalized_trade_params["builder_address"] = builder_address
        normalized_trade_params["builder_fee"] = builder_fee

    at_price = _optional_float(payload, "atPrice", aliases=["at_price", "price", "entryPrice", "entry_price"])
    at_price_source = "provided"
    market_price_meta = None
    if at_price is None:
        if order_type != MARKET_ORDER:
            raise ValueError(
                "Missing atPrice/at_price for non-market open_trade. Provide explicit trigger/entry price."
            )
        at_price, market_price_meta = await _resolve_market_price_for_pair_id(sdk, pair_id)
        at_price_source = "live_mid_price"
    if at_price <= 0:
        raise ValueError("atPrice/at_price must be greater than 0.")

    return normalized_trade_params, at_price, at_price_source, collateral_symbol, market_price_meta


async def handle_read_action(sdk, payload, action):
    if action == "get_pairs":
        include_prices = payload.get("includingCurrentPriceAndMarketStatus", True)
        pairs = await sdk.get_formatted_pairs_details(bool(include_prices))
        return {"count": len(pairs), "pairs": to_plain(pairs)}

    if action == "get_open_trades":
        trader_address = payload.get("traderAddress")
        open_trades, resolved_trader = await sdk.get_open_trades(trader_address)
        return {"traderAddress": resolved_trader, "openTrades": to_plain(open_trades)}

    if action == "get_open_trade_metrics":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        trade_index = require_int(payload, "tradeIndex", aliases=["trade_index", "index"])
        trader_address = payload.get("traderAddress")
        metrics = await sdk.get_open_trade_metrics(pair_id, trade_index, trader_address)
        return {"pairId": pair_id, "tradeIndex": trade_index, "metrics": to_plain(metrics)}

    if action == "get_target_funding_rate":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        target_rate = await sdk.get_target_funding_rate(pair_id)
        return {"pairId": pair_id, "targetFundingRate": to_plain(target_rate)}

    if action == "get_pair_max_leverage":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        max_leverage = await sdk.get_pair_max_leverage(pair_id)
        return {"pairId": pair_id, "maxLeverage": to_plain(max_leverage)}

    if action == "get_pair_overnight_max_leverage":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        max_leverage = await sdk.get_pair_overnight_max_leverage(pair_id)
        return {"pairId": pair_id, "overnightMaxLeverage": to_plain(max_leverage)}

    if action == "get_rollover_rate":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        period_hours = int(payload.get("periodHours", 24))
        rollover = await sdk.get_rollover_rate_for_pair_id(pair_id, period_hours=period_hours)
        return {"pairId": pair_id, "periodHours": period_hours, "rolloverRate": to_plain(rollover)}

    if action == "get_funding_rate":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        period_hours = int(payload.get("periodHours", 24))
        funding = await sdk.get_funding_rate_for_pair_id(pair_id, period_hours=period_hours)
        return {"pairId": pair_id, "periodHours": period_hours, "fundingRate": to_plain(funding)}

    raise ValueError(f"Unsupported read action: {action}")


async def handle_write_action(sdk, payload, action):
    if action == "open_trade":
        (
            trade_params,
            at_price,
            at_price_source,
            collateral_symbol,
            market_price_meta,
        ) = await _normalize_open_trade_payload(sdk, payload)
        try:
            result = sdk.ostium.perform_trade(trade_params, at_price)
        except Exception as error:
            raw_error = str(error)
            if "openTrade" in raw_error and "ABI" in raw_error:
                raise ValueError(
                    "open_trade payload failed ABI validation after normalization. "
                    f"tradeParams={json.dumps(to_plain(trade_params))}; atPrice={at_price}; "
                    f"error={raw_error}"
                ) from error
            raise

        response = {
            "collateralSymbol": collateral_symbol,
            "atPrice": at_price,
            "atPriceSource": at_price_source,
            "tradeParams": to_plain(trade_params),
            "tx": to_plain(result),
        }
        if market_price_meta is not None:
            response["market"] = market_price_meta
        return response

    if action == "close_trade":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        trade_index = require_int(payload, "tradeIndex", aliases=["trade_index", "index"])
        market_price = require_float(payload, "marketPrice", aliases=["market_price", "price"])
        close_percentage = float(payload.get("closePercentage", 100))
        trader_address = payload.get("traderAddress")
        result = sdk.ostium.close_trade(
            pair_id,
            trade_index,
            market_price,
            close_percentage=close_percentage,
            trader_address=trader_address,
        )
        return {"tx": to_plain(result)}

    if action == "cancel_limit_order":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        trade_index = require_int(payload, "tradeIndex", aliases=["trade_index", "index"])
        trader_address = payload.get("traderAddress")
        result = sdk.ostium.cancel_limit_order(pair_id, trade_index, trader_address)
        return {"tx": to_plain(result)}

    if action == "update_tp":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        trade_index = require_int(payload, "tradeIndex", aliases=["trade_index", "index"])
        tp_price = require_float(payload, "tpPrice", aliases=["tp_price", "tp"])
        trader_address = payload.get("traderAddress")
        result = sdk.ostium.update_tp(pair_id, trade_index, tp_price, trader_address)
        return {"tx": to_plain(result)}

    if action == "update_sl":
        pair_id = require_int(payload, "pairId", aliases=["pair_id", "pairIndex"])
        trade_index = require_int(payload, "tradeIndex", aliases=["trade_index", "index"])
        sl_price = require_float(payload, "slPrice", aliases=["sl_price", "sl"])
        trader_address = payload.get("traderAddress")
        result = sdk.ostium.update_sl(pair_id, trade_index, sl_price, trader_address)
        return {"tx": to_plain(result)}

    raise ValueError(f"Unsupported write action: {action}")


async def run(payload):
    action = payload.get("action")
    if not isinstance(action, str) or not action:
        raise ValueError("Missing action.")
    if action not in SUPPORTED_ACTIONS:
        raise ValueError(f"Unsupported action: {action}")

    network = payload.get("network", "mainnet")
    if network not in SUPPORTED_NETWORKS:
        raise ValueError(f"Invalid network: {network}. Use mainnet or testnet.")

    rpc_url_env_var = str(payload.get("rpcUrlEnvVar") or "RPC_URL")
    private_key_env_var = str(payload.get("privateKeyEnvVar") or "PRIVATE_KEY")

    rpc_url = str(payload.get("rpcUrl") or os.getenv(rpc_url_env_var) or "").strip()
    if not rpc_url:
        raise ValueError(
            f"Missing RPC URL. Set {rpc_url_env_var} or pass rpcUrl in tool arguments."
        )

    private_key = str(payload.get("privateKey") or os.getenv(private_key_env_var) or "").strip()
    if action in WRITE_ACTIONS and not private_key:
        raise ValueError(
            f"Missing private key for write action. Set {private_key_env_var} or pass privateKey."
        )

    verbose = bool(payload.get("verbose", False))
    use_delegation = bool(payload.get("useDelegation", False))
    sdk = OstiumSDK(
        network=network,
        private_key=private_key or None,
        rpc_url=rpc_url,
        verbose=verbose,
        use_delegation=use_delegation,
    )

    if action in READ_ACTIONS:
        result = await handle_read_action(sdk, payload, action)
    else:
        result = await handle_write_action(sdk, payload, action)

    return {"ok": True, "action": action, "network": network, "result": to_plain(result)}


def main():
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"ok": False, "error": "Missing JSON payload on stdin."}))
        return 1

    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("Input payload must be a JSON object.")
        result = asyncio.run(run(payload))
        print(json.dumps(result))
        return 0
    except Exception as error:
        response = {"ok": False, "error": str(error)}
        if os.getenv("OSTIUM_DEBUG") == "1":
            response["trace"] = traceback.format_exc()
        print(json.dumps(response))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
