#!/usr/bin/env python3
"""Hormone evaluation — Sentinel task, every 15m.

Evaluates trigger conditions in .hormone and auto-adjusts.
Notifies Cruz via TG when notify=true triggers fire.
"""
import json
import subprocess
import sys
from pathlib import Path

SENTINEL_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = SENTINEL_ROOT.parent / "workspace"

sys.path.insert(0, str(SENTINEL_ROOT))
sys.path.insert(0, str(WORKSPACE / "lib"))

try:
    from lib.logging_util import setup_logger
    logger = setup_logger("hormone_eval")
except ImportError:
    import logging
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger("hormone_eval")


def run(config: dict, state: dict) -> dict:
    logger.info("=== hormone_eval: start ===")

    try:
        from hormone import evaluate_triggers, get_season, get_focus, TRIGGER_CHECKS
    except ImportError as e:
        logger.error(f"Cannot import hormone: {e}")
        return {"error": str(e)}

    season = get_season()
    focus = get_focus()
    logger.info(f"Season: {season} | Focus: {focus}")

    fired = evaluate_triggers()

    # Notify Cruz for triggers that require it
    if fired:
        notify_triggers = [t for t in fired if TRIGGER_CHECKS.get(t, {}).get("notify")]
        if notify_triggers:
            msg = f"[內分泌] triggers fired: {', '.join(notify_triggers)}\nSeason: {season} | Focus: {focus}"
            try:
                subprocess.run(
                    [sys.executable, str(WORKSPACE / "scripts" / "wuji"),
                     "tg", "send", "448345880", msg],
                    capture_output=True, text=True, timeout=30,
                    cwd=str(SENTINEL_ROOT.parent)
                )
            except Exception as e:
                logger.warning(f"TG notify failed: {e}")

    logger.info(f"=== hormone_eval: done (fired={fired}) ===")
    return {"season": season, "focus": focus, "fired": fired}


if __name__ == "__main__":
    print(json.dumps(run({}, {}), indent=2))
