#!/usr/bin/env python3
"""
Summarize model usage cost (CodexBar) and basic OpenClaw observability signals.

Modes:
- current: current model cost summary (CodexBar)
- all: all model cost summary (CodexBar)
- errors: recent failed/aborted sessions (+ optional gateway log snippets)
- overview: combine cost + errors in one report
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple


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


def load_cost_payload(input_path: Optional[str], provider: str) -> Dict[str, Any]:
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


def run_openclaw_sessions(limit: int) -> List[Dict[str, Any]]:
    cmd = ["openclaw", "sessions", "list", "--json", "--limit", str(limit)]
    try:
        output = subprocess.check_output(cmd, text=True)
    except FileNotFoundError:
        raise RuntimeError("openclaw not found on PATH.")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"openclaw sessions list failed (exit {exc.returncode}).")

    try:
        data = json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse openclaw sessions JSON: {exc}")

    if isinstance(data, dict) and isinstance(data.get("sessions"), list):
        return [s for s in data["sessions"] if isinstance(s, dict)]
    if isinstance(data, list):
        return [s for s in data if isinstance(s, dict)]
    return []


@dataclass
class ModelCost:
    model: str
    cost: float


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


def aggregate_costs(entries: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    totals: Dict[str, float] = {}
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
            cost = item.get("cost")
            if not isinstance(model, str):
                continue
            if not isinstance(cost, (int, float)):
                continue
            totals[model] = totals.get(model, 0.0) + float(cost)
    return totals


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


def pick_session_status(session: Dict[str, Any]) -> str:
    for key in ("lastStatus", "status", "runStatus"):
        value = session.get(key)
        if isinstance(value, str) and value:
            return value
    return "unknown"


def session_is_problematic(session: Dict[str, Any]) -> bool:
    aborted = bool(session.get("abortedLastRun"))
    raw_status = None
    for key in ("lastStatus", "status", "runStatus"):
        value = session.get(key)
        if isinstance(value, str) and value:
            raw_status = value.lower()
            break

    # If status is missing entirely, do not mark as problematic by status.
    if raw_status is None:
        return aborted

    not_ok = raw_status not in {"ok", "success", "succeeded", "completed"}
    return aborted or not_ok


def summarize_recent_errors(limit: int) -> Dict[str, Any]:
    sessions = run_openclaw_sessions(limit)
    bad = [s for s in sessions if session_is_problematic(s)]

    def sort_key(s: Dict[str, Any]) -> str:
        for k in ("updatedAt", "lastMessageAt", "createdAt"):
            v = s.get(k)
            if isinstance(v, str):
                return v
        return ""

    bad.sort(key=sort_key, reverse=True)

    rows: List[Dict[str, Any]] = []
    for s in bad[:limit]:
        rows.append(
            {
                "id": s.get("id") or s.get("sessionKey") or s.get("key") or s.get("sessionId") or "unknown",
                "title": s.get("title") or "Untitled",
                "status": pick_session_status(s),
                "aborted": bool(s.get("abortedLastRun")),
                "updatedAt": s.get("updatedAt"),
                "model": s.get("model"),
            }
        )

    return {
        "checked": len(sessions),
        "problematic": len(rows),
        "sessions": rows,
    }


def collect_gateway_log_hints(max_lines: int = 200) -> Dict[str, Any]:
    patterns = ("error", "exception", "fail", "warn")

    # Prefer journalctl on Linux/systemd.
    if shutil.which("journalctl"):
        try:
            cmd = [
                "journalctl",
                "--user",
                "-u",
                "openclaw-gateway",
                "-n",
                str(max_lines),
                "--no-pager",
            ]
            output = subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)
            lines = [ln.strip() for ln in output.splitlines() if ln.strip()]
            hit = [ln for ln in lines if any(p in ln.lower() for p in patterns)]
            uniq = []
            seen = set()
            for ln in hit:
                if ln not in seen:
                    uniq.append(ln)
                    seen.add(ln)
            return {
                "available": True,
                "source": "journalctl",
                "lines": uniq[-10:],
            }
        except Exception as exc:
            return {
                "available": False,
                "source": "journalctl",
                "reason": f"journalctl read failed: {exc}",
                "lines": [],
            }

    # macOS fallback: check common gateway log path if present.
    log_path = os.path.expanduser("~/.openclaw/logs/gateway.log")
    if os.path.exists(log_path):
        try:
            with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()[-max_lines:]
            hit = [ln.strip() for ln in lines if ln.strip() and any(p in ln.lower() for p in patterns)]
            return {
                "available": True,
                "source": log_path,
                "lines": hit[-10:],
            }
        except Exception as exc:
            return {
                "available": False,
                "source": log_path,
                "reason": f"log read failed: {exc}",
                "lines": [],
            }

    return {
        "available": False,
        "reason": "No journalctl and no ~/.openclaw/logs/gateway.log",
        "lines": [],
    }


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


def render_text_all(provider: str, totals: Dict[str, float]) -> str:
    lines = [f"Provider: {provider}", "Models:"]
    for model, cost in sorted(totals.items(), key=lambda item: item[1], reverse=True):
        lines.append(f"- {model}: {usd(cost)}")
    return "\n".join(lines)


def render_text_errors(errors: Dict[str, Any], logs: Dict[str, Any]) -> str:
    lines = [
        "## Recent Errors Overview",
        f"Sessions checked: {errors.get('checked', 0)}",
        f"Problematic sessions: {errors.get('problematic', 0)}",
        "",
        "### Problematic Sessions",
    ]
    sessions = errors.get("sessions") or []
    if not sessions:
        lines.append("- No failed/aborted sessions found.")
    else:
        for s in sessions:
            lines.append(
                f"- {s.get('id')}: {s.get('title')} | status={s.get('status')} | "
                f"aborted={s.get('aborted')} | model={s.get('model') or '-'} | updatedAt={s.get('updatedAt') or '-'}"
            )

    lines += ["", "### Gateway Log Hints"]
    if logs.get("available"):
        source = logs.get("source") or "gateway logs"
        lines.append(f"Source: {source}")
        if logs.get("lines"):
            for ln in logs["lines"]:
                lines.append(f"- {ln}")
        else:
            lines.append("- No recent warning/error lines found.")
    else:
        lines.append(f"- Not available: {logs.get('reason', 'unknown reason')}")

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


def build_json_all(provider: str, totals: Dict[str, float]) -> Dict[str, Any]:
    return {
        "provider": provider,
        "mode": "all",
        "models": [
            {"model": model, "totalCostUSD": cost}
            for model, cost in sorted(totals.items(), key=lambda item: item[1], reverse=True)
        ],
    }


def print_json(payload_out: Dict[str, Any], pretty: bool) -> None:
    indent = 2 if pretty else None
    print(json.dumps(payload_out, indent=indent, sort_keys=pretty))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Summarize CodexBar model usage and basic OpenClaw observability."
    )
    parser.add_argument("--provider", choices=["codex", "claude"], default="codex")
    parser.add_argument("--mode", choices=["current", "all", "errors", "overview"], default="current")
    parser.add_argument("--model", help="Explicit model name to report instead of auto-current.")
    parser.add_argument("--input", help="Path to codexbar cost JSON (or '-' for stdin).")
    parser.add_argument("--days", type=int, help="Limit cost summary to last N days (daily rows).")
    parser.add_argument("--error-limit", type=int, default=50, help="How many sessions to inspect for errors.")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")

    args = parser.parse_args()

    # Errors-only mode does not require codexbar.
    if args.mode == "errors":
        try:
            errors = summarize_recent_errors(args.error_limit)
            logs = collect_gateway_log_hints()
        except Exception as exc:
            eprint(str(exc))
            return 1

        if args.format == "json":
            print_json({"mode": "errors", "errors": errors, "gatewayLogs": logs}, args.pretty)
        else:
            print(render_text_errors(errors, logs))
        return 0

    # Modes using CodexBar cost payload.
    try:
        payload = load_cost_payload(args.input, args.provider)
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
            print_json(payload_out, args.pretty)
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

    if args.mode == "all":
        totals = aggregate_costs(entries)
        if not totals:
            eprint("No model breakdowns found in codexbar cost payload.")
            return 2

        if args.format == "json":
            payload_out = build_json_all(provider=args.provider, totals=totals)
            print_json(payload_out, args.pretty)
        else:
            print(render_text_all(provider=args.provider, totals=totals))
        return 0

    # overview: combine cost + recent errors
    totals = aggregate_costs(entries)
    top_models = [
        {"model": model, "totalCostUSD": cost}
        for model, cost in sorted(totals.items(), key=lambda item: item[1], reverse=True)
    ]

    try:
        errors = summarize_recent_errors(args.error_limit)
        logs = collect_gateway_log_hints()
    except Exception as exc:
        eprint(f"Failed to load observability data: {exc}")
        return 1

    if args.format == "json":
        payload_out = {
            "mode": "overview",
            "provider": args.provider,
            "days": args.days,
            "cost": {
                "modelCount": len(top_models),
                "models": top_models,
            },
            "errors": errors,
            "gatewayLogs": logs,
        }
        print_json(payload_out, args.pretty)
        return 0

    lines = [
        f"Provider: {args.provider}",
        f"Cost models: {len(top_models)}",
        "Top cost models:",
    ]
    for m in top_models[:10]:
        lines.append(f"- {m['model']}: {usd(m['totalCostUSD'])}")
    lines += ["", render_text_errors(errors, logs)]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
