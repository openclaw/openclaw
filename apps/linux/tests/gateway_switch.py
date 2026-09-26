"""Native Gateway selection with real WebKit, menus and an isolated Secret Service.

first_run.py owns the private HOME and DBus session. The synthetic dashboard
consumes the same native Gateway contract as the shared Control UI.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from urllib.parse import parse_qs, urlsplit

from inline_browser import FixtureHandler, GatewayFixture
from window_chrome import WindowChromeFixture


DASHBOARD = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>__NAME__ · Gateway switch proof</title>
<style>
body{margin:0;background:#101319;color:#f4f5f7;font:16px system-ui,sans-serif}
header{height:52px;box-sizing:border-box;padding:14px 24px;background:#191e27}
main{padding:38px;max-width:850px}h1{font-size:30px;margin-bottom:12px}
p{color:#aab4c6;line-height:1.6}button{font:inherit;padding:10px 15px;margin:6px 8px 6px 0;
border-radius:8px;border:1px solid #3b465a;background:#242e3e;color:#f4f5f7}
#selection{color:#6ee7b7}#marker{display:block;color:#aab4c6;margin-top:20px}
</style><script>
window.dispatchEvent(new Event('openclaw:native-window-chrome-available'));
</script></head><body><header id="header">OPENCLAW · SYNTHETIC GATEWAY PROOF</header>
<main><h1>__NAME__</h1><p>Local fixture data. This dashboard exercises the real desktop
Gateway selection adapter and native windows.</p><p id="selection">Waiting for native Gateway selection…</p>
<div id="controls"></div><p id="marker">Independent dashboard state: 0</p>
<button id="advance">Advance dashboard state</button></main><script>
const instance = crypto.randomUUID();
// The Control UI keeps its device identity in origin storage. A saved Gateway
// dashboard must retain it across app restarts to stay paired.
const device = (() => {
  try {
    const stored = localStorage.getItem('openclaw-fixture-device');
    if (stored) return stored;
    localStorage.setItem('openclaw-fixture-device', instance);
    return instance;
  } catch { return null; }
})();
const page = __PAGE__;
let clicks = 0;
const send = message => window.webkit.messageHandlers.openclawGateways.postMessage(message);
const report = () => fetch('/fixture/report', {method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({page,instance,device,clicks,path:location.pathname,current:window.__OPENCLAW_NATIVE_GATEWAYS__?.currentId,
    tokenMatches:page==='secondary' ? window.__OPENCLAW_NATIVE_CONTROL_AUTH__?.token==='synthetic-gateway-token' : true})});
function render() {
  const state = window.__OPENCLAW_NATIVE_GATEWAYS__;
  if (!state) return;
  document.getElementById('selection').textContent = 'Selected: ' +
    (state.gateways.find(g => g.id === state.currentId)?.name ?? state.currentId);
  const controls = document.getElementById('controls');
  controls.replaceChildren();
  for (const gateway of state.gateways) {
    const button = document.createElement('button');
    button.textContent = 'Select ' + gateway.name;
    button.onclick = () => send({type:'select',id:gateway.id});
    controls.append(button);
  }
  void report();
}
document.getElementById('advance').onclick = () => {
  document.getElementById('marker').textContent = 'Independent dashboard state: ' + (++clicks);
  void report();
};
document.getElementById('header').onmousedown = () =>
  window.webkit.messageHandlers.openclawWindowDrag?.postMessage({type:'window-drag'});
window.addEventListener('openclaw:native-gateways-changed', render);
render();
</script></body></html>"""


class SwitchHandler(FixtureHandler):
    def do_GET(self):
        if self.headers.get("Upgrade"):
            self.server.websocket_paths.append(self.path)
            self.reply(501)
        elif self.path in ("/fixture/", "/secondary/"):
            page = "primary" if self.path == "/fixture/" else "secondary"
            self.server.loads[page] += 1
            body = DASHBOARD.replace("__NAME__", "Primary Gateway" if page == "primary" else "Studio Gateway")
            self.reply(200, body.replace("__PAGE__", json.dumps(page)).encode(), "text/html; charset=utf-8")
        else:
            self.reply(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if self.path != "/fixture/report" or not 0 < length < 4096:
            self.reply(400)
            return
        payload = json.loads(self.rfile.read(length))
        self.server.reports[payload["instance"]] = payload
        self.reply(200, b"{}", "application/json")


def stop_private_vault(vault):
    if vault is not None and vault.poll() is None:
        vault.terminate()
        vault.wait(timeout=5)


def start_private_vault(chrome):
    from gi.repository import Gio, GLib

    vault = subprocess.Popen(
        ["gnome-keyring-daemon", "--foreground", "--unlock", "--components=secrets"],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        vault.stdin.write(b"synthetic-private-vault\n")
        vault.stdin.close()
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        chrome.until(lambda: bus.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "NameHasOwner", GLib.Variant("(s)", ("org.freedesktop.secrets",)), None,
            Gio.DBusCallFlags.NONE, 1000, None,
        ).unpack()[0], "the isolated credential vault")
    except BaseException:
        stop_private_vault(vault)
        raise
    return vault


class GatewaySwitchFixture(GatewayFixture):
    def __init__(self, artifacts_dir):
        super().__init__(artifacts_dir)
        self.RequestHandlerClass = SwitchHandler
        self.chrome = WindowChromeFixture(None)
        self.vault = None
        self.restarted_app = None
        self.loads = {"primary": 0, "secondary": 0}
        self.reports = {}
        self.websocket_paths = []
        self.config_hash = None

    def start(self):
        self.chrome.start()
        self.vault = start_private_vault(self.chrome)
        super().start()
        self.config_hash = self.primary_hash()

    @staticmethod
    def primary_hash():
        return hashlib.sha256((Path.home() / ".openclaw/openclaw.json").read_bytes()).hexdigest()

    def windows(self, app):
        return {
            parts[0]: parts[4]
            for line in self.chrome.command("wmctrl", "-lp").splitlines()
            if len(parts := line.split(None, 4)) == 5 and parts[2] == str(app.pid)
        }

    def capture(self, name):
        if self.artifacts_dir:
            time.sleep(1)
            self.chrome.command("import", "-window", "root", str(self.artifacts_dir / f"gateway-switch-{name}.png"))

    def exercise(self, app, _binary, wait, Atspi, restart):
        def in_active_window(node):
            while node is not None and node.get_localized_role_name() != "application":
                if node.get_state_set().contains(Atspi.StateType.ACTIVE):
                    return True
                node = node.get_parent()
            return False

        def click(label, role=("button", "push button", "toggle button")):
            node = wait(label, role, predicate=in_active_window)
            component = node.get_component_iface()
            component.scroll_to(Atspi.ScrollType.ANYWHERE)
            bounds = component.get_extents(Atspi.CoordType.SCREEN)
            self.chrome.command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                                str(bounds.y + bounds.height // 2), "click", "1")

        def focus_input(label):
            node = wait(label, ("entry", "text", "password text"), predicate=lambda node:
                        node.get_state_set().contains(Atspi.StateType.EDITABLE) and in_active_window(node))
            component = node.get_component_iface()
            component.scroll_to(Atspi.ScrollType.ANYWHERE)
            bounds = component.get_extents(Atspi.CoordType.SCREEN)
            self.chrome.command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                                str(bounds.y + bounds.height // 2), "click", "1")

        def fill(label, value):
            focus_input(label)
            self.chrome.command("xdotool", "key", "ctrl+a")
            self.chrome.command("xdotool", "type", "--clearmodifiers", "--delay", "10", value)

        def select_auth(method):
            click("Authentication", "combo box")
            self.chrome.command("xdotool", "key", {"token": "Home", "password": "End"}[method], "Return")

        def select(name, window):
            self.chrome.command("wmctrl", "-ia", window)
            click("Select " + name)
            wait("Selected: " + name)

        def record(name, result=True):
            self.chrome.record(name, result)
            if self.primary_hash() != self.config_hash:
                raise RuntimeError(f"{name} changed the Primary Gateway config")

        wait("Primary Gateway", "heading")
        main = self.chrome.until(lambda: next(iter(self.windows(app)), None), "main window")
        self.chrome.command("wmctrl", "-ir", main, "-e", "0,35,45,1050,720")
        time.sleep(0.3)
        initial = self.chrome.geometry(main)
        self.capture("before-primary")
        wait("Selected: Primary Gateway")
        self.open_native_menu(app, "Manage Gateways…")
        wait("Manage Gateways", "heading")
        wait("Your Gateways, in one place", "heading")
        click("Add Gateway")
        wait("Add Gateway", "heading")
        fill("Name", "Studio Gateway")
        fill("Gateway URL", f"http://127.0.0.1:{self.server_port}/secondary/")
        select_auth("token")
        fill("Gateway token (optional)", "synthetic-gateway-token")
        click("Save Gateway")
        wait("Saved Studio Gateway.")
        wait("Manage Gateways", "heading")
        self.capture("after-saved")
        record("saved profile through local editor and system credential vault")

        for name in ("Studio Gateway", "Primary Gateway", "Studio Gateway"):
            select(name, main)
            if main not in self.windows(app) or self.chrome.geometry(main) != initial:
                raise RuntimeError("Gateway selection replaced or resized the main native shell")
        record("same shell A to B to A to B", {"window": main, "geometry": initial})
        self.capture("after-selected")
        self.chrome.until(lambda: any(r["page"] == "secondary" and r["tokenMatches"] for r in self.reports.values()),
                          "saved token delivered only to the target dashboard")
        record("saved token delivered to secondary dashboard")
        self.open_native_menu(app, "Quick Chat")
        quickchat = self.chrome.until(
            lambda: next((window for window, title in self.windows(app).items() if title == "Quick Chat"), None),
            "the native Quick Chat window",
        )
        self.chrome.command("wmctrl", "-ia", quickchat)
        self.chrome.until(lambda: int(self.chrome.command("xprop", "-root", "_NET_ACTIVE_WINDOW").split()[-1], 16)
                          == int(quickchat, 16), "native Quick Chat focus")
        quick_input = wait("Quick Chat message", ("entry", "text"), predicate=in_active_window)
        bounds = quick_input.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        self.chrome.command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                            str(bounds.y + bounds.height // 2), "click", "1")
        self.chrome.until(lambda: "/fixture/" in self.websocket_paths, "Primary native chat RPC demand")
        self.chrome.command("xdotool", "key", "Escape")
        self.chrome.until(lambda: len(self.windows(app)) == 2, "Quick Chat to hide")
        self.chrome.command("wmctrl", "-ia", main)
        record("Quick Chat RPC stays on Primary while Studio is selected")
        click("Advance dashboard state")
        wait("Independent dashboard state: 1")
        previous_loads = dict(self.loads)
        select("Studio Gateway", main)
        wait("Independent dashboard state: 1")
        if self.loads != previous_loads:
            raise RuntimeError("Selecting the current Gateway reset its dashboard")
        record("reselect preserves current dashboard state")

        for action in ("Back", "Connect to Gateway"):
            self.open_native_menu(app, "Connection Settings")
            wait("Connection Settings", "heading")
            entry = wait("Gateway URL", ("entry", "text"), predicate=lambda node:
                         node.get_state_set().contains(Atspi.StateType.EDITABLE) and in_active_window(node))
            if Atspi.Text.get_text(entry.get_text_iface(), 0, -1) != f"ws://127.0.0.1:{self.server_port}/fixture/":
                raise RuntimeError("Connection Settings did not describe Primary while Studio was selected")
            self.capture("primary-settings-" + ("cancel" if action == "Back" else "save"))
            config_path = Path.home() / ".openclaw/openclaw.json"
            before_settings = json.loads(config_path.read_text())
            click(action)
            wait("Studio Gateway", "heading")
            wait("Selected: Studio Gateway")
            if json.loads(config_path.read_text()) != before_settings:
                raise RuntimeError("Saving the same Primary connection changed its settings")
            if action == "Connect to Gateway":
                # Explicit Save may normalize JSON formatting; window selection
                # before and after this operation must still preserve its bytes.
                self.config_hash = self.primary_hash()
            if main not in self.windows(app) or self.chrome.geometry(main) != initial:
                raise RuntimeError("Primary Connection Settings replaced or resized the saved Gateway shell")
            record("Primary Connection Settings " + ("cancel" if action == "Back" else "save") + " returns to Studio")

        studio = [report for report in self.reports.values() if report["page"] == "secondary"]
        if not studio or not studio[-1]["device"]:
            raise RuntimeError("Saved Gateway dashboard could not use origin storage")
        before_restart = set(self.reports)
        app = restart("openclaw://dashboard")
        wait("Studio Gateway", "heading")
        wait("Selected: Studio Gateway")
        main = self.chrome.until(lambda: next(iter(self.windows(app)), None), "restored main window")
        self.capture("after-restart")
        record("first-launch dashboard deep link restores saved selection from system credential vault")
        restored = self.chrome.until(lambda: next((report for key, report in self.reports.items()
                                                   if key not in before_restart and report["page"] == "secondary"), None),
                                     "restored Studio dashboard report")
        if restored["device"] != studio[-1]["device"]:
            raise RuntimeError("Restarting the app discarded the saved Gateway dashboard's origin storage")
        record("saved Gateway dashboard keeps its origin storage across restart")

        cli = Path.home() / ".openclaw/bin/openclaw"
        disabled_cli = cli.with_name("openclaw-disabled")
        primary_config = Path.home() / ".openclaw/openclaw.json"
        saved_config = primary_config.read_bytes()
        cli.rename(disabled_cli)
        primary_config.write_text(json.dumps({"gateway": {"mode": "local"}}))
        unavailable_hash = self.primary_hash()
        try:
            app = restart()
            wait("Studio Gateway", "heading")
            wait("Selected: Studio Gateway")
            if self.primary_hash() != unavailable_hash:
                raise RuntimeError("Saved Gateway restoration modified the unavailable Primary config")
            self.chrome.record("saved Gateway restores without a configured Primary or installed CLI", True)
            self.capture("without-primary")
        finally:
            primary_config.write_bytes(saved_config)
            disabled_cli.rename(cli)
        app = restart()
        wait("Studio Gateway", "heading")
        wait("Selected: Studio Gateway")
        main = self.chrome.until(lambda: next(iter(self.windows(app)), None), "main after restoring fixture CLI")

        self.open_native_menu(app, "Manage Gateways…")
        wait("Manage Gateways", "heading")
        settings = next(window for window in self.windows(app) if window != main)
        click("Edit Studio Gateway")
        wait("Edit Gateway", "heading")
        click("Connection type", "combo box")
        self.chrome.command("xdotool", "key", "End", "Return")
        fill("SSH target", f"fixture@127.0.0.1:{urlsplit(self.refused_url).port}")
        recovery_geometry = self.chrome.geometry(main)
        click("Save Gateway")
        wait("Saved Studio Gateway.")
        self.chrome.close_window(settings)
        self.chrome.command("wmctrl", "-ia", main)
        wait("Edit Gateway", "heading")
        wait("SSH connection failed:", prefix=True)
        self.capture("failed-edit-recovery")
        click("Connection type", "combo box")
        self.chrome.command("xdotool", "key", "Home", "Return")
        fill("Gateway URL", f"http://127.0.0.1:{self.server_port}/secondary/")
        select_auth("token")
        fill("Gateway token (optional)", "synthetic-gateway-token")
        click("Save Gateway")
        wait("Studio Gateway", "heading")
        wait("Selected: Studio Gateway")
        if main not in self.windows(app) or self.chrome.geometry(main) != recovery_geometry:
            raise RuntimeError("Profile edit recovery replaced or resized the native shell")
        record("failed SSH profile edit recovers through local settings in the same shell")
        self.capture("after-edit-recovery")

        self.open_native_menu(app, "Manage Gateways…")
        wait("Manage Gateways", "heading")
        settings = next(window for window in self.windows(app) if window != main)
        click("Edit Studio Gateway")
        wait("Edit Gateway", "heading")
        fill("Gateway URL", self.refused_url)
        recovery_geometry = self.chrome.geometry(main)
        click("Save Gateway")
        wait("Saved Studio Gateway.")
        self.chrome.close_window(settings)
        self.chrome.command("wmctrl", "-ia", main)
        wait("Could not load this Gateway. Check its address and connection, then try again.")
        wait("Edit Gateway", "heading")
        self.capture("failed-direct-edit-recovery")
        fill("Gateway URL", f"http://127.0.0.1:{self.server_port}/secondary/")
        select_auth("token")
        fill("Gateway token (optional)", "synthetic-gateway-token")
        click("Save Gateway")
        wait("Studio Gateway", "heading")
        wait("Selected: Studio Gateway")
        if main not in self.windows(app) or self.chrome.geometry(main) != recovery_geometry:
            raise RuntimeError("Direct profile edit recovery replaced or resized the native shell")
        record("failed direct profile edit recovers through local settings in the same shell")
        self.capture("after-direct-edit-recovery")

        self.open_native_menu(app, "Manage Gateways…")
        wait("Manage Gateways", "heading")
        settings = next(window for window in self.windows(app) if window != main)
        click("Add Gateway")
        wait("Add Gateway", "heading")
        fill("Name", "Unavailable Gateway")
        fill("Gateway URL", self.refused_url)
        click("Save Gateway")
        wait("Saved Unavailable Gateway.")
        self.chrome.close_window(settings)
        self.chrome.command("wmctrl", "-ia", main)
        click("Select Unavailable Gateway")
        wait("Could not load this Gateway. Check its address and connection, then try again.")
        self.capture("failed-direct-selection")
        app = restart()
        wait("Studio Gateway", "heading")
        wait("Selected: Studio Gateway")
        main = self.chrome.until(lambda: next(iter(self.windows(app)), None), "main after refused selection")
        record("failed direct selection does not replace the remembered Studio Gateway")
        self.capture("after-refused-selection-restart")
        self.open_native_menu(app, "Manage Gateways…")
        wait("Manage Gateways", "heading")
        settings = next(window for window in self.windows(app) if window != main)
        click("Remove Unavailable Gateway")
        wait("Remove Gateway?", "heading")
        click("Remove Gateway")
        wait("1 saved Gateway")
        self.chrome.close_window(settings)
        self.chrome.until(lambda: len(self.windows(app)) == 1, "temporary refused profile manager to close")

        self.open_native_menu(app, "Open Studio Gateway in New Window")
        self.chrome.until(lambda: len(self.windows(app)) == 2, "a separate Gateway window")
        secondary = next(window for window in self.windows(app) if window != main)
        self.chrome.command("wmctrl", "-ia", secondary)
        click("Advance dashboard state")
        wait("Independent dashboard state: 1")
        previous_loads = dict(self.loads)
        self.chrome.command("wmctrl", "-ia", main)
        self.open_native_menu(app, "Studio Gateway")
        time.sleep(0.4)
        if len(self.windows(app)) != 2 or self.loads != previous_loads:
            raise RuntimeError("Focus Gateway created or navigated a native window")
        record("native focus reuses an existing window without navigation", {"windows": self.windows(app)})
        self.open_native_menu(app, "Open Studio Gateway in New Window")
        self.chrome.until(lambda: len(self.windows(app)) == 3, "an independent third native window")
        record("new window always creates independent Gateway shell", {"windows": self.windows(app)})
        self.capture("after-windows")

        self.open_native_menu(app, "Manage Gateways…")
        wait("Manage Gateways", "heading")
        click("Edit Studio Gateway")
        wait("Edit Gateway", "heading")
        for method in ("token", "password"):
            select_auth(method)
            # WebKitGTK exposes password placeholders as text; reveal to read the actual value.
            click("Show credential")
            entry = wait(f"Gateway {method} (optional)", ("entry", "text"), predicate=lambda node:
                         node.get_state_set().contains(Atspi.StateType.EDITABLE) and in_active_window(node))
            if Atspi.Text.get_text(entry.get_text_iface(), 0, -1):
                raise RuntimeError("The editor exposed a saved credential")
            click("Hide credential")
            wait(f"Gateway {method} (optional)", "password text", predicate=lambda node:
                 node.get_state_set().contains(Atspi.StateType.EDITABLE) and in_active_window(node))
        click("Back to Gateways")
        wait("Manage Gateways", "heading")
        record("saved credential is not disclosed by the editor")
        click("Remove Studio Gateway")
        wait("Remove Gateway?", "heading")
        click("Remove Gateway")
        wait("Your Gateways, in one place", "heading")
        self.chrome.until(lambda: len(self.windows(app)) == 2, "removed Gateway auxiliary windows to close")
        self.chrome.command("wmctrl", "-ia", main)
        wait("Primary Gateway", "heading")
        wait("Selected: Primary Gateway")
        record("remove closes auxiliary windows and restores Primary in main")
        self.capture("after-removal")
        if "/fixture/" not in self.websocket_paths:
            raise RuntimeError("The Primary Gateway RPC connection was not observed")
        if "/secondary/" in self.websocket_paths:
            raise RuntimeError("Window selection retargeted the Primary Gateway RPC client")
        record("Primary RPC client never connects to a secondary Gateway", {"paths": sorted(set(self.websocket_paths))})
        storage = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "ai.openclaw.linux/gateway-profiles"

        def stored():
            return {path for scope in storage.iterdir() for path in scope.iterdir()} if storage.is_dir() else set()

        removed = stored()
        if not removed:
            raise RuntimeError("Saved Gateway dashboards did not keep private storage")
        removed_device = studio[-1]["device"]
        before_readd = set(self.reports)
        self.open_native_menu(app, "Manage Gateways…")
        wait("Manage Gateways", "heading")
        click("Add Gateway")
        wait("Add Gateway", "heading")
        fill("Name", "Studio Gateway")
        fill("Gateway URL", f"http://127.0.0.1:{self.server_port}/secondary/")
        select_auth("token")
        fill("Gateway token (optional)", "synthetic-gateway-token")
        click("Save Gateway")
        wait("Saved Studio Gateway.")
        select("Studio Gateway", main)
        readded = self.chrome.until(lambda: next((report for key, report in self.reports.items()
                                                  if key not in before_readd and report["page"] == "secondary"), None),
                                    "re-added Studio dashboard report")
        if readded["device"] in (None, removed_device):
            raise RuntimeError("A removed Gateway saved again reused its previous dashboard storage")
        record("removed Gateway saved again starts with fresh dashboard storage")
        fresh = stored() - removed
        if len(fresh) != 1:
            raise RuntimeError(f"Expected one fresh storage directory, found {len(fresh)}")
        if any(path.stat().st_mode & 0o077 for path in [storage, *storage.iterdir(), *stored()]):
            raise RuntimeError("Saved Gateway dashboard storage is readable by other users")
        # WebKitGTK keeps a data directory in use until exit, so removal completes on the next launch.
        app = restart()
        wait("Studio Gateway", "heading")
        self.chrome.until(lambda: stored() == fresh, "removed Gateway dashboard storage to be deleted")
        record("next launch deletes removed Gateways' dashboard storage and keeps saved ones")
        self.passed = True
        print("PASS: native Gateway selection, credential persistence, focus/new windows and removal", flush=True)

    def close(self):
        if self.restarted_app is not None and self.restarted_app.poll() is None:
            self.restarted_app.terminate()
            self.restarted_app.wait(timeout=5)
        self.shutdown()
        self.server_close()
        self.server_thread.join(timeout=5)
        stop_private_vault(self.vault)
        self.chrome.close()
        if self.artifacts_dir:
            (self.artifacts_dir / "gateway-switch-results.json").write_text(json.dumps({
                "passed": self.passed, "checks": self.chrome.checks,
                "primaryConfigSha256": self.config_hash, "loads": self.loads,
                "dashboardReports": list(self.reports.values()),
            }, indent=2) + "\n")


ONBOARDING_CONTROLS = """<nav style="margin:0 38px">
<button id="chat">Open chat</button><button id="reload">Reload chat</button>
<button id="outside">Open sibling path</button><button id="manage">Manage Gateways</button>
</nav><script>
function showRoute() {
  document.querySelector('h1').textContent = location.pathname.includes('model-setup')
    ? 'Local model setup' : location.pathname.startsWith('/fixture/') ? 'Custodian chat' : 'Sibling path';
}
function navigate(path) { history.pushState({}, '', path); showRoute(); void report(); }
document.getElementById('chat').onclick = () => navigate('/fixture/chat/custodian');
document.getElementById('outside').onclick = () => navigate('/fixture-sibling/chat');
document.getElementById('reload').onclick = () => location.reload();
document.getElementById('manage').onclick = () => send({type:'open-settings'});
showRoute();
</script>"""


class OnboardingHandler(SwitchHandler):
    def do_GET(self):
        parsed = urlsplit(self.path)
        if not self.headers.get("Upgrade") and parsed.path in (
            "/fixture/", "/fixture/settings/model-setup", "/fixture/chat/custodian",
        ):
            self.server.document_requests.append({"path": parsed.path, "query": parse_qs(parsed.query)})
            self.server.loads["primary"] += 1
            body = DASHBOARD.replace("__NAME__", "Local model setup").replace("__PAGE__", '"primary"')
            body = body.replace("</body>", ONBOARDING_CONTROLS + "</body>")
            self.reply(200, body.encode(), "text/html; charset=utf-8")
        else:
            super().do_GET()


class GatewayOnboardingFixture(GatewaySwitchFixture):
    def __init__(self, artifacts_dir):
        super().__init__(artifacts_dir)
        self.RequestHandlerClass = OnboardingHandler
        self.document_requests = []
        self.binary_sha256 = None

    def start(self):
        super().start()
        # The app must enter its real missing-CLI installation flow.
        (Path.home() / ".openclaw/bin/openclaw").rename(Path.home() / "fixture-cli.py")
        (Path.home() / ".openclaw/openclaw.json").unlink()
        self.config_hash = None

    def stage_binary(self, binary):
        # Tauri's documented Cargo resource layout is target/<profile> with
        # .cargo-lock. Only the installer resource is synthetic; binary bytes match.
        directory = Path.home() / "target/debug"
        directory.mkdir(parents=True)
        (directory / ".cargo-lock").touch()
        staged = directory / binary.name
        shutil.copy2(binary, staged)
        self.binary_sha256 = hashlib.sha256(binary.read_bytes()).hexdigest()
        if hashlib.sha256(staged.read_bytes()).hexdigest() != self.binary_sha256:
            raise RuntimeError("Staging changed the native application binary")
        wrapper = (
            "#!/usr/bin/python3\nimport os, sys\nfrom pathlib import Path\n"
            "if sys.argv[1:] == ['doctor', '--fix', '--non-interactive']:\n"
            "    Path('fixture-doctor-called').touch()\n    print('{}')\n"
            "else:\n    os.execv('/usr/bin/python3', ['python3', str(Path.home() / 'fixture-cli.py'), *sys.argv[1:]])\n"
        )
        installer = directory / "install-cli.sh"
        installer.write_text(
            "#!/bin/bash\nset -euo pipefail\n/usr/bin/python3 - \"$@\" <<'PY'\n"
            "import json, sys\nfrom pathlib import Path\n"
            "prefix = Path.home() / '.openclaw'\n"
            "expected = ['--json', '--no-onboard', '--prefix', str(prefix), '--version', 'main', "
            "'--install-method', 'git', '--git-dir', str(prefix / 'dev/openclaw')]\n"
            "assert sys.argv[1:] == expected, 'Unexpected native installer arguments'\n"
            "cli = prefix / 'bin/openclaw'\n"
            f"cli.write_text({wrapper!r})\ncli.chmod(0o700)\n"
            "(prefix / 'openclaw.json').write_text(json.dumps({'gateway': {'mode': 'local'}}))\n"
            "Path('fixture-installer-called').touch()\n"
            "print(json.dumps({'event': 'install_complete'}))\nPY\n"
        )
        return staged

    def capture(self, name):
        if self.artifacts_dir:
            time.sleep(1)
            self.chrome.command("import", "-window", "root", str(self.artifacts_dir / f"gateway-onboarding-{name}.png"))

    def exercise(self, app, _binary, wait, Atspi, _restart):
        def click(label, *, prefix=False):
            node = wait(label, ("button", "push button", "toggle button"), prefix=prefix)
            component = node.get_component_iface()
            component.scroll_to(Atspi.ScrollType.ANYWHERE)
            bounds = component.get_extents(Atspi.CoordType.SCREEN)
            self.chrome.command("xdotool", "mousemove", str(bounds.x + bounds.width // 2),
                                str(bounds.y + bounds.height // 2), "click", "1")

        wait("Welcome to OpenClaw", "heading")
        click("Get started")
        wait("Where should your assistant live?", "heading")
        click("On this computer", prefix=True)
        click("Continue")
        wait("Choose a release channel", "heading")
        click("Install OpenClaw")
        wait("Local model setup", "heading")
        if not Path("fixture-installer-called").is_file() or not Path("fixture-doctor-called").is_file():
            raise RuntimeError("The native installation/Doctor entrypoint did not run")
        if not self.document_requests or self.document_requests[0] != {
            "path": "/fixture/settings/model-setup", "query": {"firstRun": ["explicit"]},
        }:
            raise RuntimeError(f"Native onboarding did not preserve the canonical base: {self.document_requests!r}")
        self.config_hash = self.primary_hash()
        main = self.chrome.until(lambda: next(iter(self.windows(app)), None), "onboarding window")
        self.capture("model-setup")
        click("Open chat")
        wait("Custodian chat", "heading")
        click("Maximize window")
        self.chrome.until(lambda: "_NET_WM_STATE_MAXIMIZED_HORZ" in self.chrome.state(main),
                          "native maximize after onboarding leaves model setup")
        click("Restore window")
        self.chrome.until(lambda: "_NET_WM_STATE_MAXIMIZED_HORZ" not in self.chrome.state(main), "native restore")
        self.chrome.record("window controls survive onboarding to chat under the canonical base", True)
        click("Manage Gateways")
        wait("Manage Gateways", "heading")
        manager = self.chrome.until(lambda: next((w for w in self.windows(app) if w != main), None), "Gateway manager")
        self.chrome.close_window(manager)
        self.chrome.record("Gateway bridge works after leaving model setup", True)
        self.capture("chat-controls")
        click("Reload chat")
        self.chrome.until(lambda: any(r["path"] == "/fixture/chat/custodian" for r in self.document_requests), "chat document reload")
        wait("Custodian chat", "heading")
        click("Manage Gateways")
        wait("Manage Gateways", "heading")
        manager = self.chrome.until(lambda: next((w for w in self.windows(app) if w != main), None), "manager after reload")
        self.chrome.close_window(manager)
        click("Open sibling path")
        wait("Sibling path", "heading")
        click("Manage Gateways")
        wait("Gateway action failed:", prefix=True)
        click("Maximize window")
        wait("Window action failed:", prefix=True)
        if len(self.windows(app)) != 1 or "_NET_WM_STATE_MAXIMIZED_HORZ" in self.chrome.state(main):
            raise RuntimeError("A sibling path controlled the native window or opened Gateway management")
        self.chrome.record("retained bridge commands are denied outside the canonical base", True)
        self.capture("sibling-denied")
        if self.primary_hash() != self.config_hash:
            raise RuntimeError("Dashboard navigation changed the installed Primary config")
        self.passed = True
        print("PASS: native local onboarding preserves base-path authority for chat and rejects siblings", flush=True)

    def close(self):
        super().close()
        if self.artifacts_dir:
            result = self.artifacts_dir / "gateway-switch-results.json"
            data = json.loads(result.read_text())
            data.update(binarySha256=self.binary_sha256, documentRequests=self.document_requests, syntheticInstaller=True)
            result.unlink()
            (self.artifacts_dir / "gateway-onboarding-results.json").write_text(json.dumps(data, indent=2) + "\n")
