#!/usr/bin/env python3
"""Task-only native proof. Run only on an ephemeral macOS hosted runner.

This qualification never authors a plist.
Product CLI owns installation, update, service generation, restart and uninstall.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import re
import shutil
import ssl
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import urllib.error
import uuid

candidate = Path(sys.argv[1]).resolve()
predecessor = Path(sys.argv[2]).resolve()
root = Path(sys.argv[3]).resolve()
assert platform.system() == "Darwin", "Native macOS required"
assert os.environ.get("GITHUB_ACTIONS") == "true", "Ephemeral hosted lane required"
assert candidate.is_file() and predecessor.is_file() and not root.exists()
root.mkdir(mode=0o700)
evidence = root / "evidence"
evidence.mkdir()
serial = 0
base_env = {k: os.environ[k] for k in ["PATH", "LANG", "TMPDIR", "HOME", "USER", "LOGNAME"] if k in os.environ}
base_env.update({"CI": "1", "NPM_CONFIG_AUDIT": "false", "NPM_CONFIG_FUND": "false"})
results = {"candidateSha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
           "predecessorSha256": hashlib.sha256(predecessor.read_bytes()).hexdigest(),
           "predecessorVersion": "2026.10.7", "sourceCommit": os.environ["CANDIDATE_SHA"],
           "platform": platform.platform(), "machine": platform.machine(), "cases": [],
           "status": "running", "cleanupStatus": "pending"}
with tarfile.open(candidate, "r:gz") as archive:
    candidate_files = {entry.name.removeprefix("package/"): hashlib.sha256(archive.extractfile(entry).read()).hexdigest()
        for entry in archive.getmembers() if entry.isfile() and (
            entry.name == "package/package.json" or
            (entry.name.startswith("package/") and entry.name.count("/") == 1 and entry.name.endswith(".mjs")) or
            entry.name.startswith("package/dist/"))}
    candidate_version = json.load(archive.extractfile("package/package.json"))["version"]
assert len(candidate_files) > 3, "Candidate distribution module identities missing"
results["candidateVersion"] = candidate_version
results["candidateDistributedFiles"] = candidate_files
labels = []
servers = []
original_bundle = Path("/etc/ssl/cert.pem").read_bytes()
account_home = Path(base_env["HOME"]).resolve()
assert account_home == Path(__import__("pwd").getpwuid(os.getuid()).pw_dir).resolve()
owned_states = []
trusted_root = None

def checkpoint():
    pending = evidence / "RESULTS.json.tmp"
    pending.write_text(json.dumps(results, indent=2) + "\n")
    pending.replace(evidence / "RESULTS.json")

results["originalBundleSha256"] = hashlib.sha256(original_bundle).hexdigest()
checkpoint()

def run(name, args, env=None, timeout=180, check=True):
    global serial
    serial += 1
    log = evidence / f"{serial:03d}-{name}.log"
    receipt = evidence / f"{serial:03d}-{name}.json"
    started = time.monotonic()
    command = {"name": name, "startedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "timeoutSeconds": timeout, "status": "running"}
    receipt.write_text(json.dumps(command, indent=2) + "\n")
    print(f"START {serial:03d} {name}", flush=True)
    try:
        r = subprocess.run([str(a) for a in args], env=env or base_env,
                           text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout)
    except subprocess.TimeoutExpired as error:
        # TimeoutExpired may carry bytes even when subprocess.run uses text mode.
        output = lambda value: value.decode(errors="replace") if isinstance(value, bytes) else value or ""
        log.write_text(output(error.stdout) + "\n[stderr]\n" + output(error.stderr))
        command.update(status="timed-out", elapsedSeconds=time.monotonic() - started)
        receipt.write_text(json.dumps(command, indent=2) + "\n")
        print(f"TIMEOUT {serial:03d} {name}", flush=True)
        raise
    log.write_text(r.stdout + "\n[stderr]\n" + r.stderr)
    command.update(status="returned", returncode=r.returncode, elapsedSeconds=time.monotonic() - started)
    receipt.write_text(json.dumps(command, indent=2) + "\n")
    print(f"DONE {serial:03d} {name}: {r.returncode}", flush=True)
    if check and r.returncode:
        raise RuntimeError(f"{name}: exit {r.returncode}; see numbered log")
    return r

def cert(name):
    d = root / name
    d.mkdir()
    (d / "root.cnf").write_text(
        "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n"
        f"[dn]\nCN=OpenClaw native qualification {name}\n"
        "[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n")
    run(name + "-ca", ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", d / "root.key", "-out", d / "root.pem", "-days", "3",
        "-config", d / "root.cnf"])
    run(name + "-csr", ["openssl", "req", "-newkey", "rsa:2048", "-nodes",
        "-keyout", d / "leaf.key", "-out", d / "leaf.csr", "-subj", "/CN=localhost"])
    (d / "ext.cnf").write_text("subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n")
    run(name + "-sign", ["openssl", "x509", "-req", "-in", d / "leaf.csr", "-CA", d / "root.pem",
        "-CAkey", d / "root.key", "-CAcreateserial", "-out", d / "leaf.pem", "-days", "3",
        "-extfile", d / "ext.cnf"])
    shutil.copyfile(d / "root.pem", evidence / f"{name}-root.pem")
    shutil.copyfile(d / "leaf.pem", evidence / f"{name}-leaf.pem")
    return d

def peer(name, d):
    counts = {"httpRequests": 0}
    payloads = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def parse_request(self):
            parsed = super().parse_request()
            if parsed:
                counts["httpRequests"] += 1
            return parsed
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            payloads.append(json.dumps(payload, sort_keys=True))
            msg = {"id": "chatcmpl-native-proof", "object": "chat.completion", "created": 1,
                "model": "tls-proof", "choices": [{"index": 0, "message": {"role": "assistant",
                "content": "NATIVE_TLS_OK"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
            if payload.get("stream"):
                chunks = [{"id": msg["id"], "object": "chat.completion.chunk", "created": 1,
                    "model": "tls-proof", "choices": [{"index": 0, "delta": {"role": "assistant",
                    "content": "NATIVE_TLS_OK"}, "finish_reason": None}]},
                    {"id": msg["id"], "object": "chat.completion.chunk", "created": 1,
                    "model": "tls-proof", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
                body = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
                kind = "text/event-stream"
            else:
                body = json.dumps(msg).encode()
                kind = "application/json"
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(d / "leaf.pem", d / "leaf.key")
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    servers.append(srv)
    return {"name": name, "port": srv.server_port, "counts": counts, "payloads": payloads}

def config(state, workspace, port, peer):
    return {"gateway": {"mode": "local", "port": port, "bind": "loopback",
            "auth": {"mode": "token", "token": "synthetic-native-proof-token"},
            "controlUi": {"enabled": False}, "http": {"endpoints": {"chatCompletions": {"enabled": True}}}},
        "logging": {"file": str(state / "gateway.log"), "level": "debug"},
        "models": {"mode": "merge", "providers": {"openai": {"api": "openai-completions",
            "baseUrl": f"https://127.0.0.1:{peer['port']}/v1", "apiKey": "synthetic-native-proof-key",
            "agentRuntime": {"id": "openclaw"}, "models": [{"id": "tls-proof", "name": "tls-proof",
            "api": "openai-completions", "reasoning": False, "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 32768, "maxTokens": 128}]}}},
        "agents": {"entries": {"main": {"name": "Synthetic native trust proof"}}, "defaults": {"workspace": str(workspace), "skipBootstrap": True,
            "model": {"primary": "openai/tls-proof", "fallbacks": []},
            "models": {"openai/tls-proof": {"agentRuntime": {"id": "openclaw"}}}}},
        "plugins": {"enabled": True, "allow": ["openai"], "slots": {"memory": "none"}},
        "skills": {"allowBundled": []}, "tools": {"allow": []}}

def wait_service(cli, env, name):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        r = run(name + "-health", [cli, "gateway", "health", "--json", "--timeout", "5000"], env, timeout=30, check=False)
        if r.returncode == 0: return
        time.sleep(2)
    raise RuntimeError(name + ": managed Gateway did not become ready")

def snapshot(env, name, expected_extra, prefix):
    label = env["OPENCLAW_LAUNCHD_LABEL"]
    r = run(name + "-launchctl", ["launchctl", "print", f"gui/{os.getuid()}/{label}"], env)
    m = re.search(r"\bpid = (\d+)", r.stdout)
    assert m, "No live launchd PID"
    supervisor_pid = m.group(1)
    port = json.loads(Path(env["OPENCLAW_CONFIG_PATH"]).read_text())["gateway"]["port"]
    listeners = set(run(name + "-listeners", ["lsof", "-nP", "-iTCP:" + str(port), "-sTCP:LISTEN", "-t"], env).stdout.split())
    assert len(listeners) == 1, "Managed Gateway port must have one owning process"
    pid = listeners.pop()
    ancestor = pid
    for _ in range(32):
        if ancestor == supervisor_pid:
            break
        ancestor = run(name + "-ancestor-" + ancestor, ["ps", "-p", ancestor, "-o", "ppid="], env).stdout.strip()
        if not ancestor or int(ancestor) <= 1:
            break
    assert ancestor == supervisor_pid, "Listening process does not belong to the generated LaunchAgent"
    ps = run(name + "-pid", ["ps", "eww", "-p", pid, "-o", "pid=,comm=,args="], env).stdout
    assert str(prefix) in r.stdout, "launchd did not select the installed package"
    assert "NODE_USE_SYSTEM_CA=1" in ps
    if expected_extra:
        assert f"NODE_EXTRA_CA_CERTS={expected_extra}" in ps
    else:
        assert "NODE_EXTRA_CA_CERTS=" not in ps
    plist = Path(env["HOME"]) / "Library/LaunchAgents" / (label + ".plist")
    shutil.copyfile(plist, evidence / (name + ".plist"))
    for path in (Path(env["OPENCLAW_STATE_DIR"]) / "service-env").glob(label + "*"):
        shutil.copyfile(path, evidence / (name + "-" + path.name))
    binaries = run(name + "-executable", ["lsof", "-a", "-p", pid, "-d", "txt", "-Fn"], env).stdout
    selected = [Path(line[1:]) for line in binaries.splitlines()
                if line.startswith("n") and Path(line[1:]).name in ["node", "bun"]]
    assert selected, "Native executable identity is missing"
    results.setdefault("serviceProcesses", []).append({"name": name, "pid": int(pid), "launchdPid": int(supervisor_pid),
        "binaries": [{"path": str(x), "sha256": hashlib.sha256(x.read_bytes()).hexdigest()} for x in selected]})
    checkpoint()
    return pid

def sessions(cli, env, name):
    text = run(name, [cli, "sessions", "--json"], env).stdout
    data = json.loads(text)
    identities = {(x.get("key"), x.get("sessionId")) for x in data["sessions"]}
    assert identities and all(k and v for k, v in identities), "Actual session identities missing"
    return identities

def assert_candidate(cli, env, name):
    version = run(name + "-version", [cli, "--version"], env).stdout
    assert re.search(r"\b" + re.escape(candidate_version) + r"\b", version), "Candidate version was not installed"
    installed_root = cli.resolve().parent
    for filename, expected_sha in candidate_files.items():
        installed_file = installed_root / filename
        assert installed_file.is_file(), "Candidate distribution file missing: " + filename
        assert hashlib.sha256(installed_file.read_bytes()).hexdigest() == expected_sha, "Candidate distribution differs: " + filename
    results.setdefault("verifiedCandidateRoots", []).append({"name": name, "root": str(installed_root),
        "verifiedFileCount": len(candidate_files)})
    checkpoint()

def probe(cli, env, cfg, peer, expected, name, message="Reply with NATIVE_TLS_OK", required_history=None):
    cfg = json.loads(Path(env["OPENCLAW_CONFIG_PATH"]).read_text())
    cfg["models"]["providers"]["openai"]["baseUrl"] = f"https://127.0.0.1:{peer['port']}/v1"
    Path(env["OPENCLAW_CONFIG_PATH"]).write_text(json.dumps(cfg))
    run(name + "-restart", [cli, "gateway", "restart", "--json"], env, timeout=240)
    wait_service(cli, env, name)
    before = peer["counts"]["httpRequests"]
    payload_before = len(peer["payloads"])
    gateway_log = Path(env["OPENCLAW_STATE_DIR"]) / "gateway.log"
    log_before = gateway_log.read_bytes() if gateway_log.exists() else b""
    req = urllib.request.Request(f"http://127.0.0.1:{cfg['gateway']['port']}/v1/chat/completions",
        data=json.dumps({"model": "openclaw:main", "user": "retained-predecessor",
            "messages": [{"role": "user", "content": message}], "stream": False}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer synthetic-native-proof-token"})
    try:
        with urllib.request.urlopen(req, timeout=120) as response: text = response.read().decode()
    except urllib.error.HTTPError as error:
        text = error.read().decode()
    (evidence / (name + "-gateway-response.txt")).write_text(text)
    count = peer["counts"]["httpRequests"] - before
    if expected:
        assert count > 0 and "NATIVE_TLS_OK" in text, name + ": positive provider path failed"
        if required_history:
            assert required_history not in message, "Continuation must not supply the predecessor marker"
            assert any(required_history in payload for payload in peer["payloads"][payload_before:]), name + ": predecessor conversation content was not usable"
    else:
        assert count == 0 and "NATIVE_TLS_OK" not in text, name + ": removed trust still reached HTTP"
        # No HTTP effect alone is insufficient: require TLS cause from actual process diagnostics.
        log_after = gateway_log.read_bytes()
        assert log_after.startswith(log_before), name + ": log rotated; TLS attribution incomplete"
        logs = log_after[len(log_before):].decode(errors="replace")
        (evidence / (name + "-gateway-tls-diagnostic.log")).write_text(logs)
        assert re.search(r"certificate|CERTIFICATE|UNABLE_TO_VERIFY|SELF_SIGNED", logs), name + ": TLS attribution absent"
    results["cases"].append({"name": name, "expectedAllowed": expected, "httpEffects": count,
        "requiredHistoryMarkerPresent": True if required_history else None,
        "providerPayloadSha256": [hashlib.sha256(x.encode()).hexdigest() for x in peer["payloads"][payload_before:]]})
    checkpoint()

try:
    run("native-os", ["sw_vers"])
    run("resources", ["sysctl", "hw.logicalcpu", "hw.memsize"])
    run("gui-domain", ["launchctl", "print", f"gui/{os.getuid()}"])
    run("runtime", ["node", "--version"])
    allowed_ca, legacy_ca, custom_ca = [cert(x) for x in ["allowed-os", "legacy-only", "custom-explicit"]]
    trusted_root = allowed_ca / "root.pem"
    run("trust-owned-os-root", ["sudo", "security", "add-trusted-cert", "-d", "-r", "trustRoot",
        "-k", "/Library/Keychains/System.keychain", trusted_root])
    merged = root / "controlled-legacy-bundle.pem"
    merged.write_bytes(original_bundle + b"\n" + (legacy_ca / "root.pem").read_bytes())
    run("install-owned-legacy-bundle", ["sudo", "cp", merged, "/etc/ssl/cert.pem"])
    allowed, legacy, custom = [peer(n, d) for n, d in [
        ("allowed-os", allowed_ca), ("legacy-only", legacy_ca), ("custom-explicit", custom_ca)]]
    for scenario in ["fresh-default", "upgrade-legacy", "upgrade-explicit"]:
        d = root / scenario
        d.mkdir()
        profile = "native-ca-" + scenario + "-" + uuid.uuid4().hex[:8]
        home = account_home
        state = home / (".openclaw-" + profile)
        assert not state.exists(), "Task profile must be new"
        workspace, prefix = [d / x for x in ["workspace", "prefix"]]
        for x in [state, workspace]: x.mkdir(mode=0o700)
        owned_states.append(state)
        sentinel = workspace / "retained-user-content.txt"
        sentinel.write_text("retained synthetic workspace content\n")
        env = dict(base_env, OPENCLAW_STATE_DIR=str(state),
            OPENCLAW_CONFIG_PATH=str(state / "openclaw.json"), OPENCLAW_PROFILE=profile,
            OPENCLAW_LAUNCHD_LABEL="ai.openclaw." + profile,
            npm_config_prefix=str(prefix), npm_config_cache=str(d / "npm-cache"),
            XDG_CACHE_HOME=str(d / "cache"))
        env["PATH"] = str(prefix / "bin") + ":" + base_env["PATH"]
        labels.append((env["OPENCLAW_LAUNCHD_LABEL"], env))
        explicit = str(custom_ca / "root.pem") if scenario.endswith("explicit") else None
        if explicit: env["NODE_EXTRA_CA_CERTS"] = explicit
        # Native port claim by bind; no other lane is permitted in this hosted job.
        import socket
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
        cfg = config(state, workspace, port, custom if explicit else allowed)
        Path(env["OPENCLAW_CONFIG_PATH"]).write_text(json.dumps(cfg))
        Path(env["OPENCLAW_CONFIG_PATH"]).chmod(0o600)
        spec = str(candidate) if scenario.startswith("fresh") else str(predecessor)
        run(scenario + "-install", ["npm", "install", "--global", "--prefix", prefix, spec], env, timeout=600)
        cli = prefix / "bin/openclaw"
        run(scenario + "-config-validate", [cli, "config", "validate", "--json"], env)
        run(scenario + "-installed-version", [cli, "--version"], env)
        run(scenario + "-service-install", [cli, "gateway", "install", "--port", str(port), "--json"], env, timeout=240)
        wait_service(cli, env, scenario)
        predecessor_sessions = set()
        predecessor_marker = None
        predecessor_pid = None
        if not scenario.startswith("fresh"):
            predecessor_marker = "PREDECESSOR_ONLY_" + uuid.uuid4().hex
            probe(cli, env, cfg, custom if explicit else legacy, True, scenario + "-stable-control",
                message="Remember " + predecessor_marker + ". Reply with NATIVE_TLS_OK")
            predecessor_sessions = sessions(cli, env, scenario + "-stable-sessions")
            predecessor_pid = snapshot(env, scenario + "-stable", explicit or "/etc/ssl/cert.pem", prefix)
            # Do not carry install-shell custom CA: the installed-service owner must retain it.
            env.pop("NODE_EXTRA_CA_CERTS", None)
            updated = run(scenario + "-actual-update", [cli, "update", "--tag", candidate, "--yes", "--json", "--timeout", "600"], env, timeout=1000)
            assert json.loads(updated.stdout)["status"] == "ok", "Update refused or skipped candidate activation"
            run(scenario + "-drift-install", [cli, "gateway", "install", "--json"], env, timeout=240)
        # Inspect retained settings before any probe changes the provider URL.
        retained_cfg = json.loads(Path(env["OPENCLAW_CONFIG_PATH"]).read_text())
        assert retained_cfg["gateway"]["auth"] == cfg["gateway"]["auth"]
        assert retained_cfg["agents"]["defaults"]["workspace"] == str(workspace)
        assert retained_cfg["agents"]["entries"]["main"]["name"] == "Synthetic native trust proof"
        assert sentinel.read_text() == "retained synthetic workspace content\n"
        assert_candidate(cli, env, scenario + "-candidate")
        run(scenario + "-candidate-config-validate", [cli, "config", "validate", "--json"], env)
        run(scenario + "-candidate-restart", [cli, "gateway", "restart", "--json"], env, timeout=240)
        wait_service(cli, env, scenario + "-candidate")
        candidate_pid = snapshot(env, scenario + "-candidate", explicit, prefix)
        assert candidate_pid != predecessor_pid, "Managed predecessor process was not replaced"
        probe(cli, env, cfg, allowed, True, scenario + "-candidate-os-control", required_history=predecessor_marker)
        if explicit: probe(cli, env, cfg, custom, True, scenario + "-candidate-custom-control")
        probe(cli, env, cfg, legacy, False, scenario + "-candidate-legacy-rejection")
        assert sentinel.read_text() == "retained synthetic workspace content\n"
        actual_cfg = json.loads(Path(env["OPENCLAW_CONFIG_PATH"]).read_text())
        assert actual_cfg["gateway"]["auth"] == cfg["gateway"]["auth"]
        assert actual_cfg["agents"]["defaults"]["workspace"] == str(workspace)
        candidate_sessions = sessions(cli, env, scenario + "-candidate-sessions")
        assert predecessor_sessions <= candidate_sessions, "Released-predecessor sessions were lost or reidentified"
        results.setdefault("retainedSessions", []).append({"scenario": scenario,
            "predecessor": sorted(predecessor_sessions), "candidate": sorted(candidate_sessions)})
        checkpoint()
        run(scenario + "-uninstall", [cli, "gateway", "uninstall", "--json"], env, timeout=240)
    results["status"] = "behavior-passed-cleanup-pending"
    checkpoint()
    shutil.copyfile(evidence / "RESULTS.json", evidence / "BEHAVIOR-RESULTS.json")
except Exception as error:
    results["status"] = "failed-or-blocked"
    results["failure"] = {"type": type(error).__name__, "message": str(error)}
    checkpoint()
    raise
finally:
    cleanup_failures = []
    def cleanup_command(name, args, env=None):
        try:
            return run(name, args, env, check=False)
        except Exception as error:
            cleanup_failures.append(f"{name}: {type(error).__name__}: {error}")
            return None

    results["cleanupStatus"] = "running"
    checkpoint()
    cleanup_completed = False
    try:
        for state in owned_states:
            gateway_log = state / "gateway.log"
            if gateway_log.is_file():
                shutil.copyfile(gateway_log, evidence / (state.name.removeprefix(".") + "-gateway.log"))
        results["retainedTaskStates"] = [str(x) for x in owned_states]
        results["retiredLaunchAgents"] = []
        for label, env in labels:
            cleanup_command("cleanup-" + label, ["launchctl", "bootout", f"gui/{os.getuid()}/{label}"], env)
            remaining = cleanup_command("verify-retired-" + label, ["launchctl", "print", f"gui/{os.getuid()}/{label}"], env)
            if remaining is not None and remaining.returncode != 0:
                results["retiredLaunchAgents"].append(label)
            else:
                cleanup_failures.append("LaunchAgent retirement unverified: " + label)
            checkpoint()
        for server in servers: server.shutdown(); server.server_close()
        restore = root / "original-cert.pem"
        restore.write_bytes(original_bundle)
        cleanup_command("restore-original-bundle", ["sudo", "cp", restore, "/etc/ssl/cert.pem"])
        results["restoredBundleSha256"] = hashlib.sha256(Path("/etc/ssl/cert.pem").read_bytes()).hexdigest()
        if results["restoredBundleSha256"] != results["originalBundleSha256"]:
            cleanup_failures.append("Original OS bundle was not restored")
        checkpoint()
        if trusted_root:
            retired = cleanup_command("retire-owned-trust", ["sudo", "security", "remove-trusted-cert", "-d", trusted_root])
            results["ownedTrustRemoved"] = retired is not None and retired.returncode == 0
            if not results["ownedTrustRemoved"]:
                cleanup_failures.append("Owned system trust removal failed")
        cleanup_completed = True
    except Exception as error:
        cleanup_failures.append(f"{type(error).__name__}: {error}")
    finally:
        if not cleanup_completed:
            cleanup_failures.append("Cleanup interrupted before completion")
        results["cleanupFailures"] = cleanup_failures
        results["cleanupStatus"] = "failed" if cleanup_failures else "passed"
        if cleanup_failures:
            results["status"] = "failed-or-blocked"
        elif results["status"] == "behavior-passed-cleanup-pending":
            results["status"] = "passed"
        checkpoint()
        # Only evidence is uploaded. Private keys, installed packages and HOME stay disposable.
        manifest = {x.name: hashlib.sha256(x.read_bytes()).hexdigest() for x in evidence.iterdir() if x.is_file()}
        (evidence / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if cleanup_failures and "failure" not in results:
        raise RuntimeError("Native cleanup verification failed; see RESULTS.json")
