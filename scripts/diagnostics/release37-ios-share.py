#!/usr/bin/env python3
"""One exact-source attachment diagnostic; no test, product, or timeout changes."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

SOURCE = "a27b5ab63e3c4efc4b700f60ae468b0ce529f0cd"
FILES = ["apps/ios/UITests/OpenClawSnapshotUITests.swift",
         "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatFileAttachment.swift",
         "scripts/test-ios-chat-attachments.sh"]
PREDICATE = ('process CONTAINS[c] "share" OR process == "runningboardd" OR '
             'subsystem BEGINSWITH "com.apple.UIKit" OR process BEGINSWITH "OpenClaw" OR '
             'process == "ReportCrash"')

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def devices():
    data = subprocess.check_output(["xcrun", "simctl", "list", "devices", "--json"], timeout=15)
    return [d for rows in json.loads(data)["devices"].values() for d in rows]

def main():
    output = Path(os.environ["IOS_DIAGNOSTIC_OUTPUT"])
    output.mkdir(parents=True, exist_ok=True)
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == SOURCE
    before = {p: digest(p) for p in FILES}
    initial = {d["udid"] for d in devices()}
    stop = threading.Event()
    streams = {}
    errors = []
    observed = []
    def observe():
        while not stop.is_set():
            try:
                for d in devices():
                    uid = d["udid"]
                    if uid in initial or uid in streams or d.get("state") != "Booted":
                        continue
                    if not d.get("name", "").startswith("OpenClaw attachments after "):
                        continue
                    log = (output / (uid + "-share.log")).open("wb")
                    p = subprocess.Popen(["xcrun", "simctl", "spawn", uid, "log", "stream",
                                          "--style", "ndjson", "--level", "debug", "--predicate", PREDICATE],
                                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    streams[uid] = (p, log)
                    observed.append({"udid": uid, "name": d["name"], "startedAt": time.time()})
            except (subprocess.SubprocessError, OSError, ValueError) as error:
                errors.append(type(error).__name__ + ": " + str(error))
            stop.wait(1)
    worker = threading.Thread(target=observe)
    worker.start()
    child = None
    exit_code = 1
    interrupted = False
    def interrupt(signum, _frame):
        nonlocal interrupted
        interrupted = True
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
    old_handlers = {s: signal.signal(s, interrupt) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        with (output / "attachment-driver.log").open("wb") as log:
            child = subprocess.Popen(["/bin/bash", "scripts/test-ios-chat-attachments.sh"],
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            exit_code = child.wait()
    finally:
        stop.set()
        worker.join()
        for p, log in streams.values():
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGTERM)
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait()
            log.close()
        for s, handler in old_handlers.items():
            signal.signal(s, handler)
        after = {p: digest(p) for p in FILES}
        captures = [{"udid": uid, "bytes": (output / (uid + "-share.log")).stat().st_size,
                     "exitCode": p.returncode} for uid, (p, _log) in streams.items()]
        result = {"qualification": False, "source": SOURCE, "testExit": exit_code,
                  "interrupted": interrupted, "before": before, "after": after,
                  "sourceUnchanged": before == after, "observedDevices": observed,
                  "streams": captures, "observerErrors": errors,
                  "capturePresent": bool(captures) and all(c["bytes"] > 0 for c in captures),
                  "note": "Stream bytes alone do not prove causal coverage; inspect them with the test result."}
        (output / "result.json").write_text(json.dumps(result, indent=2) + chr(10))
    return 1 if interrupted or before != after or errors or not result["capturePresent"] else (0 if exit_code == 0 else 1)

if __name__ == "__main__":
    sys.exit(main())
