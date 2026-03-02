#!/usr/bin/env python3
"""Thin bridge to SofaGenius launch endpoints.

All job launching logic lives in SofaGenius. This script forwards
requests to the SofaGenius FastAPI backend on localhost:8000.

Usage:
    python3 bridge.py launch-propose --dataset "user/data" --model "unsloth/llama-3-8b"
    python3 bridge.py launch-modify --config-id "abc" --changes '{"epochs": 20}'
    python3 bridge.py launch-run --config-id "abc" --mode "experiment"
    python3 bridge.py launch-status --job-id "xyz"
    python3 bridge.py launch-check-completed
"""

import argparse
import json
import sys
import urllib.request
import urllib.error

SOFAGENIUS_URL = "http://127.0.0.1:8000"


def api_call(endpoint: str, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SOFAGENIUS_URL}{endpoint}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        print(f"Error connecting to SofaGenius at {SOFAGENIUS_URL}: {e}", file=sys.stderr)
        print("Make sure the SofaGenius backend is running (uvicorn on port 8000).", file=sys.stderr)
        sys.exit(1)


def launch_propose(dataset: str, model: str) -> None:
    result = api_call("/api/launch/propose", {"dataset": dataset, "model": model})
    print(json.dumps(result, indent=2))


def launch_modify(config_id: str, changes: str) -> None:
    changes_dict = json.loads(changes)
    result = api_call("/api/launch/modify", {"config_id": config_id, "changes": changes_dict})
    print(json.dumps(result, indent=2))


def launch_run(config_id: str, mode: str) -> None:
    result = api_call("/api/launch/run", {"config_id": config_id, "mode": mode})
    print(json.dumps(result, indent=2))


def launch_status(job_id: str) -> None:
    result = api_call("/api/launch/status", {"job_id": job_id})
    print(json.dumps(result, indent=2))


def launch_check_completed() -> None:
    """Check recently completed jobs and suggest next steps. Used by proactive cron."""
    result = api_call("/api/launch/check-completed", {})
    if result.get("completed_jobs"):
        for job in result["completed_jobs"]:
            print(f"Job {job.get('job_id')} completed!")
            print(f"  Final loss: {job.get('final_loss')}")
            print(f"  Suggestions: {', '.join(job.get('suggestions', []))}")
    else:
        print("No recently completed jobs.")
    print(json.dumps(result, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="SofaGenius Launch Bridge")
    parser.add_argument("action", choices=[
        "launch-propose", "launch-modify", "launch-run", "launch-status", "launch-check-completed"
    ])
    parser.add_argument("--dataset", help="HuggingFace dataset ID")
    parser.add_argument("--model", help="Base model name")
    parser.add_argument("--config-id", help="Config ID from propose step")
    parser.add_argument("--changes", help="JSON string of config changes")
    parser.add_argument("--mode", choices=["overfit", "experiment", "production"], help="Run mode")
    parser.add_argument("--job-id", help="Modal job ID")
    args = parser.parse_args()

    if args.action == "launch-propose":
        if not args.dataset or not args.model:
            parser.error("--dataset and --model required for launch-propose")
        launch_propose(args.dataset, args.model)
    elif args.action == "launch-modify":
        if not args.config_id or not args.changes:
            parser.error("--config-id and --changes required for launch-modify")
        launch_modify(args.config_id, args.changes)
    elif args.action == "launch-run":
        if not args.config_id or not args.mode:
            parser.error("--config-id and --mode required for launch-run")
        launch_run(args.config_id, args.mode)
    elif args.action == "launch-status":
        if not args.job_id:
            parser.error("--job-id required for launch-status")
        launch_status(args.job_id)
    elif args.action == "launch-check-completed":
        launch_check_completed()


if __name__ == "__main__":
    main()
