#!/usr/bin/env python3
"""Prove saved SecretRef reconnect and rotation in the real Linux native app.

Run an unbundled binary as a non-root user, with the WebKit sandbox enabled:
  xvfb-run -a -s '-screen 0 1280x1024x24' dbus-run-session -- \
    /usr/bin/python3 apps/linux/tests/remote_connection_smoke.py BINARY \
    --artifacts-dir ARTIFACTS --label after --source file --credential token

Repeat with --source env --credential password for the other credential owner.
Use exactly the same harness with --label before on the baseline binary; it
must exit nonzero with SECRET_REF_REPLACED, not a startup or fixture failure.
There is deliberately no expected-failure switch.

Runtime packages: python3-gi, gir1.2-atspi-2.0, at-spi2-core, libatk-adaptor,
xvfb, xauth, dbus-x11, imagemagick, fonts-dejavu-core, plus the app's GTK/WebKit
runtime dependencies. No CLI, Gateway installation, or Python dependencies
outside the existing first_run.py system packages are required.

The synthetic HTTP fixture consumes the native Control UI auth bootstrap,
not a mocked Tauri command or a browser injected by the harness. This proves
native saved reconnect, fresh credential resolution, and config preservation;
it does not claim a real Gateway WebSocket handshake or full Control UI proof.
Only fixed outcome facts and native screenshots leave the temporary HOME.
"""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time


ENV_CREDENTIAL = "OPENCLAW_SMOKE_REMOTE_CREDENTIAL"
FIXTURE_PATH = "/fixture/"
CHECK_LABELS = {
    "bootstrap_received": "Native auth bootstrap received",
    "credential_matches": "Current credential verified",
    "gateway_matches": "Saved Gateway destination retained",
    "url_has_no_credentials": "Dashboard URL has no credentials",
    "reference_retained": "Saved SecretRef retained",
    "resolved_bytes_absent": "No resolved credential bytes in config",
    "config_unchanged": "Saved configuration unchanged",
}

# The expected credential is never served. Only the native initialization
# script can supply it; verification returns booleans, never submitted values.
PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>OpenClaw - synthetic reconnect fixture</title>
<style>
body { margin: 0; background: #f6f7f8; color: #202326;
       font: 18px sans-serif; }
main { max-width: 900px; margin: 48px auto; padding: 0 32px; }
h1 { font-size: 30px; margin-bottom: 8px; }
h2 { font-size: 24px; overflow-wrap: anywhere; }
p { color: #53585c; line-height: 1.5; }
li { margin: 14px 0; }
.pass { color: #176b3e; } .fail { color: #ab2028; }
</style></head><body><main>
<h1>OpenClaw</h1>
<p>Synthetic Gateway fixture | Native WebKit | __FIXTURE_LABEL__</p>
<h2 id="outcome">Waiting for native saved reconnect</h2>
<ul id="checks"></ul>
<p>Auth-bootstrap boundary proof. No real Gateway or account is in use.</p>
</main><script>
(async () => {
  const heading = document.getElementById("outcome");
  try {
    const auth = window.__OPENCLAW_NATIVE_CONTROL_AUTH__;
    delete window.__OPENCLAW_NATIVE_CONTROL_AUTH__;
    const response = await fetch("/fixture/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: auth ?? null,
        cleanUrl: location.search === "" && location.hash === ""
      })
    });
    if (!response.ok) throw new Error();
    const result = await response.json();
    for (const [key, label] of Object.entries(__CHECK_LABELS__)) {
      const item = document.createElement("li");
      item.textContent = (result.checks[key] ? "PASS: " : "FAIL: ") + label;
      item.className = result.checks[key] ? "pass" : "fail";
      document.getElementById("checks").appendChild(item);
    }
    heading.textContent = result.heading;
    heading.className = result.passed ? "pass" : "fail";
  } catch {
    heading.textContent = "FAIL: fixture verification unavailable";
    heading.className = "fail";
  }
})();
</script></body></html>
"""


class SmokeFailure(RuntimeError):
    """Only credential-free, fixed diagnostic messages belong in this error."""


def saved_config(source, credential, gateway_url):
    provider = {"source": source}
    if source == "file":
        provider.update(path="~/.openclaw/reconnect-secret", mode="singleValue")
        reference_id = "value"
    else:
        provider["allowlist"] = [ENV_CREDENTIAL]
        reference_id = ENV_CREDENTIAL
    return {
        "secrets": {"providers": {"fixture": provider}},
        "gateway": {
            "mode": "remote",
            "remote": {
                "transport": "direct",
                "url": gateway_url,
                credential: {
                    "source": source,
                    "provider": "fixture",
                    "id": reference_id,
                },
            },
        },
    }


def config_checks(config_path, original, credential, values):
    raw = config_path.read_text()
    current = json.loads(raw)
    expected_remote = original["gateway"]["remote"]
    remote = current.get("gateway", {}).get("remote", {})
    return {
        "reference_retained": remote.get(credential) == expected_remote[credential],
        "resolved_bytes_absent": all(value not in raw for value in values),
        "config_unchanged": current == original,
    }


def verify_reconnect(config_path, original, credential, values, payload, phase):
    auth = payload.get("auth")
    received = isinstance(auth, dict)
    auth = auth if received else {}
    other = "password" if credential == "token" else "token"
    checks = {
        "bootstrap_received": received,
        "credential_matches": (
            auth.get(credential) == values[-1] and auth.get(other) is None
        ),
        "gateway_matches": auth.get("gatewayUrl") == original["gateway"]["remote"]["url"],
        "url_has_no_credentials": payload.get("cleanUrl") is True,
        **config_checks(config_path, original, credential, values),
    }
    code = "PASS"
    if not all(checks.values()):
        if not all(checks[key] for key in (
            "bootstrap_received", "credential_matches", "gateway_matches",
            "url_has_no_credentials",
        )):
            code = "NATIVE_AUTH_MISMATCH"
        elif not checks["reference_retained"]:
            code = "SECRET_REF_REPLACED"
        elif not checks["resolved_bytes_absent"]:
            code = "RESOLVED_BYTES_PERSISTED"
        else:
            code = "SAVED_CONFIG_CHANGED"
    passed = code == "PASS"
    return {
        "phase": phase,
        "passed": passed,
        "code": code,
        "heading": f"PASS: {phase} reconnect" if passed else f"FAIL: {code}",
        "checks": checks,
    }


class GatewayFixture(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), FixtureHandler)
        self.gateway_url = f"ws://127.0.0.1:{self.server_port}{FIXTURE_PATH}"
        self.completed = threading.Event()
        self.result = None

    def prepare(self, config_path, original, credential, values, phase, label):
        self.config_path = config_path
        self.original = original
        self.credential = credential
        self.values = values[:]
        self.phase = phase
        self.page = PAGE.replace("__FIXTURE_LABEL__", label).replace(
            "__CHECK_LABELS__", json.dumps(CHECK_LABELS)
        ).encode()
        self.result = None
        self.completed.clear()

    def handle_error(self, _request, _client_address):
        # A background WS disconnect must not overwrite the browser proof.
        # Suppress request tracebacks; failed verification still hits the deadline.
        pass


class FixtureHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, _format, *_args):
        pass

    def reply(self, code, body=b"", content_type="text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.headers.get("Upgrade"):
            # The native background WS client is outside this focused proof.
            self.reply(501)
        elif self.path == FIXTURE_PATH:
            self.reply(200, self.server.page, "text/html; charset=utf-8")
        elif self.path == "/favicon.ico":
            self.reply(204)
        else:
            self.reply(404)

    def do_POST(self):
        if self.path != "/fixture/verify":
            self.reply(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 8192 or self.server.completed.is_set():
            self.reply(400)
            return
        payload = json.loads(self.rfile.read(length))
        result = verify_reconnect(
            self.server.config_path, self.server.original, self.server.credential,
            self.server.values, payload, self.server.phase,
        )
        self.server.result = result
        self.reply(200, json.dumps(result).encode(), "application/json")
        self.server.completed.set()


def wait_heading(app, label, Atspi, GLib):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if app.poll() is not None:
            raise SmokeFailure("Native app exited before fixture proof was visible")
        try:
            desktop = Atspi.get_desktop(0)
            for index in range(desktop.get_child_count()):
                owner = desktop.get_child_at_index(index)
                if owner is None or owner.get_process_id() != app.pid:
                    continue
                pending = [owner]
                visited = 0
                while pending:
                    node = pending.pop()
                    if node is None:
                        continue
                    visited += 1
                    if visited > 500:
                        raise SmokeFailure("Native accessibility tree exceeded 500 nodes")
                    # Match semantic controls, not unstable WebKit numeric roles.
                    if (
                        node.get_localized_role_name() == "heading"
                        and node.get_name() == label
                        and node.get_state_set().contains(Atspi.StateType.VISIBLE)
                    ):
                        return
                    pending.extend(
                        node.get_child_at_index(child)
                        for child in range(node.get_child_count())
                    )
        except GLib.Error:
            # WebKit replaces the initial setup view during saved reconnect.
            pass
        time.sleep(0.1)
    raise SmokeFailure("Timed out waiting for credential-free native fixture heading")


def capture(screenshot):
    started = time.monotonic()
    while True:
        subprocess.run(
            ["/usr/bin/import", "-window", "root", str(screenshot)],
            check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        colors = int(subprocess.check_output(
            ["/usr/bin/identify", "-format", "%k", str(screenshot)],
            text=True, timeout=10, stderr=subprocess.DEVNULL,
        ))
        elapsed = time.monotonic() - started
        # AT-SPI may observe the new view before WebKit paints it.
        if elapsed >= 1 and colors > 2:
            return
        if elapsed >= 5:
            raise SmokeFailure("Native fixture window remained blank during capture")
        time.sleep(0.1)


def stop_app(app):
    if app.poll() is None:
        app.terminate()
    try:
        app.wait(timeout=5)
    except subprocess.TimeoutExpired:
        app.kill()
        app.wait(timeout=5)


def drive(binary, source, credential, label, artifacts):
    try:
        import gi

        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, GLib
    except (ImportError, ValueError) as error:
        raise SmokeFailure("Install python3-gi and gir1.2-atspi-2.0") from error
    Atspi.set_timeout(1000, 1000)
    desktop = Atspi.get_desktop(0)
    if desktop is None or desktop.get_child_count():
        raise SmokeFailure("AT-SPI needs an empty private accessibility session")

    fixture = GatewayFixture()
    server = threading.Thread(target=fixture.serve_forever, daemon=True)
    server.start()
    config_path = Path.home() / ".openclaw/openclaw.json"
    config_path.parent.mkdir(mode=0o700)
    original = saved_config(source, credential, fixture.gateway_url)
    config_path.write_text(json.dumps(original))
    config_path.chmod(0o600)
    values = []
    stem = f"{label}-{source}-{credential}"
    with binary.open("rb") as stream:
        binary_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    report = {
        "label": label, "source": source, "credential": credential,
        "binary_sha256": binary_hash,
        "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "boundary": "native-control-auth-bootstrap",
        "real_gateway_websocket": False,
        "passed": False,
        "phases": [],
    }
    try:
        for phase in ("initial", "rotated"):
            # Keep HOME, config and WebKit data across launches. Only the
            # provider value changes, so a persisted literal fails rotation.
            values.append(secrets.token_urlsafe(32))
            env = os.environ.copy()
            if source == "file":
                secret_path = config_path.parent / "reconnect-secret"
                secret_path.write_text(values[-1] + "\n")
                secret_path.chmod(0o600)
            else:
                env[ENV_CREDENTIAL] = values[-1]
            fixture.prepare(
                config_path, original, credential, values, phase,
                f"{label.upper()} | {source.upper()} {credential.upper()} | {phase.upper()}",
            )
            app = subprocess.Popen(
                [str(binary)], env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 30
                while not fixture.completed.wait(0.1):
                    if app.poll() is not None:
                        raise SmokeFailure("Native app exited before auth bootstrap")
                    if time.monotonic() >= deadline:
                        raise SmokeFailure("Native auth bootstrap did not reach HTTP fixture")
                result = fixture.result
                if "heading" not in result:
                    raise SmokeFailure(result["code"])
                wait_heading(app, result["heading"], Atspi, GLib)
                screenshot = f"{stem}-{phase}-{'passed' if result['passed'] else 'failed'}.png"
                capture(artifacts / screenshot)
                report["phases"].append({**result, "screenshot": screenshot})
                print(json.dumps(result), flush=True)
                if not result["passed"]:
                    raise SmokeFailure(result["code"])
            finally:
                stop_app(app)
            # Also catch a write during native shutdown, before rotating.
            final = config_checks(
                config_path, original, credential, values,
            )
            report["phases"][-1]["config_after_shutdown"] = final
            if not all(final.values()):
                raise SmokeFailure("Saved config changed during native shutdown")
        report["passed"] = True
        print("PASS: native saved reconnect retains SecretRef and follows rotation", flush=True)
    except SmokeFailure as error:
        report["failure"] = str(error)
        raise
    finally:
        (artifacts / f"{stem}.json").write_text(json.dumps(report, indent=2) + "\n")
        fixture.shutdown()
        fixture.server_close()
        server.join(timeout=5)
        Atspi.exit()


def interrupted(signum, _frame):
    raise SmokeFailure(f"Native reconnect smoke interrupted by signal {signum}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--source", choices=("file", "env"), default="file")
    parser.add_argument("--credential", choices=("token", "password"), default="token")
    parser.add_argument("--label", choices=("before", "after"), default="after")
    parser.add_argument("--artifacts-dir", type=Path, required=True)
    parser.add_argument("--driver", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() == 0:
        parser.error("Run on Linux as a non-root user; keep the WebKit sandbox enabled")
    if not all(os.environ.get(key) for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS")):
        parser.error("Run inside xvfb-run and a private dbus-run-session")
    binary = args.binary.resolve(strict=True)
    if not os.access(binary, os.X_OK):
        parser.error("The native app binary must be executable")
    if shutil.which("openclaw", path="/usr/bin:/bin"):
        parser.error("The minimal system PATH must not contain an OpenClaw CLI")
    if not all(os.access(f"/usr/bin/{tool}", os.X_OK) for tool in ("import", "identify")):
        parser.error("Screenshot capture requires ImageMagick's import and identify")
    artifacts = args.artifacts_dir.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    if args.driver:
        drive(binary, args.source, args.credential, args.label, artifacts)
        return

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    with tempfile.TemporaryDirectory(prefix="openclaw-reconnect-") as directory:
        root = Path(directory)
        # Match first_run.py: inherit only private display/bus handles, not
        # operator credentials, CLI overrides or WebKit sandbox bypass flags.
        env = {
            key: os.environ[key]
            for key in ("DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY")
            if key in os.environ
        }
        env.update(
            HOME=str(root), PATH="/usr/bin:/bin", LANG="C.UTF-8", LC_ALL="C.UTF-8",
            GDK_BACKEND="x11", XDG_SESSION_TYPE="x11", GTK_MODULES="atk-bridge",
            NO_AT_BRIDGE="0",
        )
        for variable, relative in (
            ("XDG_CONFIG_HOME", ".config"),
            ("XDG_CACHE_HOME", ".cache"),
            ("XDG_DATA_HOME", ".local/share"),
            ("XDG_STATE_HOME", ".local/state"),
            ("XDG_RUNTIME_DIR", "runtime"),
            ("TMPDIR", "tmp"),
        ):
            path = root / relative
            path.mkdir(mode=0o700, parents=True)
            env[variable] = str(path)
        command = [
            sys.executable, str(Path(__file__).resolve()), str(binary), "--driver",
            "--source", args.source, "--credential", args.credential,
            "--label", args.label, "--artifacts-dir", str(artifacts),
        ]
        # Keep the deadline outside GI: a blocked AT-SPI call cannot delay
        # cleanup of this worker and its native children in their owned group.
        worker = subprocess.Popen(
            command, cwd=root, env=env, stdin=subprocess.DEVNULL, start_new_session=True,
        )
        try:
            try:
                code = worker.wait(timeout=150)
            except subprocess.TimeoutExpired as error:
                raise SmokeFailure("Native reconnect driver exceeded 150 seconds") from error
            if code:
                raise SmokeFailure(f"Native reconnect driver exited with {code}")
        finally:
            try:
                os.killpg(worker.pid, signal.SIGTERM)
                worker.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
            finally:
                try:
                    os.killpg(worker.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                worker.wait(timeout=5)


if __name__ == "__main__":
    try:
        main()
    except SmokeFailure as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Never export native logs, raw HTTP payloads, config, or private paths.
        print(f"FAIL: reconnect harness infrastructure error ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
