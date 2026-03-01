"""Structured logging for Sentinel."""
import json
import logging
import logging.handlers
from datetime import datetime
from pathlib import Path

LOGS_DIR = Path(__file__).resolve().parent.parent / "logs"


def setup_logger(name="sentinel", level=logging.INFO):
    """Set up a logger with daily-rotating file and stderr output."""
    LOGS_DIR.mkdir(exist_ok=True)
    logger = logging.getLogger(name)
    logger.setLevel(level)

    if logger.handlers:
        return logger

    # Daily rotating file handler — rotates at midnight, keeps 14 days
    fh = logging.handlers.TimedRotatingFileHandler(
        LOGS_DIR / "sentinel.log",
        when="midnight",
        backupCount=14,
        encoding="utf-8",
    )
    fh.suffix = "%Y-%m-%d"
    fh.setLevel(level)

    # Stderr handler
    sh = logging.StreamHandler()
    sh.setLevel(level)

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    fh.setFormatter(fmt)
    sh.setFormatter(fmt)

    logger.addHandler(fh)
    logger.addHandler(sh)
    return logger


def log_event(logger, event_type, task_name="", detail="", success=True):
    """Log a structured event."""
    entry = {
        "ts": datetime.now().isoformat(),
        "event": event_type,
        "task": task_name,
        "detail": detail[:500] if detail else "",
        "ok": success,
    }
    if success:
        logger.info(json.dumps(entry, ensure_ascii=False))
    else:
        logger.error(json.dumps(entry, ensure_ascii=False))
