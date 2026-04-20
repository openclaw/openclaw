"""Audit logger — append-only JSONL."""
import asyncio, json
from datetime import datetime, timezone


class AuditLog:
    def __init__(self, cfg):
        self.enabled = cfg.get("audit", {}).get("enabled", False)
        self.path = cfg.get("audit", {}).get("file", "audit.log")

    async def log(self, user, action, path, status, detail=""):
        if not self.enabled:
            return
        entry = {"ts": datetime.now(timezone.utc).isoformat(),
                 "user": user, "action": action, "path": path, "status": status}
        if detail:
            entry["detail"] = detail
        line = json.dumps(entry) + "\n"
        await asyncio.to_thread(self._write, line)

    def _write(self, line):
        try:
            with open(self.path, "a") as f:
                f.write(line)
        except OSError:
            pass  # Don't crash proxy if audit write fails
