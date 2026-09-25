"""Real Tauri settings/vault/lifecycle proof against synthetic HTTP and CLI fixtures."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time

from desktop_sharing_cli import PRIMARY_TOKEN, SECONDARY_PASSWORD, still_exists
from gateway_switch import GatewaySwitchFixture
from inline_browser import FixtureHandler


DASHBOARD = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Desktop sharing native proof</title><style>
body{margin:0;background:#111720;color:#edf3fa;font:18px system-ui,sans-serif}
main{margin:48px;max-width:850px}h1{font-size:30px}p{line-height:1.6;color:#bdccdc}
button{font:inherit;padding:12px;margin:8px;border:1px solid #658098;
border-radius:8px;background:#253b50;color:white}#state{color:#82e5b4}
</style></head><body><main><h1>Desktop sharing · __NAME__</h1>
<p>Synthetic Gateway and CLI. Real native settings bridge, credential vault and process ownership.</p>
<p id="enabled">Sharing enabled: unknown</p><p id="state">Sharing state: starting</p>
<button id="enable">Enable desktop sharing</button><button id="disable">Disable desktop sharing</button>
<button id="unrelated">Check unrelated controls</button><p id="checks"></p><p id="failure"></p>
<button id="retain-authority">Retain dashboard authority</button><button id="stale-write">Check stale sharing write</button>
</main><script>
const instance=crypto.randomUUID();let unsupported=null;let trustedClicks=0;
let retainedAuthority=false;let staleWriteRejected=null;
let reportTail=Promise.resolve();
const snapshot=()=>window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__;
const post=message=>window.webkit.messageHandlers.openclawDeviceSettings.postMessage(message);
async function report(error=null){
  const body=JSON.stringify({instance,path:location.pathname,snapshot:snapshot(),unsupported,trustedClicks,retainedAuthority,staleWriteRejected,error});
  // The threaded fixture server must observe native snapshots in their original order.
  const request=reportTail.then(()=>fetch('/fixture/desktop-report',{
    method:'POST',headers:{'Content-Type':'application/json'},body}));
  reportTail=request.catch(()=>{});
  await request;
}
function render(){
  const current=snapshot();if(!current)return;
  document.getElementById('enabled').textContent='Sharing enabled: '+String(current.capabilities?.desktopSharingEnabled??'unknown');
  document.getElementById('state').textContent='Sharing state: '+current.desktopSharing.state;
  void report();
}
async function action(event,run){
  try{if(!event.isTrusted)throw Error('Expected real native pointer input');trustedClicks++;
    await run();render();}catch(error){document.getElementById('failure').textContent='Native proof failed';await report(String(error));}
}
for(const [id,value] of [['enable',true],['disable',false]]){
  document.getElementById(id).onclick=event=>action(event,()=>post({type:'set',key:'capabilities.desktopSharingEnabled',value}));
}
document.getElementById('unrelated').onclick=event=>action(event,async()=>{
  unsupported=[];
  for(const key of ['capabilities.computerControlEnabled','capabilities.unattendedDesktopEnabled']){
    try{await post({type:'set',key,value:true});unsupported.push({key,rejected:false});}
    catch{unsupported.push({key,rejected:true});}
  }
  document.getElementById('checks').textContent='Unrelated controls rejected: '+unsupported.every(item=>item.rejected);
});
document.getElementById('retain-authority').onclick=event=>action(event,async()=>{
  const response=await fetch('/fixture/retained-document',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({token:window.__OPENCLAW_NATIVE_BROWSER_TOKEN__})});
  if(!response.ok)throw Error('Could not retain the synthetic dashboard authority');
  retainedAuthority=true;
});
document.getElementById('stale-write').onclick=event=>action(event,async()=>{
  const response=await fetch('/fixture/retained-document');
  if(!response.ok)throw Error('The prior synthetic dashboard authority is unavailable');
  const {token}=await response.json();
  if(token===window.__OPENCLAW_NATIVE_BROWSER_TOKEN__)throw Error('Expected a replaced dashboard document');
  staleWriteRejected=false;
  try{
    await window.__TAURI_INTERNALS__.invoke('native_device_settings_request',{
      token,message:{type:'set',key:'capabilities.desktopSharingEnabled',value:true}});
  }catch(error){
    if(String(error)!=='This desktop settings document is no longer current.')throw Error('Expected a stale dashboard authority rejection');
    staleWriteRejected=true;
  }
  if(!staleWriteRejected)throw Error('A superseded dashboard changed desktop sharing');
  await post({type:'status'});
});
window.addEventListener('openclaw:native-device-settings-changed',render);
(async()=>{try{await post({type:'status'});render();}catch(error){await report(String(error));}})();
</script></body></html>"""


class DesktopHandler(FixtureHandler):
    def do_GET(self):
        if self.headers.get("Upgrade"):
            self.server.websocket_paths.append(self.path)
            self.reply(501)
        elif self.path in ("/fixture/", "/secondary/"):
            name = "Primary Gateway" if self.path == "/fixture/" else "Replacement Gateway"
            self.reply(200, DASHBOARD.replace("__NAME__", name).encode(), "text/html; charset=utf-8")
        elif self.path == "/fixture/retained-document":
            with self.server.report_lock:
                token = self.server.retained_document_token
            if token:
                self.reply(200, json.dumps({"token": token}).encode(), "application/json")
            else:
                self.reply(404)
        else:
            self.reply(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if self.path not in ("/fixture/desktop-report", "/fixture/retained-document") or not 0 < length < 16384:
            self.reply(400)
            return
        body = self.rfile.read(length).decode()
        if self.path == "/fixture/retained-document":
            token = json.loads(body).get("token")
            if not isinstance(token, str) or not 0 < len(token) <= 256:
                self.reply(400)
                return
            # Authority is retained only in private fixture memory, never proof reports.
            with self.server.report_lock:
                self.server.retained_document_token = token
            self.reply(200, b"{}", "application/json")
            return
        secrets = (*self.server.fixture_credentials, self.server.retained_document_token)
        if any(secret and secret in body for secret in secrets):
            self.server.failure = "A native snapshot disclosed a fixture credential"
            self.reply(400)
            return
        payload = json.loads(body)
        with self.server.report_lock:
            self.server.reports[payload["instance"]] = payload
            self.server.latest = payload
        self.reply(200, b"{}", "application/json")


class DesktopSharingFixture(GatewaySwitchFixture):
    def __init__(self, artifacts_dir):
        super().__init__(artifacts_dir)
        self.RequestHandlerClass = DesktopHandler
        self.report_lock = threading.Lock()
        self.latest = None
        self.retained_document_token = None
        self.fixture_credentials = (PRIMARY_TOKEN, SECONDARY_PASSWORD,
                                    "synthetic-stale-token", "synthetic-stale-password",
                                    "synthetic-stale-edge-id", "synthetic-stale-edge-secret")
        self.canonical = Path.home() / ".openclaw/canonical-desktop.json"
        self.included = self.canonical.parent / "desktop-host.json"
        self.events_file = Path.home() / "desktop-cli-events.jsonl"
        self.binary_sha256 = None

    def start(self):
        super().start()
        config = Path.home() / ".openclaw/openclaw.json"
        value = json.loads(config.read_text())
        value["gateway"]["remote"]["token"] = PRIMARY_TOKEN
        config.write_text(json.dumps(value))
        self.canonical.write_text(json.dumps({
            "desktop": {"host": {"$include": self.included.name}},
            "plugins": {"entries": {"cua-computer": {"enabled": False}}},
        }))
        self.included.write_text(json.dumps({"enabled": False}))
        self.canonical_hash = hashlib.sha256(self.canonical.read_bytes()).hexdigest()
        cli = config.parent / "bin/openclaw"
        shutil.copyfile(Path(__file__).with_name("desktop_sharing_cli.py"), cli)
        cli.chmod(0o700)
        # The child must replace inherited auth with the currently selected mode.
        os.environ["OPENCLAW_GATEWAY_TOKEN"] = "synthetic-stale-token"
        os.environ["OPENCLAW_GATEWAY_PASSWORD"] = "synthetic-stale-password"
        os.environ["CF_ACCESS_CLIENT_ID"] = "synthetic-stale-edge-id"
        os.environ["CF_ACCESS_CLIENT_SECRET"] = "synthetic-stale-edge-secret"

    def report(self):
        with self.report_lock:
            current = self.latest
        if self.failure:
            raise RuntimeError(self.failure)
        if current and current.get("error"):
            raise RuntimeError("The trusted native settings bridge rejected the fixture action")
        return current

    def events(self):
        if not self.events_file.exists():
            return []
        lines = self.events_file.read_text().splitlines()
        if len(lines) > 512:
            raise RuntimeError("Desktop fixture exceeded its event bound")
        result = [json.loads(line) for line in lines]
        if any(item["event"] == "fixture-failure" for item in result):
            raise RuntimeError("Synthetic desktop CLI rejected its native launch/lifecycle contract")
        return result

    def starts(self):
        return [item for item in self.events() if item["event"] == "node-start"]

    def wait_snapshot(self, enabled, state, *, previous_instance=None, gateway_path=None):
        def ready():
            current = self.report()
            if not current or current["instance"] == previous_instance:
                return False
            snapshot = current.get("snapshot", {})
            sharing = snapshot.get("desktopSharing", {})
            if snapshot.get("capabilities", {}).get("desktopSharingEnabled") is not enabled or sharing.get("state") != state:
                return False
            if gateway_path is not None and current["path"] != gateway_path:
                return False
            if snapshot["device"]["platform"] != "linux" or snapshot["device"]["formFactor"] != "desktop":
                raise RuntimeError("Native device snapshot reports the wrong platform")
            if state == "off" and "detail" in sharing:
                raise RuntimeError("Off status must omit unavailable detail, not encode null")
            if snapshot.get("permissions") != {"entries": []} or snapshot.get("voice", {}).get("supported") is not False:
                raise RuntimeError("Native device snapshot advertised unsupported platform features")
            if any(key in snapshot["capabilities"] for key in ("computerControlEnabled", "unattendedDesktopEnabled")):
                raise RuntimeError("Desktop sharing altered unrelated native capabilities")
            return current
        return self.chrome.until(ready, f"native desktop snapshot {enabled}/{state}")

    def wait_run(self, count, gateway_path):
        run = self.chrome.until(lambda: self.starts()[count - 1] if len(self.starts()) == count else None,
                                "the real fixture CLI and descendant")
        if not all(still_exists(run[member]) for member in ("leader", "descendant")):
            raise RuntimeError("The fixture child/descendant was absent before teardown proof")
        if run["priorAlive"] or run["args"][:2] != ["node", "run"] or run["endpoint"] != {
            "host": "127.0.0.1", "port": self.server_port, "path": gateway_path,
        } or run["configPath"] != str(self.canonical) or not run["selectedAuthMatches"]:
            raise RuntimeError("Native desktop launch lost scoped config, selected auth, or joined ordering")
        return run

    def wait_stopped(self, run):
        self.chrome.until(lambda: not any(still_exists(run[member]) for member in ("leader", "descendant")),
                          "native shutdown to reap the CLI and its observed descendant")
        stopped = [item for item in self.events() if item["event"] == "node-stop" and item["pid"] == run["leader"]["pid"]]
        if len(stopped) != 1 or not stopped[0]["descendantGone"]:
            raise RuntimeError("The native-owned CLI did not join its descendant")

    def capture(self, name):
        if self.artifacts_dir:
            time.sleep(1)
            self.chrome.command("import", "-window", "root", str(self.artifacts_dir / f"desktop-sharing-{name}.png"))

    def exercise(self, app, binary, wait, Atspi, restart):
        self.binary_sha256 = hashlib.sha256(binary.read_bytes()).hexdigest()

        def click(label, role=("button", "push button", "toggle button")):
            node = wait(label, role)
            component = node.get_component_iface()
            component.scroll_to(Atspi.ScrollType.ANYWHERE)
            bounds = component.get_extents(Atspi.CoordType.SCREEN)
            self.chrome.command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                                str(bounds.y + bounds.height // 2), "click", "1")

        def fill(label, value):
            node = wait(label, ("entry", "text", "password text"), predicate=lambda node:
                        node.get_state_set().contains(Atspi.StateType.EDITABLE))
            component = node.get_component_iface()
            component.scroll_to(Atspi.ScrollType.ANYWHERE)
            bounds = component.get_extents(Atspi.CoordType.SCREEN)
            self.chrome.command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                                str(bounds.y + bounds.height // 2), "click", "1")
            self.chrome.command("xdotool", "key", "ctrl+a")
            try:
                self.chrome.command("xdotool", "type", "--clearmodifiers", "--delay", "10", value)
            except subprocess.SubprocessError:
                raise RuntimeError("Could not enter synthetic connection settings") from None

        def quit_app(run=None):
            self.open_native_menu(app, "Quit OpenClaw")
            app.wait(timeout=10)
            if app.returncode != 0:
                raise RuntimeError("The native Quit action did not finish cleanly")
            if run is not None:
                self.wait_stopped(run)

        wait("Desktop sharing · Primary Gateway", "heading")
        initial = self.wait_snapshot(False, "off")
        if self.starts():
            raise RuntimeError("An explicit resolved-config opt-out started a desktop CLI")
        self.chrome.record("CLI-resolved false remains off without a child", True)
        self.capture("before-config-off")
        self.included.write_text("{}")
        quit_app()
        app = restart("openclaw://dashboard")
        default = self.wait_snapshot(True, "running", previous_instance=initial["instance"])
        first = self.wait_run(1, "/fixture/")
        self.chrome.record("unset resolved config defaults on after native restart", True)
        self.capture("after-default-on")
        click("Disable desktop sharing")
        self.wait_snapshot(False, "off")
        self.wait_stopped(first)
        self.chrome.record("native disable joins the observed CLI and descendant", True)
        self.capture("after-disabled")
        quit_app()
        app = restart("openclaw://dashboard")
        self.wait_snapshot(False, "off", previous_instance=default["instance"])
        if len(self.starts()) != 1:
            raise RuntimeError("The persisted native opt-out started another desktop CLI")
        self.chrome.record("private vault preserves desktop opt-out across native restart", True)
        click("Check unrelated controls")
        self.chrome.until(lambda: self.report().get("unsupported") and all(item["rejected"] for item in self.report()["unsupported"]),
                          "unrelated Computer Control/Keep Awake requests to be rejected")
        click("Enable desktop sharing")
        self.wait_snapshot(True, "running")
        second = self.wait_run(2, "/fixture/")
        click("Retain dashboard authority")
        self.chrome.until(lambda: self.report().get("retainedAuthority") is True,
                          "the current dashboard authority to be retained privately")
        self.open_native_menu(app, "Connection Settings")
        wait("Connection Settings", "heading")
        fill("Gateway URL", f"ws://127.0.0.1:{self.server_port}/secondary/")
        click("Authentication", "combo box")
        self.chrome.command("xdotool", "key", "End", "Return")
        fill("Gateway password", SECONDARY_PASSWORD)
        click("Connect to Gateway")
        wait("Desktop sharing · Replacement Gateway", "heading")
        replacement = self.wait_snapshot(True, "running", gateway_path="/secondary/")
        third = self.wait_run(3, "/secondary/")
        self.wait_stopped(second)
        if third["stateDir"] == second["stateDir"]:
            raise RuntimeError("A Primary Gateway change reused the prior node identity scope")
        self.chrome.record("Primary change joins old descendants and passes only selected password auth", True)
        self.included.write_text(json.dumps({"enabled": False}))
        quit_app(third)
        app = restart("openclaw://dashboard")
        self.wait_snapshot(True, "running", previous_instance=replacement["instance"], gateway_path="/secondary/")
        fourth = self.wait_run(4, "/secondary/")
        if fourth["stateDir"] != third["stateDir"]:
            raise RuntimeError("Restart changed the selected node's persistent identity scope")
        if hashlib.sha256(self.canonical.read_bytes()).hexdigest() != self.canonical_hash:
            raise RuntimeError("Native desktop settings rewrote canonical CLI or Computer Control config")
        self.chrome.record("native enable persists over resolved false and preserves canonical config", True)
        self.capture("after-restart-enabled")

        config_failure = Path.home() / "desktop-cli-config-failure"
        config_failure.touch()
        click("Enable desktop sharing")
        self.wait_snapshot(True, "error")
        self.wait_stopped(fourth)
        if len(self.starts()) != 4:
            raise RuntimeError("Failed preparation started another desktop CLI")
        click("Disable desktop sharing")
        self.wait_snapshot(False, "off")
        self.chrome.record("saved sharing choice stays editable after a CLI config failure", True)
        self.capture("after-preparation-failure-disabled")
        config_failure.unlink()
        click("Check stale sharing write")
        self.chrome.until(lambda: self.report().get("staleWriteRejected") is True,
                          "the registered native settings handler to reject the old dashboard")
        stale_rejected = self.wait_snapshot(False, "off")
        if len(self.starts()) != 4:
            raise RuntimeError("The stale dashboard request launched another desktop CLI")
        self.included.write_text("{}")
        quit_app()
        app = restart("openclaw://dashboard")
        self.wait_snapshot(False, "off", previous_instance=stale_rejected["instance"], gateway_path="/secondary/")
        if len(self.starts()) != 4:
            raise RuntimeError("The stale dashboard request changed the persisted opt-out")
        self.chrome.record("stale dashboard IPC preserves the saved opt-out without launching a child", True)
        self.included.write_text(json.dumps({"enabled": False}))
        click("Enable desktop sharing")
        self.wait_snapshot(True, "running")
        fifth = self.wait_run(5, "/secondary/")
        quit_app(fifth)
        self.chrome.record("native Quit joins the CLI and descendant before exiting", True)
        self.passed = True
        print("PASS: real Tauri settings/vault/teardown with synthetic Gateway and desktop-only CLI", flush=True)

    def close(self):
        failure = sys.exc_info()[1]
        leaked = []
        try:
            super().close()
        finally:
            # Cleanup owns only groups whose recorded process birth still matches.
            if self.events_file.exists():
                for item in map(json.loads, self.events_file.read_text().splitlines()):
                    if item["event"] == "node-start" and any(still_exists(item[member]) for member in ("leader", "descendant")):
                        leaked.append(item)
                        try:
                            os.killpg(item["leader"]["group"], signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        self.passed = False
            log = Path("app.log")
            if log.exists():
                contents = log.read_text(errors="replace")
                for secret in (*self.fixture_credentials, self.retained_document_token):
                    if secret:
                        contents = contents.replace(secret, "[redacted]")
                log.write_text(contents)
            if self.artifacts_dir:
                (self.artifacts_dir / "gateway-switch-results.json").unlink(missing_ok=True)
                with self.report_lock:
                    snapshots = list(self.reports.values())
                (self.artifacts_dir / "desktop-sharing-results.json").write_text(json.dumps({
                    "passed": self.passed, "binarySha256": self.binary_sha256,
                    "checks": self.chrome.checks, "dashboardReports": snapshots,
                    "cliEvents": list(map(json.loads, self.events_file.read_text().splitlines())) if self.events_file.exists() else [],
                    "syntheticCli": True, "syntheticGateway": True,
                    "emergencyCleanupRequired": bool(leaked),
                    "boundary": "Real Tauri WebKit bridge, OS vault, process launch, selected-auth handoff, and joined teardown; not real Gateway pairing or RFB",
                }, indent=2) + "\n")
            if leaked:
                message = "Native desktop teardown required emergency fixture process cleanup"
                if failure is not None:
                    message = f"{failure}; {message}"
                raise RuntimeError(message) from failure
