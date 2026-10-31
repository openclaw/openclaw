#!/usr/bin/env python3
"""Run isolated built-Gateway retention proof; no model calls or real channels.

Usage: python3 scripts/perf/dispatcher-retention-gateway.py CHECKOUT LABEL OUTPUT_DIR [EXPECTED_ALIVE=0]
Build each checkout first with `pnpm build:runtime`. Use the same probe file for
both checkouts. Default expectation is zero (red on the original defect).
Pass 16 only to record the known leaking baseline as an observation.
OUTPUT_DIR retains snapshots: inspect and redact before sharing.
The process is stopped after measurement; orphan reservations intentionally remain.
"""

import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1]).resolve()
label = sys.argv[2]
out = pathlib.Path(sys.argv[3]).resolve()
out.mkdir(parents=True, exist_ok=True)
expected_alive = int(sys.argv[4]) if len(sys.argv) > 4 else 0
assert expected_alive in (0, 16)
state = out / (label + "-state")
state.mkdir(exist_ok=True)
config = state / "openclaw.json"
config.write_text(
    json.dumps(
        {
            "browser": {"enabled": False},
            "update": {"checkOnStart": False},
            "discovery": {"mdns": {"mode": "off"}},
            "gateway": {
                "mode": "local",
                "bind": "loopback",
                "auth": {"mode": "none"},
                "controlUi": {"enabled": False},
                "tailscale": {"mode": "off"},
            },
            "plugins": {"enabled": False},
            "cron": {"enabled": False},
        }
    )
)
s = socket.socket()
s.bind(("127.0.0.1", 0))
port = s.getsockname()[1]
s.close()
result = out / (label + "-gateway.json")
assert not result.exists()
env = {
    k: v
    for k, v in os.environ.items()
    if k in ("PATH", "LANG", "LC_ALL", "TMPDIR", "HOME", "USER")
}
env.update(
    OPENCLAW_STATE_DIR=str(state),
    OPENCLAW_CONFIG_PATH=str(config),
    OPENCLAW_RETENTION_ENTRY=str(root / "dist/plugin-sdk/reply-runtime.js"),
    OPENCLAW_RETENTION_READY_URL=f"http://127.0.0.1:{port}/readyz",
    OPENCLAW_RETENTION_OUTPUT=str(result),
    PROBE_SNAPSHOT=str(out / (label + "-gateway.heapsnapshot")),
)
cmd = [
    "node",
    "--expose-gc",
    "--import",
    str(pathlib.Path(__file__).with_name("dispatcher-retention-measure.mjs").resolve()),
    str(root / "dist/entry.js"),
    "gateway",
    "run",
    "--allow-unconfigured",
    "--port",
    str(port),
    "--bind",
    "loopback",
]
with open(out / (label + "-gateway.log"), "w") as log:
    p = subprocess.Popen(
        cmd,
        cwd=root,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 180
        while not result.exists() and p.poll() is None and time.monotonic() < deadline:
            time.sleep(0.2)
        assert result.exists(), f"No measurement; gateway exit={p.poll()}"
        data = json.loads(result.read_text())
        assert "error" not in data, data
        assert data["pid"] == p.pid, (data["pid"], p.pid)
        assert data["isMainThread"] is True and data["threadId"] == 0, data
        assert data["entry"] == str(root / "dist/entry.js"), data["entry"]
        assert data["dispatcherModule"] == str(
            root / "dist/plugin-sdk/reply-runtime.js"
        )
        data["parentVerifiedGatewayPid"] = p.pid
        data["head"] = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True
        ).strip()
        result.write_text(json.dumps(data, indent=2) + "\n")
        print(json.dumps(data))
        assert data["alive"] == expected_alive, (data["alive"], expected_alive)
        assert (out / (label + "-gateway.heapsnapshot")).stat().st_size > 0
    finally:
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
