"""Synthetic Gateway and real WebKit child-view proof for first_run.py.

The existing driver owns the private HOME, environment, app, deadline and AT-SPI
session. This fixture owns only its loopback HTTP server and synthetic config.
"""

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import struct
import subprocess
import threading
import time
import uuid


DASHBOARD = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>OpenClaw inline browser fixture</title>
<style>body{margin:24px;background:#f3f5fa;color:#18253d;font:18px sans-serif}
h1{font-size:26px}p{max-width:850px}</style></head><body>
<h1 id="status">Running native inline browser regression</h1>
<p>Synthetic loopback Gateway. Real native WebKit child views.</p>
<button id="dashboard-pointer" style="position:absolute;right:24px;top:85px"
aria-label="Dashboard pointer control">Dashboard pointer control</button>
<script>
(async () => {
  const phase = __PHASE__;
  const sessionKey = __SESSION__;
  const refusedUrl = __REFUSED_URL__;
  const tabId = sessionKey + '-tab';
  const scope = sessionKey + '-scope';
  const url = page => location.origin + '/browser/' + page;
  const state = () => window.__OPENCLAW_NATIVE_BROWSER__;
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(read, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await read()) return;
      await sleep(100);
    }
    throw Error('Timed out: ' + label);
  }
  async function report(step, extra = {}) {
    const response = await fetch('/fixture/report', {method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({phase, step, ...extra})});
    assert(response.ok, 'Fixture rejected report: ' + step);
  }
  async function post(message) {
    const reply = await window.webkit.messageHandlers.openclawBrowser.postMessage(message);
    assert(reply && reply.ok === true, message.type + ': ' + (reply?.error ?? 'invalid reply'));
    return reply;
  }
  async function loaded(page) {
    await until(() => state().tabs.some(tab => tab.id === tabId && tab.url === url(page)
      && tab.title === 'Synthetic browser ' + page && !tab.loading), 'native page ' + page);
  }
  async function present() {
    await post({type:'present', scope, tabId, visible:true,
      rect:{x:20,y:150,width:Math.min(620,innerWidth-40),height:360}});
  }
  async function inspect() {
    const result = await post({type:'inspect', tabId, x:60, y:55});
    assert(result.node?.id === 'inspect-target' && result.node.tag.toLowerCase() === 'button'
      && result.node.name === 'Synthetic inspect target' && result.node.focusable, 'Native inspect metadata');
  }
  async function snapshot(name) {
    const result = await post({type:'snapshot', tabId});
    assert(result.cssWidth > 0 && result.cssHeight > 0, 'Snapshot CSS size');
    await report(name, {dataUrl:result.dataUrl});
  }
  document.getElementById('dashboard-pointer').addEventListener('click', event => {
    if (event.isTrusted) report('dashboard-pointer-click');
  });
  try {
    await until(() => typeof window.webkit?.messageHandlers?.openclawBrowser?.postMessage === 'function'
      && state(), 'native dashboard bridge ready');
    if (phase === 1) {
      assert(state().tabs.length === 0, 'Isolated app starts with no browser tabs');
      const opened = await post({type:'open',tabId,url:url('one'),sessionKey});
      assert(opened.tabId === tabId, 'Open returned native tab');
      await loaded('one');
      const duplicate = await post({type:'open',tabId:tabId+'-duplicate',url:url('one'),sessionKey});
      assert(duplicate.tabId === tabId && state().tabs.length === 1, 'Same-session URL dedupe');
      await present();
      await until(async () => {
        const telemetry = await (await fetch('/fixture/telemetry')).json();
        return telemetry.one?.width === Math.min(620,innerWidth-40) && telemetry.one?.height === 360;
      }, 'actual native child viewport');
      await report('click-ready');
      await until(async () => (await (await fetch('/fixture/telemetry')).json()).one?.clicked === true,
        'native child received pointer click');
      await report('native-pointer-click');
      await inspect();
      await snapshot('initial-snapshot');
      const original = url('failed-initial');
      const failed = await post({type:'open',tabId:tabId+'-failed',url:original,sessionKey});
      await until(() => state().tabs.some(tab => tab.id === failed.tabId
        && tab.url === refusedUrl && !tab.loading), 'failed initial redirect completed');
      const failedRequests = (await (await fetch('/fixture/telemetry')).json()).loads['failed-initial'];
      const recovery = await fetch('/fixture/recover-initial', {method:'POST',
        headers:{'Content-Type':'application/json'},body:'{}'});
      assert(recovery.ok, 'Fixture initial route recovered');
      const recovered = await post({type:'open',tabId:tabId+'-recovered',url:original,sessionKey});
      assert(recovered.tabId !== failed.tabId, 'Failed initial alias must not reuse its stale tab');
      await until(async () => (await (await fetch('/fixture/telemetry')).json()).loads['failed-initial'] > failedRequests,
        'reopening failed original starts a new request');
      await until(() => state().tabs.some(tab => tab.id === recovered.tabId
        && tab.url === url('recovered-initial') && tab.title === 'Synthetic browser recovered-initial'
        && !tab.loading), 'recovered initial redirect rendered');
      const alias = await post({type:'open',tabId:tabId+'-alias',url:original,sessionKey});
      assert(alias.tabId === recovered.tabId, 'Only successful redirect retains initial alias');
      await post({type:'close',tabId:failed.tabId});
      await post({type:'close',tabId:recovered.tabId});
      await report('failed-initial-redirect-recovered');
      const credentialUrl = new URL(url('credential-url'));
      credentialUrl.username = 'inline-fixture'; credentialUrl.password = 'synthetic-password';
      const credentialTab = await post({type:'open',tabId:tabId+'-credential',url:credentialUrl.href,sessionKey});
      await until(() => state().tabs.some(tab => tab.id === credentialTab.tabId
        && tab.title === 'Synthetic browser credential-url' && !tab.loading), 'credential URL rendered');
      await post({type:'close',tabId:credentialTab.tabId});
      await until(() => state().tabs.length === 1, 'extra regression tabs cleaned up');
      await report('credential-url-accepted');
      await post({type:'navigate',tabId,url:url('two')});
      await loaded('two');
      await until(() => state().tabs.find(tab => tab.id === tabId).canGoBack, 'native back availability');
      await post({type:'back',tabId}); await loaded('one');
      await until(() => state().tabs.find(tab => tab.id === tabId).canGoForward, 'native forward availability');
      await post({type:'forward',tabId}); await loaded('two');
      const before = (await (await fetch('/fixture/telemetry')).json()).loads.two;
      await post({type:'reload',tabId});
      await until(async () => (await (await fetch('/fixture/telemetry')).json()).loads.two > before,
        'native reload requested child document');
      await loaded('two');
      await report('navigation-history-reload');
      location.reload();
    } else if (phase === 2) {
      assert(state().tabs.length === 1 && state().tabs[0].id === tabId
        && state().tabs[0].sessionKey === sessionKey && state().tabs[0].url === url('two'),
        'Dashboard reload retained browser tab and conversation');
      await present();
      await snapshot('dashboard-reload-snapshot');
      document.getElementById('status').textContent = 'Ready for dashboard replacement';
      await report('replacement-ready');
    } else if (phase === 3) {
      assert(state().tabs.length === 0, 'Native dashboard replacement cleared previous Gateway tabs');
      await report('replacement-cleared-tabs');
      const opened = await post({type:'open',tabId,url:url('reopened'),sessionKey});
      assert(opened.tabId === tabId, 'Reopen after native replacement');
      await loaded('reopened');
      await present();
      await inspect();
      await snapshot('replacement-reopened-snapshot');
      await report('download-save-ready');
      const saved = await post({type:'download',tabId});
      assert(saved.cancelled === false, 'Native save completed');
      await report('download-saved');
      await report('download-cancel-ready');
      const cancelled = await post({type:'download',tabId});
      assert(cancelled.cancelled === true, 'Native save cancellation');
      await report('download-cancelled');
      await post({type:'release-scope',scope});
      assert(state().tabs.some(tab => tab.id === tabId), 'Release scope retained tab');
      await post({type:'close',tabId});
      await until(() => state().tabs.length === 0, 'Final native tab closed');
      document.getElementById('status').textContent = 'PASS: native inline browser and dashboard replacement';
      await report('complete');
    } else {
      throw Error('Unexpected dashboard load count');
    }
  } catch (error) {
    document.getElementById('status').textContent = 'FAIL: native inline browser regression';
    await report('failure', {error:String(error.message ?? error), readiness:{
      handler:typeof window.webkit?.messageHandlers?.openclawBrowser?.postMessage === 'function',
      state:!!state(), tauri:typeof window.__TAURI_INTERNALS__?.invoke === 'function',
      token:!!window.__OPENCLAW_NATIVE_BROWSER_TOKEN__}});
  }
})();
</script></body></html>"""


CHILD = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Synthetic browser __PAGE__</title>
<style>body{margin:0;background:#e8eefc;color:#12223a;font:18px sans-serif}
button{position:absolute;left:32px;top:32px;width:210px;height:64px;background:#2663eb;
color:white;border:0;border-radius:8px;font-size:18px}h1{position:absolute;left:32px;right:32px;top:125px}</style>
</head><body><button id="inspect-target" aria-label="Synthetic inspect target">Click fixture</button>
<h1>Synthetic browser __PAGE__</h1><script>
let clicked = false;
function report() {
  fetch('/fixture/child', {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({page:__PAGE_JSON__,width:innerWidth,height:innerHeight,clicked})});
}
document.getElementById('inspect-target').addEventListener('click', event => {
  clicked = event.isTrusted;
  event.currentTarget.textContent = clicked ? 'Native click received' : 'Untrusted click';
  report();
});
window.addEventListener('resize', report);
report();
</script></body></html>"""


class GatewayFixture(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, artifacts_dir):
        super().__init__(("127.0.0.1", 0), FixtureHandler)
        self.session = "linux-inline-" + uuid.uuid4().hex
        self.artifacts_dir = artifacts_dir
        self.phase = 0
        # Reserve and close an unused loopback port for a real connection refusal.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.refused_url = f"http://127.0.0.1:{listener.getsockname()[1]}/failed-target"
        self.recover_initial = False
        self.steps = []
        self.telemetry = {"loads": {}}
        self.failure = None
        self.passed = False
        self.download_bytes_match = False
        self.signals = {name: threading.Event() for name in (
            "click-ready", "dashboard-pointer-click", "replacement-ready", "complete", "failure",
            "download-save-ready", "download-saved", "download-cancel-ready", "download-cancelled",
        )}
        self.server_thread = threading.Thread(target=self.serve_forever, daemon=True)

    def start(self):
        config = Path.home() / ".openclaw/openclaw.json"
        config.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if config.exists():
            raise RuntimeError("Inline fixture requires the driver's empty private HOME")
        config.write_text(json.dumps({"gateway": {"mode": "remote", "remote": {
            "transport": "direct", "url": f"ws://127.0.0.1:{self.server_port}/fixture/",
        }}}))
        config.chmod(0o600)
        # Open Dashboard selects the local Gateway. Its read-only fixture CLI
        # returns this server through the real CLI integration after remote use.
        cli = config.parent / "bin/openclaw"
        cli.parent.mkdir(mode=0o700)
        dashboard_url = f"http://127.0.0.1:{self.server_port}/fixture/"
        cli.write_text(
            "#!/usr/bin/python3\n"
            "import json, sys\n"
            "command = ' '.join(sys.argv[1:])\n"
            "if command == '--version':\n"
            "    print('OpenClaw inline fixture')\n"
            "elif command == 'gateway status --json':\n"
            "    print(json.dumps({'service': {'loaded': True, 'runtime': {'status': 'running'}}, 'rpc': {'ok': True}}))\n"
            "elif command == 'dashboard --json --no-open':\n"
            f"    print(json.dumps({{'ok': True, 'url': {dashboard_url!r}, 'browserUrl': {dashboard_url!r}, 'wsUrl': {'ws' + dashboard_url[4:]!r}}}))\n"
            "else:\n"
            "    raise RuntimeError('Unexpected fixture CLI command: ' + command)\n"
        )
        cli.chmod(0o700)
        self.server_thread.start()

    def wait_for(self, name, app):
        deadline = time.monotonic() + 45
        while not self.signals[name].wait(0.1):
            if self.failure:
                raise RuntimeError(f"Native inline fixture: {self.failure}")
            if app.poll() is not None:
                raise RuntimeError("Native app exited during inline browser proof")
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Native inline fixture timed out waiting for {name}")

    def exercise(self, app, binary, wait, Atspi):
        self.wait_for("click-ready", app)

        def pointer_click(label):
            # WebKit 2.52 exposes "button"; older supported WebKit uses "push button".
            button = wait(label, ("button", "push button"))
            component = button.get_component_iface()
            rect = component.get_extents(Atspi.CoordType.SCREEN)
            if rect.width <= 0 or rect.height <= 0:
                raise RuntimeError("Native fixture button has no screen bounds")
            print(f"Pointer click {label}: screen {rect.x},{rect.y} {rect.width}x{rect.height}", flush=True)
            # Use XTest through xdotool: AT-SPI on Ubuntu 26 can report successful
            # pointer synthesis without moving Xvfb's pointer. AT-SPI still owns
            # target discovery; the fixture requires a trusted native click.
            x, y = rect.x + rect.width // 2, rect.y + rect.height // 2
            subprocess.run(
                ["/usr/bin/xdotool", "mousemove", "--sync", str(x), str(y), "click", "1"],
                check=True, timeout=5,
            )

        pointer_click("Dashboard pointer control")
        self.wait_for("dashboard-pointer-click", app)
        pointer_click("Synthetic inspect target")
        self.wait_for("replacement-ready", app)
        wait("Ready for dashboard replacement", "heading")
        # Existing single-instance/deep-link handling selects the local fixture
        # through tray::open_dashboard and replaces main in the same app process.
        subprocess.run(
            [str(binary), "openclaw://dashboard"], check=True, timeout=15,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.wait_for("download-save-ready", app)

        def filename_entry(node):
            if not node.get_state_set().contains(Atspi.StateType.SHOWING):
                return False
            return any(
                relation.get_relation_type() == Atspi.RelationType.LABELLED_BY
                and any(relation.get_target(index).get_name().rstrip(":") == "Name"
                        for index in range(relation.get_n_targets()))
                for relation in node.get_relation_set()
            )

        # GTK exposes its filename text field through LABELLED_BY rather than an
        # accessible name. Select that relation, not an arbitrary empty text box.
        name_entry = wait("", ("entry", "text"), prefix=True, predicate=filename_entry)
        if self.artifacts_dir:
            subprocess.run(
                ["/usr/bin/import", "-window", "root", str(self.artifacts_dir / "inline-browser-save-chooser.png")],
                check=True, timeout=10,
            )
        destination = Path.home() / "inline-browser-download.html"
        editable = name_entry.get_editable_text_iface()
        if editable is None or not editable.set_text_contents(str(destination)):
            raise RuntimeError("Could not fill the native Save filename")
        pointer_click("Save")
        self.wait_for("download-saved", app)
        expected = CHILD.replace("__PAGE__", "reopened").replace("__PAGE_JSON__", json.dumps("reopened")).encode()
        if destination.read_bytes() != expected:
            raise RuntimeError("Native download bytes differ from the synthetic fixture")
        self.download_bytes_match = True
        self.wait_for("download-cancel-ready", app)
        pointer_click("Cancel")
        self.wait_for("download-cancelled", app)
        if destination.read_bytes() != expected or list(Path.home().glob(".openclaw-download-*")):
            raise RuntimeError("Cancelled native download changed the saved fixture or left staging files")
        self.wait_for("complete", app)
        wait("PASS: native inline browser and dashboard replacement", "heading")
        if self.phase != 3:
            raise RuntimeError("Expected initial dashboard, reload, and native replacement")
        self.passed = True
        print("PASS: native inline browser pointer input, history, snapshots, reload, replacement and save/cancel", flush=True)

    def close(self):
        self.shutdown()
        self.server_close()
        self.server_thread.join(timeout=5)
        if self.artifacts_dir:
            (self.artifacts_dir / "inline-browser-results.json").write_text(json.dumps({
                "passed": self.passed,
                "download_bytes_match": self.download_bytes_match,
                "dashboard_loads": self.phase, "steps": self.steps, "failure": self.failure,
            }, indent=2) + "\n")


class FixtureHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, _format, *_args):
        pass

    def reply(self, status, body=b"", content_type="text/plain"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.headers.get("Upgrade"):
            self.reply(501)
        elif self.path == "/fixture/":
            self.server.phase += 1
            page = DASHBOARD.replace("__PHASE__", str(self.server.phase)).replace(
                "__SESSION__", json.dumps(self.server.session),
            ).replace("__REFUSED_URL__", json.dumps(self.server.refused_url))
            self.reply(200, page.encode(), "text/html; charset=utf-8")
        elif self.path == "/browser/failed-initial":
            loads = self.server.telemetry["loads"]
            loads["failed-initial"] = loads.get("failed-initial", 0) + 1
            self.send_response(302)
            self.send_header("Location", "/browser/recovered-initial" if self.server.recover_initial else self.server.refused_url)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
        elif self.path in ("/browser/one", "/browser/two", "/browser/reopened", "/browser/recovered-initial", "/browser/credential-url"):
            name = self.path.rsplit("/", 1)[1]
            loads = self.server.telemetry["loads"]
            loads[name] = loads.get(name, 0) + 1
            page = CHILD.replace("__PAGE__", name).replace("__PAGE_JSON__", json.dumps(name))
            self.reply(200, page.encode(), "text/html; charset=utf-8")
        elif self.path == "/fixture/telemetry":
            self.reply(200, json.dumps(self.server.telemetry).encode(), "application/json")
        elif self.path == "/favicon.ico":
            self.reply(204)
        else:
            self.reply(404)

    def do_POST(self):
        if self.path not in ("/fixture/child", "/fixture/report", "/fixture/recover-initial"):
            self.reply(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 8 * 1024 * 1024:
            self.reply(400)
            return
        payload = json.loads(self.rfile.read(length))
        if self.path == "/fixture/recover-initial":
            self.server.recover_initial = True
        elif self.path == "/fixture/child":
            name = payload.get("page")
            if name not in ("one", "two", "reopened", "recovered-initial", "credential-url"):
                self.reply(400)
                return
            self.server.telemetry[name] = payload
        else:
            step = payload.get("step")
            if "dataUrl" in payload:
                try:
                    prefix = "data:image/png;base64,"
                    assert payload["dataUrl"].startswith(prefix)
                    png = base64.b64decode(payload["dataUrl"][len(prefix):], validate=True)
                    assert png[:8] == b"\x89PNG\r\n\x1a\n" and png[12:16] == b"IHDR"
                    width, height = struct.unpack(">II", png[16:24])
                    assert width > 0 and height > 0 and b"IEND" in png[-12:]
                    assert step in ("initial-snapshot", "dashboard-reload-snapshot", "replacement-reopened-snapshot")
                    if self.server.artifacts_dir:
                        (self.server.artifacts_dir / f"inline-browser-{step}.png").write_bytes(png)
                except (AssertionError, ValueError, struct.error):
                    self.server.failure = "Native snapshot was not a valid PNG"
                    self.server.signals["failure"].set()
                    self.reply(400)
                    return
            self.server.steps.append({"phase": payload.get("phase"), "step": step})
            if step == "failure":
                self.server.failure = str(payload.get("error", "Unknown fixture failure")) + " " + json.dumps(payload.get("readiness", {}))
            if step in self.server.signals:
                self.server.signals[step].set()
            print(f"Inline browser fixture: phase {payload.get('phase')} {step}", flush=True)
        self.reply(200, b"{}", "application/json")
