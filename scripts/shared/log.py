"""shared/log.py — Centralized logging for OpenClaw scripts.

Usage:
    from shared.log import make_logger

    log = make_logger()                          # print-only
    log = make_logger(log_file="path/to.log")    # print + file
    log = make_logger(collector=my_list)          # print + collect lines
"""
from datetime import datetime


def make_logger(log_file=None, collector=None):
    """Create a log function with optional file output and line collection.

    Args:
        log_file: If set, also append each line to this file path.
        collector: If set (list), also append each formatted line.
    """
    def _log(msg, level="INFO"):
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{ts}] [{level}] {msg}" if level != "INFO" else f"[{ts}] {msg}"
        print(line, flush=True)
        if log_file:
            try:
                with open(log_file, "a") as f:
                    f.write(line + "\n")
            except OSError:
                pass
        if collector is not None:
            collector.append(line)
    return _log
