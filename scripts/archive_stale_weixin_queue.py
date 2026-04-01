#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import datetime
from pathlib import Path


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Archive stale Weixin delivery queue items without replaying them.")
    parser.add_argument(
        "--queue-dir",
        default=str(Path(os.environ.get("OPENCLAW_HOME", Path.home() / ".openclaw")) / "delivery-queue"),
    )
    parser.add_argument("--stale-account-id", required=True)
    parser.add_argument("--channel", default="openclaw-weixin")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    queue_dir = Path(args.queue_dir)
    archive_dir = queue_dir / "archived-stale"
    archived_at = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = archive_dir / archived_at

    matches: list[dict] = []
    for path in sorted(queue_dir.glob("*.json")):
        payload = load_json(path)
        if payload.get("channel") != args.channel:
            continue
        if payload.get("accountId") != args.stale_account_id:
            continue
        matches.append(
            {
                "path": path,
                "id": payload.get("id"),
                "to": payload.get("to"),
                "accountId": payload.get("accountId"),
                "lastError": payload.get("lastError"),
                "payload_preview": (payload.get("payloads") or [{}])[0].get("text", "")[:120],
            }
        )

    result = {
        "queue_dir": str(queue_dir),
        "stale_account_id": args.stale_account_id,
        "matches": [
            {
                "path": str(item["path"]),
                "id": item["id"],
                "to": item["to"],
                "accountId": item["accountId"],
                "lastError": item["lastError"],
                "payload_preview": item["payload_preview"],
            }
            for item in matches
        ],
        "apply": args.apply,
    }

    if args.apply and matches:
        run_dir.mkdir(parents=True, exist_ok=True)
        for item in matches:
            destination = run_dir / item["path"].name
            shutil.move(str(item["path"]), str(destination))
        result["archived_to"] = str(run_dir)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
