#!/usr/bin/env python3
"""Hostile synthetic source through the production native candidate boundary."""
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request


def main():
    if sys.platform not in ("darwin", "linux"):
        raise SystemExit("Native candidate isolation requires macOS or Linux.")
    repo = Path(__file__).resolve().parent.parent
    helper = repo / "scripts/lib" / ("native-candidate-macos.py" if sys.platform == "darwin" else "native-candidate-linux.py")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Q's pinned Node toolchain is required before the probe")
    npm = Path(subprocess.check_output([node, "-p", "require.resolve('npm/package.json')"], cwd=repo, text=True).strip()).parent
    version = json.loads((repo / "package.json").read_text())["packageManager"].split("@", 1)[1].split("+", 1)[0]
    root = Path(tempfile.mkdtemp(prefix="openclaw-isolation-proof-",
                                 dir="/private/tmp" if sys.platform == "darwin" else None)).resolve()
    root.chmod(0o755)
    boundary = root / "boundary"
    servers = []
    cleanup_ok = False
    try:
        protected = root / "qualification"
        protected.mkdir(mode=0o700)
        canary = protected / "evidence"
        canary.write_text("trusted Q evidence")
        fixture = root / "source"
        fixture.mkdir()
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")
            def log_message(self, *_args):
                pass
        for address in ("127.0.0.1", "0.0.0.0"):
            server = http.server.ThreadingHTTPServer((address, 0), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            servers.append(server)
        provider, unrelated = (server.server_port for server in servers)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route:
            route.connect(("1.1.1.1", 443))
            host_address = route.getsockname()[0]
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            gateway_port = reservation.getsockname()[1]
        payload = r'''
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const phase = process.argv[2];
const details = JSON.parse(fs.readFileSync(path.join(__dirname, "probe.json"), "utf8"));
const denied = new Set(["EACCES", "EPERM", "ENOENT"]);
for (const action of [() => fs.readFileSync(details.canary), () => fs.writeFileSync(details.canary, "forged")]) {
  assert.throws(action, error => denied.has(error.code));
}
assert.notEqual(process.getuid(), 0);
assert.equal(process.env.ISOLATION_SECRET_CANARY, undefined);
assert.throws(() => process.kill(details.parent, 0), error => denied.has(error.code) || error.code === "ESRCH");
const sudo = spawnSync("sudo", ["-n", "true"]);
assert(sudo.status !== 0);
const own = path.join(process.env.HOME, "own-write");
fs.writeFileSync(own, "private");
assert.equal(fs.readFileSync(own, "utf8"), "private");
// Both owners must remove descendants that detach and ignore graceful shutdown.
const detached = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
detached.unref();
async function request(port, host = "127.0.0.1") {
  return await new Promise((resolve, reject) => {
    // Bypass Node's build proxy agent: this assertion tests direct socket denial.
    const req = http.get({ host, port, path: "/v1/probe", timeout: 2500, agent: false }, response => {
      let text = "";
      response.on("data", chunk => text += chunk);
      response.on("end", () => resolve(text));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
(async () => {
  if (phase === "serve") {
    const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
    assert.equal(config.gateway.bind, "loopback");
    const server = http.createServer((request, response) => {
      assert.equal(request.socket.remoteAddress, "127.0.0.1");
      response.end("loopback-preserved");
      server.close();
    });
    server.listen(config.gateway.port, "127.0.0.1");
  } else if (phase === "probe") {
    assert.equal(process.env.NODE_USE_ENV_PROXY, undefined);
    const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
    const endpoint = new URL(config.models.providers.fixture.baseUrl);
    const result = await new Promise((resolve, reject) => {
      http.get(endpoint, response => { let text = ""; response.on("data", chunk => text += chunk); response.on("end", () => resolve(text)); }).on("error", reject);
    });
    assert.equal(result, "ok");
    await assert.rejects(request(details.unrelated));
    const state = path.join(process.env.OPENCLAW_STATE_DIR, "probe-count");
    const count = fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) + 1 : 1;
    fs.writeFileSync(state, String(count));
    console.error("candidate-runtime-diagnostic");
    console.log(JSON.stringify({ phase, count, provider: "ok", protected: "denied", unrelated: "denied" }));
  } else {
    await assert.rejects(request(details.unrelated, details.host));
    if (process.env.HTTPS_PROXY) {
      assert.equal(process.env.NODE_USE_ENV_PROXY, "1");
      // Exercise the same Node fetch path used by candidate worker-deploy builds.
      const registry = await fetch("https://registry.npmjs.org/pnpm/latest", { signal: AbortSignal.timeout(30000) });
      assert.equal(registry.status, 200);
      await registry.arrayBuffer();
      const proxy = new URL(process.env.HTTPS_PROXY);
      const response = await new Promise((resolve, reject) => {
        const socket = net.connect(Number(proxy.port), proxy.hostname);
        socket.setTimeout(2500, () => socket.destroy(new Error("proxy denial timed out")));
        socket.on("connect", () => socket.write("CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n"));
        socket.once("data", data => { resolve(data.toString()); socket.destroy(); });
        socket.on("error", reject);
      });
      assert.match(response, /^HTTP\/1\.[01] 403 /);
    }
    console.log("phase:" + phase + ":checked");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
'''
        (fixture / "boundary.cjs").write_text(payload)
        (fixture / "openclaw.mjs").write_text('import "./boundary.cjs";\n')
        (fixture / "probe.json").write_text(json.dumps({"canary": str(canary), "parent": os.getpid(), "unrelated": unrelated, "host": host_address}))
        (fixture / "package.json").write_text(json.dumps({"name": "native-isolation-hostile-fixture", "version": "1.0.0", "private": True,
            "scripts": {"postinstall": "node boundary.cjs install", "build:runtime": "node boundary.cjs build"}}))
        (fixture / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n")
        git_env = {"PATH": os.environ["PATH"], "HOME": str(root), "GIT_AUTHOR_NAME": "Synthetic Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid", "GIT_COMMITTER_NAME": "Synthetic Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}
        for command in (["init", "--quiet"], ["add", "."], ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic isolation fixture"]):
            subprocess.run(["git", *command], cwd=fixture, env=git_env, check=True)
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=fixture, text=True).strip()
        env = {**os.environ, "ISOLATION_SECRET_CANARY": "must-not-cross"}
        result = subprocess.run([sys.executable, str(helper), "build", "--source-dir", str(fixture), "--target-sha", sha,
            "--root", str(boundary), "--node", node, "--npm-dir", str(npm), "--pnpm-version", version],
            env=env, text=True, capture_output=True, timeout=1900)
        if result.returncode:
            raise RuntimeError("production boundary build failed:\n" + result.stdout[-16000:] + result.stderr[-8000:])
        for phase in ("install", "build"):
            assert "phase:" + phase + ":checked" in result.stdout, result.stdout[-16000:]
        assert canary.read_text() == "trusted Q evidence"
        config_path = protected / "config.json"
        config_path.write_text(json.dumps({"gateway": {"port": gateway_port}, "models": {"providers": {"fixture": {"baseUrl": f"http://127.0.0.1:{provider}/v1"}}}}))
        for expected in (1, 2):
            result = subprocess.run([sys.executable, str(helper), "run", "--root", str(boundary), "--config", str(config_path), "--", "probe"],
                env=env, text=True, capture_output=True, timeout=45)
            if result.returncode:
                raise RuntimeError("production boundary runtime failed:\n" + result.stdout[-8000:] + result.stderr[-8000:])
            assert "candidate-runtime-diagnostic" in result.stderr, result.stderr
            facts = json.loads(result.stdout.strip().splitlines()[-1])
            assert facts["count"] == expected and facts["provider"] == "ok", facts
            assert facts["protected"] == facts["unrelated"] == "denied", facts
            assert canary.read_text() == "trusted Q evidence"
        # Exercise actual published ingress, not only container-side reachability.
        # A LAN-bound Gateway would lose device-less backend scopes after Docker DNAT.
        if sys.platform == "linux":
            serving = subprocess.Popen([sys.executable, str(helper), "run", "--root", str(boundary),
                "--config", str(config_path), "--", "serve"], env=env, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 30
                while True:
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{gateway_port}", timeout=2) as response:
                            assert response.read() == b"loopback-preserved"
                        break
                    except OSError:
                        if serving.poll() is not None or time.monotonic() >= deadline:
                            raise RuntimeError("published ingress did not preserve loopback")
                        time.sleep(0.1)
                serving.communicate(timeout=30)
                assert serving.returncode == 0
            finally:
                if serving.poll() is None:
                    serving.terminate()
                    serving.communicate(timeout=30)
        cleanup = subprocess.run([sys.executable, str(helper), "cleanup", "--root", str(boundary)], text=True, capture_output=True, timeout=60)
        if cleanup.returncode:
            raise RuntimeError("production boundary cleanup failed: " + cleanup.stderr[-8000:])
        assert not boundary.exists()
        cleanup_ok = True
        print(json.dumps({"status": "passed", "kind": "native-production-isolation", "platform": sys.platform,
            "install": "protected", "build": "protected", "runtime": facts, "cleanup": "confirmed"}))
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        if not cleanup_ok and boundary.exists():
            cleanup = subprocess.run([sys.executable, str(helper), "cleanup", "--root", str(boundary)], timeout=60)
            cleanup_ok = cleanup.returncode == 0
        if cleanup_ok:
            shutil.rmtree(root)


if __name__ == "__main__":
    main()
