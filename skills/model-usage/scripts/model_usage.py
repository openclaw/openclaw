#!/usr/bin/env python3
"""
Summarize CodexBar local cost usage by model.

Defaults to current model (most recent daily entry), or list all models.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return parsed


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def run_codexbar_cost(provider: str) -> List[Dict[str, Any]]:
    cmd = ["codexbar", "cost", "--format", "json", "--provider", provider]
    try:
        output = subprocess.check_output(cmd, text=True)
    except FileNotFoundError:
        raise RuntimeError("codexbar not found on PATH. Install CodexBar CLI first.")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"codexbar cost failed (exit {exc.returncode}).")
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse codexbar JSON output: {exc}")
    if not isinstance(payload, list):
        raise RuntimeError("Expected codexbar cost JSON array.")
    return payload


def load_payload(input_path: Optional[str], provider: str) -> Dict[str, Any]:
    if input_path:
        if input_path == "-":
            raw = sys.stdin.read()
        else:
            with open(input_path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        data = json.loads(raw)
    else:
        data = run_codexbar_cost(provider)

    if isinstance(data, dict):
        return data

    if isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict) and entry.get("provider") == provider:
                return entry
        raise RuntimeError(f"Provider '{provider}' not found in codexbar payload.")

    raise RuntimeError("Unsupported JSON input format.")


@dataclass
class ModelCost:
    model: str
    cost: float


@dataclass
class ModelUsage:
    model: str
    cost: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    total_tokens: int = 0
    tokens_available: bool = False


def parse_daily_entries(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    daily = payload.get("daily")
    if not daily:
        return []
    if not isinstance(daily, list):
        return []
    return [entry for entry in daily if isinstance(entry, dict)]


def parse_date(value: str) -> Optional[date]:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except Exception:
        return None


def filter_by_days(entries: List[Dict[str, Any]], days: Optional[int]) -> List[Dict[str, Any]]:
    if not days:
        return entries
    cutoff = date.today() - timedelta(days=days - 1)
    filtered: List[Dict[str, Any]] = []
    for entry in entries:
        day = entry.get("date")
        if not isinstance(day, str):
            continue
        parsed = parse_date(day)
        if parsed and parsed >= cutoff:
            filtered.append(entry)
    return filtered


def numeric_int_field(item: Dict[str, Any], *names: str) -> Optional[int]:
    for name in names:
        value = item.get(name)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return int(value)
    return None


def aggregate_model_usages(entries: Iterable[Dict[str, Any]]) -> Dict[str, ModelUsage]:
    totals: Dict[str, ModelUsage] = {}
    for entry in entries:
        breakdowns = entry.get("modelBreakdowns")
        if not breakdowns:
            continue
        if not isinstance(breakdowns, list):
            continue
        for item in breakdowns:
            if not isinstance(item, dict):
                continue
            model = item.get("modelName")
            if not isinstance(model, str):
                continue

            usage = totals.setdefault(model, ModelUsage(model=model))
            cost = item.get("cost")
            if isinstance(cost, (int, float)) and not isinstance(cost, bool):
                usage.cost += float(cost)

            input_tokens = numeric_int_field(item, "inputTokens", "totalInputTokens", "prompt_tokens", "input_tokens")
            output_tokens = numeric_int_field(item, "outputTokens", "totalOutputTokens", "completion_tokens", "output_tokens")
            cache_read_tokens = numeric_int_field(item, "cacheReadTokens", "cache_read_tokens")
            cache_creation_tokens = numeric_int_field(
                item,
                "cacheCreationTokens",
                "cache_creation_tokens",
                "cacheWriteTokens",
                "cache_write_tokens",
            )
            explicit_total_tokens = numeric_int_field(item, "totalTokens", "total_tokens")

            token_parts = [input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens]
            has_token_data = explicit_total_tokens is not None or any(value is not None for value in token_parts)
            if not has_token_data:
                continue

            usage.tokens_available = True
            usage.input_tokens += input_tokens or 0
            usage.output_tokens += output_tokens or 0
            usage.cache_read_tokens += cache_read_tokens or 0
            usage.cache_creation_tokens += cache_creation_tokens or 0
            if explicit_total_tokens is not None:
                usage.total_tokens += explicit_total_tokens
            else:
                usage.total_tokens += sum(value or 0 for value in token_parts)
    return totals


def aggregate_costs(entries: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    return {model: usage.cost for model, usage in aggregate_model_usages(entries).items()}


def pick_current_model(entries: List[Dict[str, Any]]) -> Tuple[Optional[str], Optional[str]]:
    if not entries:
        return None, None
    sorted_entries = sorted(
        entries,
        key=lambda entry: entry.get("date") or "",
    )
    for entry in reversed(sorted_entries):
        breakdowns = entry.get("modelBreakdowns")
        if isinstance(breakdowns, list) and breakdowns:
            scored: List[ModelCost] = []
            for item in breakdowns:
                if not isinstance(item, dict):
                    continue
                model = item.get("modelName")
                cost = item.get("cost")
                if isinstance(model, str) and isinstance(cost, (int, float)):
                    scored.append(ModelCost(model=model, cost=float(cost)))
            if scored:
                scored.sort(key=lambda item: item.cost, reverse=True)
                return scored[0].model, entry.get("date") if isinstance(entry.get("date"), str) else None
        models_used = entry.get("modelsUsed")
        if isinstance(models_used, list) and models_used:
            last = models_used[-1]
            if isinstance(last, str):
                return last, entry.get("date") if isinstance(entry.get("date"), str) else None
    return None, None


def usd(value: Optional[float]) -> str:
    if value is None:
        return "—"
    return f"${value:,.2f}"


def latest_day_cost(entries: List[Dict[str, Any]], model: str) -> Tuple[Optional[str], Optional[float]]:
    if not entries:
        return None, None
    sorted_entries = sorted(
        entries,
        key=lambda entry: entry.get("date") or "",
    )
    for entry in reversed(sorted_entries):
        breakdowns = entry.get("modelBreakdowns")
        if not isinstance(breakdowns, list):
            continue
        for item in breakdowns:
            if not isinstance(item, dict):
                continue
            if item.get("modelName") == model:
                cost = item.get("cost") if isinstance(item.get("cost"), (int, float)) else None
                day = entry.get("date") if isinstance(entry.get("date"), str) else None
                return day, float(cost) if cost is not None else None
    return None, None


def render_text_current(
    provider: str,
    model: str,
    latest_date: Optional[str],
    total_cost: Optional[float],
    latest_cost: Optional[float],
    latest_cost_date: Optional[str],
    entry_count: int,
) -> str:
    lines = [f"Provider: {provider}", f"Current model: {model}"]
    if latest_date:
        lines.append(f"Latest model date: {latest_date}")
    lines.append(f"Total cost (rows): {usd(total_cost)}")
    if latest_cost_date:
        lines.append(f"Latest day cost: {usd(latest_cost)} ({latest_cost_date})")
    lines.append(f"Daily rows: {entry_count}")
    return "\n".join(lines)


def format_int(value: int) -> str:
    return f"{value:,}"


def render_tokens(usage: ModelUsage) -> str:
    if not usage.tokens_available:
        return "tokens unavailable"
    parts = [f"tokens {format_int(usage.total_tokens)}"]
    details = []
    if usage.input_tokens:
        details.append(f"in {format_int(usage.input_tokens)}")
    if usage.output_tokens:
        details.append(f"out {format_int(usage.output_tokens)}")
    if usage.cache_read_tokens:
        details.append(f"cache read {format_int(usage.cache_read_tokens)}")
    if usage.cache_creation_tokens:
        details.append(f"cache create {format_int(usage.cache_creation_tokens)}")
    if details:
        parts.append(f"({', '.join(details)})")
    return " ".join(parts)


def render_text_all(provider: str, totals: Dict[str, ModelUsage]) -> str:
    lines = [f"Provider: {provider}", "Models:"]
    for model, usage in sorted(totals.items(), key=lambda item: item[1].cost, reverse=True):
        lines.append(f"- {model}: {usd(usage.cost)}, {render_tokens(usage)}")
    return "\n".join(lines)


def build_json_current(
    provider: str,
    model: str,
    latest_date: Optional[str],
    total_cost: Optional[float],
    latest_cost: Optional[float],
    latest_cost_date: Optional[str],
    entry_count: int,
) -> Dict[str, Any]:
    return {
        "provider": provider,
        "mode": "current",
        "model": model,
        "latestModelDate": latest_date,
        "totalCostUSD": total_cost,
        "latestDayCostUSD": latest_cost,
        "latestDayCostDate": latest_cost_date,
        "dailyRowCount": entry_count,
    }


def build_json_all(provider: str, totals: Dict[str, ModelUsage]) -> Dict[str, Any]:
    return {
        "provider": provider,
        "mode": "all",
        "models": [
            {
                "model": model,
                "totalCostUSD": usage.cost,
                "tokensAvailable": usage.tokens_available,
                "totalTokens": usage.total_tokens if usage.tokens_available else None,
                "inputTokens": usage.input_tokens if usage.tokens_available else None,
                "outputTokens": usage.output_tokens if usage.tokens_available else None,
                "cacheReadTokens": usage.cache_read_tokens if usage.tokens_available else None,
                "cacheCreationTokens": usage.cache_creation_tokens if usage.tokens_available else None,
            }
            for model, usage in sorted(totals.items(), key=lambda item: item[1].cost, reverse=True)
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize CodexBar model usage from local cost logs.")
    parser.add_argument("--provider", choices=["codex", "claude"], default="codex")
    parser.add_argument("--mode", choices=["current", "all"], default="current")
    parser.add_argument("--model", help="Explicit model name to report instead of auto-current.")
    parser.add_argument("--input", help="Path to codexbar cost JSON (or '-' for stdin).")
    parser.add_argument("--days", type=positive_int, help="Limit to last N days (based on daily rows).")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")

    args = parser.parse_args()

    try:
        payload = load_payload(args.input, args.provider)
    except Exception as exc:
        eprint(str(exc))
        return 1

    entries = parse_daily_entries(payload)
    entries = filter_by_days(entries, args.days)

    if args.mode == "current":
        model = args.model
        latest_date = None
        if not model:
            model, latest_date = pick_current_model(entries)
        if not model:
            eprint("No model data found in codexbar cost payload.")
            return 2
        totals = aggregate_costs(entries)
        total_cost = totals.get(model)
        latest_cost_date, latest_cost = latest_day_cost(entries, model)

        if args.format == "json":
            payload_out = build_json_current(
                provider=args.provider,
                model=model,
                latest_date=latest_date,
                total_cost=total_cost,
                latest_cost=latest_cost,
                latest_cost_date=latest_cost_date,
                entry_count=len(entries),
            )
            indent = 2 if args.pretty else None
            print(json.dumps(payload_out, indent=indent, sort_keys=args.pretty))
        else:
            print(
                render_text_current(
                    provider=args.provider,
                    model=model,
                    latest_date=latest_date,
                    total_cost=total_cost,
                    latest_cost=latest_cost,
                    latest_cost_date=latest_cost_date,
                    entry_count=len(entries),
                )
            )
        return 0

    totals = aggregate_model_usages(entries)
    if not totals:
        eprint("No model breakdowns found in codexbar cost payload.")
        return 2

    if args.format == "json":
        payload_out = build_json_all(provider=args.provider, totals=totals)
        indent = 2 if args.pretty else None
        print(json.dumps(payload_out, indent=indent, sort_keys=args.pretty))
    else:
        print(render_text_all(provider=args.provider, totals=totals))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
