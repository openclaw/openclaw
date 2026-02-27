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


def require_int(payload, key):
    if key not in payload:
        raise ValueError(f"Missing required field: {key}")
    return int(payload[key])


def require_float(payload, key):
    if key not in payload:
        raise ValueError(f"Missing required field: {key}")
    return float(payload[key])


def require_trade_params(payload):
    trade_params = payload.get("tradeParams")
    if not isinstance(trade_params, dict):
        raise ValueError("tradeParams must be an object.")
    return trade_params


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
        pair_id = require_int(payload, "pairId")
        trade_index = require_int(payload, "tradeIndex")
        trader_address = payload.get("traderAddress")
        metrics = await sdk.get_open_trade_metrics(pair_id, trade_index, trader_address)
        return {"pairId": pair_id, "tradeIndex": trade_index, "metrics": to_plain(metrics)}

    if action == "get_target_funding_rate":
        pair_id = require_int(payload, "pairId")
        target_rate = await sdk.get_target_funding_rate(pair_id)
        return {"pairId": pair_id, "targetFundingRate": to_plain(target_rate)}

    if action == "get_pair_max_leverage":
        pair_id = require_int(payload, "pairId")
        max_leverage = await sdk.get_pair_max_leverage(pair_id)
        return {"pairId": pair_id, "maxLeverage": to_plain(max_leverage)}

    if action == "get_pair_overnight_max_leverage":
        pair_id = require_int(payload, "pairId")
        max_leverage = await sdk.get_pair_overnight_max_leverage(pair_id)
        return {"pairId": pair_id, "overnightMaxLeverage": to_plain(max_leverage)}

    if action == "get_rollover_rate":
        pair_id = require_int(payload, "pairId")
        period_hours = int(payload.get("periodHours", 24))
        rollover = await sdk.get_rollover_rate_for_pair_id(pair_id, period_hours=period_hours)
        return {"pairId": pair_id, "periodHours": period_hours, "rolloverRate": to_plain(rollover)}

    if action == "get_funding_rate":
        pair_id = require_int(payload, "pairId")
        period_hours = int(payload.get("periodHours", 24))
        funding = await sdk.get_funding_rate_for_pair_id(pair_id, period_hours=period_hours)
        return {"pairId": pair_id, "periodHours": period_hours, "fundingRate": to_plain(funding)}

    raise ValueError(f"Unsupported read action: {action}")


def handle_write_action(sdk, payload, action):
    if action == "open_trade":
        trade_params = require_trade_params(payload)
        at_price = require_float(payload, "atPrice")
        result = sdk.ostium.perform_trade(trade_params, at_price)
        return {"tx": to_plain(result)}

    if action == "close_trade":
        pair_id = require_int(payload, "pairId")
        trade_index = require_int(payload, "tradeIndex")
        market_price = require_float(payload, "marketPrice")
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
        pair_id = require_int(payload, "pairId")
        trade_index = require_int(payload, "tradeIndex")
        trader_address = payload.get("traderAddress")
        result = sdk.ostium.cancel_limit_order(pair_id, trade_index, trader_address)
        return {"tx": to_plain(result)}

    if action == "update_tp":
        pair_id = require_int(payload, "pairId")
        trade_index = require_int(payload, "tradeIndex")
        tp_price = require_float(payload, "tpPrice")
        trader_address = payload.get("traderAddress")
        result = sdk.ostium.update_tp(pair_id, trade_index, tp_price, trader_address)
        return {"tx": to_plain(result)}

    if action == "update_sl":
        pair_id = require_int(payload, "pairId")
        trade_index = require_int(payload, "tradeIndex")
        sl_price = require_float(payload, "slPrice")
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
        result = handle_write_action(sdk, payload, action)

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
