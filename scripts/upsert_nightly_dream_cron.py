#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
import uuid
from pathlib import Path


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Upsert the Nightly Dream Memory cron job into jobs.json.")
    parser.add_argument(
        "--jobs-file",
        default=str(Path(os.environ.get("OPENCLAW_JOBS_FILE", Path.home() / ".openclaw" / "cron" / "jobs.json"))),
    )
    parser.add_argument("--name", default="Nightly Dream Memory")
    parser.add_argument("--description", default="Claude-style nightly memory consolidation and reviewed promotion.")
    parser.add_argument("--cron", default="30 2 * * *")
    parser.add_argument("--tz", default="Asia/Shanghai")
    parser.add_argument("--thinking", default="low")
    parser.add_argument("--model")
    parser.add_argument("--message", required=True)
    parser.add_argument("--disabled", action="store_true")
    args = parser.parse_args()

    jobs_file = Path(args.jobs_file)
    payload = load_json(jobs_file)
    jobs = payload.get("jobs", [])
    now_ms = int(time.time() * 1000)

    existing = next((job for job in jobs if job.get("name") == args.name), None)
    if existing is None:
        existing = {
            "id": str(uuid.uuid4()),
            "createdAtMs": now_ms,
        }
        jobs.append(existing)

    existing.update(
        {
            "name": args.name,
            "description": args.description,
            "enabled": not args.disabled,
            "updatedAtMs": now_ms,
            "schedule": {
                "kind": "cron",
                "expr": args.cron,
                "tz": args.tz,
            },
            "sessionTarget": "isolated",
            "wakeMode": "now",
            "payload": {
                "kind": "agentTurn",
                "message": args.message,
                **({"model": args.model} if args.model else {}),
                "thinking": args.thinking,
            },
            "state": existing.get("state") or {},
        }
    )
    existing.pop("delivery", None)

    if args.disabled:
        existing["state"].pop("nextRunAtMs", None)
        existing["state"].pop("runningAtMs", None)

    payload["jobs"] = jobs
    jobs_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "id": existing["id"], "enabled": existing["enabled"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
