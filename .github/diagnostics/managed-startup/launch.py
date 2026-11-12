#!/usr/bin/env python3
"""Task-owned ExecStart drop-in. Replay generated base argv, inserting only preload."""
import json, os, pathlib, re, shlex, sys, time

base, config_path = map(pathlib.Path, sys.argv[1:])
config = json.loads(config_path.read_text())
lines = [line[len("ExecStart="):] for line in base.read_text().splitlines()
         if line.startswith("ExecStart=")]
if len(lines) != 1 or any(c in lines[0] for c in "\\$%\n\r"):
    raise SystemExit("unsupported generated ExecStart encoding; no launch")
argv = shlex.split(lines[0])
if pathlib.Path(argv[0]).resolve() != pathlib.Path(config["node"]).resolve():
    raise SystemExit("native installer did not select exact pinned Node")
i = 1
while i < len(argv) and re.fullmatch(r"--max-(?:old-space-size|heap-size)=\d+", argv[i]):
    i += 1
entry = pathlib.Path(argv[i]).resolve()
package = pathlib.Path(config["package"]).resolve()
if not entry.is_relative_to(package) or not entry.is_file():
    raise SystemExit("native service entrypoint outside verified installed package")
if argv[i+1:] != ["gateway", "--port", str(config["port"])]:
    raise SystemExit("unexpected native service arguments")
# Read exact native autoheap argv; do not duplicate or reinterpret its algorithm.
profiled = argv[:i] + ["--require", str(config_path.parent / "preload.cjs")] + argv[i:]
allowed = {"PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR",
           "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "INVOCATION_ID",
           "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "OPENCLAW_SYSTEMD_UNIT",
           "OPENCLAW_SERVICE_MARKER", "OPENCLAW_SERVICE_KIND", "OPENCLAW_SERVICE_VERSION",
           "OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_PORT"}
env = {k: v for k, v in os.environ.items() if k in allowed}
env["HOME"] = config["home"]
# Empty NODE_OPTIONS is intentional; no ambient flags or secrets enter the gateway.
env["NODE_OPTIONS"] = ""
record = {"at": int(time.time()*1000), "pid": os.getpid(), "uid": os.getuid(),
          "originalArgv": argv, "profiledArgv": profiled,
          "environmentKeys": sorted(env), "nativeHeapArgv": argv[1:i]}
pathlib.Path(config["output"], "launch.json").write_text(json.dumps(record, indent=2)+"\n")
os.execve(argv[0], profiled, env)
