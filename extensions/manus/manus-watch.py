#!/usr/bin/env python3
"""
manus-watch.py - Poll a Manus task and wake OpenClaw when complete.

Usage:
  manus-watch.py <task_id> [--interval=60] [--timeout=3600]

When the task completes, sends a cron wake event with the result summary.
"""

import argparse
import json
import os
import requests
import sys
import time
from pathlib import Path

MANUS_API = "https://api.manus.ai/v1/tasks"


def get_api_key():
    key = os.environ.get("MANUS_API_KEY")
    if not key:
        # Try reading from openclaw config
        config_path = Path.home() / ".openclaw" / "openclaw.json"
        if config_path.exists():
            with open(config_path) as f:
                config = json.load(f)
                key = config.get("env", {}).get("MANUS_API_KEY")
    return key


def poll_task(task_id: str, api_key: str) -> dict:
    """Poll Manus API for task status."""
    r = requests.get(
        f"{MANUS_API}/{task_id}",
        headers={"API_KEY": api_key},
        timeout=30
    )
    r.raise_for_status()
    return r.json()


def send_wake_event(text: str):
    """Send a cron wake event to OpenClaw via gateway API."""
    import subprocess
    
    # Read gateway config to get URL/token
    config_path = Path.home() / ".openclaw" / "openclaw.json"
    gateway_url = "http://localhost:5004"  # default
    gateway_token = None
    
    if config_path.exists():
        with open(config_path) as f:
            config = json.load(f)
            gateway_url = config.get("gatewayUrl", gateway_url)
            gateway_token = config.get("gatewayToken")
    
    headers = {"Content-Type": "application/json"}
    if gateway_token:
        headers["Authorization"] = f"Bearer {gateway_token}"
    
    try:
        r = requests.post(
            f"{gateway_url}/api/cron/wake",
            headers=headers,
            json={"text": text, "mode": "now"},
            timeout=10
        )
        return r.status_code == 200
    except Exception as e:
        print(f"Wake event failed: {e}")
        return False


def extract_files(data: dict) -> list:
    """Extract output file info from task result."""
    files = []
    for item in data.get("output", []):
        if item.get("type") == "message":
            for content in item.get("content", []):
                if content.get("type") == "output_file":
                    files.append({
                        "name": content.get("fileName"),
                        "url": content.get("fileUrl", "")[:100] + "..."
                    })
    return files


def main():
    parser = argparse.ArgumentParser(description="Watch Manus task and wake on completion")
    parser.add_argument("task_id", help="Manus task ID to watch")
    parser.add_argument("--interval", type=int, default=60, help="Poll interval in seconds")
    parser.add_argument("--timeout", type=int, default=3600, help="Max wait time in seconds")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output")
    args = parser.parse_args()

    api_key = get_api_key()
    if not api_key:
        print("ERROR: MANUS_API_KEY not found", file=sys.stderr)
        sys.exit(1)

    start_time = time.time()
    last_credits = 0

    while True:
        elapsed = time.time() - start_time
        if elapsed > args.timeout:
            msg = f"⏰ Manus task {args.task_id} timed out after {args.timeout}s"
            send_wake_event(msg)
            print(msg)
            sys.exit(1)

        try:
            data = poll_task(args.task_id, api_key)
        except Exception as e:
            if not args.quiet:
                print(f"Poll error: {e}", file=sys.stderr)
            time.sleep(args.interval)
            continue

        status = data.get("status", "unknown")
        credits = data.get("credit_usage", 0)
        title = data.get("metadata", {}).get("task_title", args.task_id)

        if not args.quiet and credits != last_credits:
            print(f"[{time.strftime('%H:%M:%S')}] {title}: {status} ({credits} credits)")
            last_credits = credits

        if status == "completed":
            files = extract_files(data)
            file_list = ", ".join(f["name"] for f in files) if files else "no files"
            msg = f"✅ Manus complete: {title} | {credits} credits | Files: {file_list}"
            send_wake_event(msg)
            print(msg)
            
            # Also save full result
            result_path = Path.home() / ".openclaw" / "workspace" / "memory" / "manus-results" / f"{args.task_id}.json"
            result_path.parent.mkdir(parents=True, exist_ok=True)
            with open(result_path, "w") as f:
                json.dump(data, f, indent=2)
            print(f"Result saved: {result_path}")
            
            sys.exit(0)

        elif status == "error":
            msg = f"❌ Manus failed: {title} | {credits} credits"
            send_wake_event(msg)
            print(msg)
            sys.exit(1)

        time.sleep(args.interval)


if __name__ == "__main__":
    main()
