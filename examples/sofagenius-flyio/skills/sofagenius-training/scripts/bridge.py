#!/usr/bin/env python3
"""Thin bridge to SofaGenius training endpoints.

All ML logic lives in SofaGenius. This script just forwards requests
to the SofaGenius FastAPI backend running on localhost:8000.

Usage:
    python3 bridge.py training-status --run-id <run_id>
    python3 bridge.py training-anomalies --run-id <run_id>
    python3 bridge.py training-compare --run-ids <id1,id2,id3>
    python3 bridge.py training-check-active
"""

import argparse
import json
import sys
import urllib.request
import urllib.error

SOFAGENIUS_URL = "http://127.0.0.1:8000"


def api_call(endpoint: str, payload: dict) -> dict:
    """POST to SofaGenius API and return JSON response."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SOFAGENIUS_URL}{endpoint}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        print(f"Error connecting to SofaGenius at {SOFAGENIUS_URL}: {e}", file=sys.stderr)
        print("Make sure the SofaGenius backend is running (uvicorn on port 8000).", file=sys.stderr)
        sys.exit(1)


def training_status(run_id: str) -> None:
    result = api_call("/api/training/status", {"run_id": run_id})
    print(json.dumps(result, indent=2))


def training_anomalies(run_id: str) -> None:
    result = api_call("/api/training/anomalies", {"run_id": run_id})
    print(json.dumps(result, indent=2))


def training_compare(run_ids: str) -> None:
    ids = [r.strip() for r in run_ids.split(",")]
    result = api_call("/api/training/compare", {"run_ids": ids})
    print(json.dumps(result, indent=2))


def training_check_active() -> None:
    """Check all active runs for anomalies. Used by proactive cron."""
    result = api_call("/api/training/check-active", {})
    if result.get("anomalies"):
        print("ALERT: Anomalies detected in active training runs!")
        for anomaly in result["anomalies"]:
            print(f"  - Run {anomaly.get('run_id')}: {anomaly.get('type')} — {anomaly.get('message')}")
    else:
        print("All active training runs look healthy.")
    print(json.dumps(result, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="SofaGenius Training Bridge")
    parser.add_argument("action", choices=[
        "training-status", "training-anomalies", "training-compare", "training-check-active"
    ])
    parser.add_argument("--run-id", help="W&B run ID")
    parser.add_argument("--run-ids", help="Comma-separated W&B run IDs")
    args = parser.parse_args()

    if args.action == "training-status":
        if not args.run_id:
            parser.error("--run-id required for training-status")
        training_status(args.run_id)
    elif args.action == "training-anomalies":
        if not args.run_id:
            parser.error("--run-id required for training-anomalies")
        training_anomalies(args.run_id)
    elif args.action == "training-compare":
        if not args.run_ids:
            parser.error("--run-ids required for training-compare")
        training_compare(args.run_ids)
    elif args.action == "training-check-active":
        training_check_active()


if __name__ == "__main__":
    main()
