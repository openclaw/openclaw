#!/usr/bin/python3
"""Synthetic CLI used only inside first_run.py's private Linux HOME.

This proves the Tauri launch/teardown boundary, not real Gateway pairing or RFB.
The descendant shares the native-owned process group and must be joined before
the CLI can finish. Credentials are compared in memory and never recorded.
"""

import argparse
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


PRIMARY_TOKEN = "synthetic-desktop-primary-token"
SECONDARY_PASSWORD = "synthetic-desktop-secondary-password"
EVENTS = Path.home() / "desktop-cli-events.jsonl"
CANONICAL = Path.home() / ".openclaw/canonical-desktop.json"


def identity(pid):
    try:
        values = (Path("/proc") / str(pid) / "stat").read_text().rsplit(") ", 1)[1].split()
        return {"pid": pid, "start": values[19], "group": int(values[2]), "state": values[0]}
    except FileNotFoundError:
        return None


def still_exists(record):
    current = identity(record["pid"])
    return current is not None and current["start"] == record["start"]


def events():
    if not EVENTS.exists():
        return []
    lines = EVENTS.read_text().splitlines()
    if len(lines) > 512:
        raise RuntimeError("Fixture CLI exceeded its event bound")
    return [json.loads(line) for line in lines]


def record(event, **details):
    payload = json.dumps({"event": event, "at": time.monotonic_ns(), **details}) + "\n"
    descriptor = os.open(EVENTS, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, payload.encode())
    finally:
        os.close(descriptor)


class Arguments(argparse.ArgumentParser):
    def error(self, _message):
        # A regressed caller could put credentials in an unknown option. Never echo it.
        raise RuntimeError("Unexpected desktop CLI arguments")


def run_node(arguments):
    parser = Arguments(add_help=False)
    parser.add_argument("--commands", required=True)
    for option in ("desktop-sharing", "auth-from-env", "parent-stdin"):
        parser.add_argument("--" + option, action="store_true", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--context-path", required=True)
    tls = parser.add_mutually_exclusive_group(required=True)
    tls.add_argument("--tls", action="store_true", dest="tls")
    tls.add_argument("--no-tls", action="store_false", dest="tls")
    selected = parser.parse_args(arguments)
    if selected.commands != "desktop.stream" or selected.tls or selected.host != "127.0.0.1":
        raise RuntimeError("Desktop CLI exceeded the fixture's command/transport scope")
    if os.environ.get("OPENCLAW_CONFIG_PATH") != str(CANONICAL):
        raise RuntimeError("Desktop CLI lost the canonical config path")
    state_dir = Path(os.environ["OPENCLAW_STATE_DIR"])
    if not state_dir.is_relative_to(Path(os.environ["XDG_CONFIG_HOME"])) or state_dir.parent.name != "desktop-node":
        raise RuntimeError("Desktop CLI does not have app-owned identity state")
    if selected.context_path == "/fixture/":
        auth_matches = os.environ.get("OPENCLAW_GATEWAY_TOKEN") == PRIMARY_TOKEN and os.environ.get("OPENCLAW_GATEWAY_PASSWORD") == ""
    elif selected.context_path == "/secondary/":
        auth_matches = os.environ.get("OPENCLAW_GATEWAY_TOKEN") == "" and os.environ.get("OPENCLAW_GATEWAY_PASSWORD") == SECONDARY_PASSWORD
    else:
        raise RuntimeError("Desktop CLI selected an unexpected Gateway path")
    if not auth_matches:
        raise RuntimeError("Desktop CLI did not receive only the selected authentication")
    if "CF_ACCESS_CLIENT_ID" in os.environ or "CF_ACCESS_CLIENT_SECRET" in os.environ:
        raise RuntimeError("Desktop CLI inherited unrelated edge authentication")
    prior_alive = [
        process["pid"] for item in events() if item["event"] == "node-start"
        for process in (item["leader"], item["descendant"]) if still_exists(process)
    ]
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    leader = identity(os.getpid())
    descendant = identity(child.pid)
    if leader is None or descendant is None or leader["group"] != leader["pid"] or descendant["group"] != leader["group"]:
        raise RuntimeError("Fixture descendant did not enter the native-owned process group")
    record("node-start", leader=leader, descendant=descendant, priorAlive=prior_alive,
           args=sys.argv[1:], configPath=str(CANONICAL), stateDir=str(state_dir),
           endpoint={"host": selected.host, "port": selected.port, "path": selected.context_path},
           selectedAuthMatches=True)
    print("Synthetic desktop CLI is running.", flush=True)
    while not stopping:
        readable, _, _ = select.select([sys.stdin], [], [], 0.1)
        if readable and not sys.stdin.buffer.read(1):
            stopping = True
    # Native process-group shutdown must stop the descendant. The fixture must not
    # conceal a leader-only kill by terminating the child itself.
    child.wait(timeout=5)
    record("node-stop", pid=os.getpid(), descendantGone=not still_exists(descendant))


def main():
    arguments = sys.argv[1:]
    if arguments == ["--version"]:
        print("OpenClaw synthetic desktop fixture")
    elif arguments == ["config", "file", "--json"]:
        if (Path.home() / "desktop-cli-config-failure").exists():
            print(json.dumps({"ok": False, "error": {"message": "Synthetic config failure"}}))
            return 1
        print(json.dumps({"path": str(CANONICAL)}))
    elif arguments == ["config", "get", "desktop.host.enabled", "--json"]:
        config = json.loads(CANONICAL.read_text())
        included = CANONICAL.parent / config["desktop"]["host"]["$include"]
        host = json.loads(included.read_text())
        if "enabled" in host:
            print(json.dumps(host["enabled"]))
        else:
            print(json.dumps({"ok": False, "error": {"type": "cli_error", "message": "Config path is valid but unset: desktop.host.enabled. Synthetic fixture."}}))
            return 1
    elif arguments == ["gateway", "status", "--json"]:
        print(json.dumps({"service": {"loaded": True, "runtime": {"status": "running"}}, "rpc": {"ok": True}}))
    elif arguments == ["dashboard", "--json", "--no-open"]:
        config = json.loads((Path.home() / ".openclaw/openclaw.json").read_text())
        websocket = config["gateway"]["remote"]["url"]
        url = "http" + websocket[2:]
        print(json.dumps({"ok": True, "url": url, "browserUrl": url, "wsUrl": websocket}))
    elif arguments[:2] == ["node", "run"]:
        run_node(arguments[2:])
    else:
        raise RuntimeError("Unexpected synthetic CLI command")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        record("fixture-failure")
        print("Synthetic desktop CLI contract failed.", file=sys.stderr)
        sys.exit(1)
