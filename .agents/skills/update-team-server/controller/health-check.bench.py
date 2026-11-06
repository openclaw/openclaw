#!/usr/bin/env python3
"""Linux owner-process control-cost benchmark; old CLI work is counted, not replayed.

Run on a disposable writable filesystem as a non-root user with Python, Bash,
curl and strace. --baseline is the original Bash body. HTTP endpoints
and systemd are synthetic; only fixed boundary paths are redirected. The state
shape is deliberately unreadable. No real Gateway or CLI is started.
"""

import argparse
import http.server
import json
import os
from pathlib import Path
import statistics
import re
import subprocess
import tempfile
import threading
import time
from urllib.parse import unquote


class Probes(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            payload = {"ok": True}
        elif self.path == "/readyz":
            payload = {"ready": True}
        else:
            query = unquote(self.path)
            value = "300" if "increase" in query else "1073741824" if "heap_used" in query else "0"
            payload = {"status": "success", "data": {"resultType": "vector", "result": [
                {"metric": {"job": "openclaw", "instance": "127.0.0.1:9464"}, "value": [time.time(), value]}
            ]}}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def executable(path, source):
    path.write_text(source)
    path.chmod(0o755)
    return path


def summary(samples):
    return {key: {"median": statistics.median(values), "p95": sorted(values)[-1],
                  "min": min(values), "max": max(values)}
            for key in samples[0] for values in [[sample[key] for sample in samples]]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--candidate", type=Path, default=Path(__file__).with_name("openclaw-health-check"))
    parser.add_argument("--root", required=True, type=Path, help="disposable fixture parent; e.g. a btrfs mount")
    options = parser.parse_args()
    if os.geteuid() == 0:
        parser.error("run the benchmark as a non-root user")
    before = options.baseline.read_text()
    after = options.candidate.read_text()
    with tempfile.TemporaryDirectory(dir=options.root, prefix="health-bench-") as temporary:
        root = Path(temporary)
        release = root / "releases" / ("a" * 40)
        release.mkdir(parents=True)
        state = root / "runtime-state"
        state.mkdir()
        database = state / "synthetic-agent.sqlite"
        with database.open("wb") as stream:
            stream.truncate(35 * 1024**3)
        sessions = state / "sessions"
        sessions.mkdir()
        for index in range(6000):
            (sessions / f"session-{index}.json").write_text('{"synthetic":true}\n')
        workspace = state / "workspace"
        workspace.mkdir()
        size = 1_100_000_000 // 62_000
        for index in range(62_000):
            with (workspace / f"file-{index}").open("wb") as stream:
                stream.truncate(size)
        state.chmod(0)
        cgroup = root / "cgroup"
        cgroup.write_text("0::/system.slice/openclaw-hourly-health-check.service\n")
        calls = root / "cli-calls"
        cli = executable(release / "openclaw.mjs", f"#!/bin/bash\nprintf '%s\\n' \"$*\" >> {calls}\n")
        unit = executable(root / "systemctl", "#!/bin/bash\ncat <<'UNIT'\nActiveState=active\nSubState=running\n"
                          "ExecStart={ argv[]=/usr/bin/node /opt/openclaw-team/current/dist/index.js gateway --port 18789 ; }\n"
                          "Environment=OPENCLAW_GATEWAY_PORT=18789\nUNIT\n")
        baseline = executable(root / "before", before.replace("/proc/self/cgroup", str(cgroup)))
        candidate = executable(root / "after", after.replace("/proc/self/cgroup", str(cgroup))
                               .replace("/usr/bin/systemctl", str(unit)))
        servers = [http.server.HTTPServer(("127.0.0.1", port), Probes) for port in (18789, 19090)]
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        environment = {**os.environ, "HOME": str(state), "OPENCLAW_MAINTENANCE_VERIFIED_AT_MS": str(int(time.time() * 1000))}
        commands = {"before": ["/bin/bash", str(baseline), str(cli)],
                    "after": (["/bin/bash"] if "bash" in after.splitlines()[0] else ["/usr/bin/python3", "-I"]) + [str(candidate), str(cli)]}
        measured = {key: [] for key in ("aa1", "aa2", "before", "after")}
        try:
            # One cold process per side is separate from the interleaved warm series.
            def run(label):
                started = time.perf_counter_ns()
                process = subprocess.Popen(commands[label], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                _, outcome, usage = os.wait4(process.pid, 0)
                process.returncode = os.waitstatus_to_exitcode(outcome)
                errors = process.stderr.read().decode()
                process.stderr.close()
                if process.returncode:
                    raise RuntimeError(errors)
                elapsed = (time.perf_counter_ns() - started) / 1e6
                return {"wall_ms": elapsed, "cpu_ms": (usage.ru_utime + usage.ru_stime) * 1000,
                        "max_rss_kib": usage.ru_maxrss}

            cold = {label: run(label) for label in commands}
            for _ in range(5):
                measured["aa1"].append(run("before"))
                measured["aa2"].append(run("before"))
            for _ in range(5):
                for label in commands:
                    measured[label].append(run(label))
            audit = {}
            for label, command in commands.items():
                calls.write_text("")
                trace = root / f"{label}.trace"
                subprocess.run(["strace", "-f", "-e", "trace=%file,process,memory", "-o", str(trace), *command],
                               env=environment, capture_output=True, check=True)
                lines = trace.read_text().splitlines()
                mappings, heap_growth, breaks = 0, 0, {}
                for line in lines:
                    mapping = re.search(r"mmap\([^,]+, (\d+),.*= 0x", line)
                    if mapping:
                        mappings += int(mapping[1])
                    heap = re.match(r"(\d+)\s+brk\([^)]*\)\s+= (0x[0-9a-f]+)", line)
                    if heap:
                        pid, address = heap[1], int(heap[2], 16)
                        heap_growth += max(0, address - breaks.get(pid, address))
                        breaks[pid] = address
                accesses = [line.replace(str(state), "$STATE") for line in lines if str(state) in line]
                audit[label] = {"cli_invocations": len(calls.read_text().splitlines()),
                                "state_path_syscalls": len(accesses), "state_accesses": accesses,
                                "mmap_requested_bytes": mappings, "brk_growth_bytes": heap_growth}
            filesystem = subprocess.run(["stat", "-f", "-c", "%T", str(root)], capture_output=True, text=True, check=True).stdout.strip()
            print(json.dumps({"scope": "owner process with synthetic HTTP/systemd and recording CLI; excludes CLI bootstrap cost",
                              "shape": {"filesystem": filesystem, "database_logical_bytes": 35 * 1024**3,
                                        "sessions": 6000, "workspace_files": 62000, "workspace_logical_bytes": size * 62000,
                                        "sparse": True, "state_mode": "000"},
                              "host_load": os.getloadavg(), "cold": cold,
                              "warm": {label: summary(samples) for label, samples in measured.items()},
                              "allocation_scope": "successful mmap request sizes and positive brk deltas, including loader mappings; virtual allocation, not live heap",
                              "audit": audit}, indent=2))
            if audit["after"]["cli_invocations"] or audit["after"]["state_path_syscalls"]:
                raise AssertionError("candidate opened the CLI/state boundary: " + json.dumps(audit["after"]))
        finally:
            state.chmod(0o700)
            for server in servers:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    main()
