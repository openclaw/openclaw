"""Real Quick Chat controls against a bounded synthetic Gateway WebSocket."""

import base64
import hashlib
import json
import socket
import struct
import threading
import time

from gateway_switch import start_private_vault, stop_private_vault
from inline_browser import FixtureHandler, GatewayFixture
from window_chrome import WindowChromeFixture


FIRST_REPLY = "I found three changes worth highlighting."
CONTINUED_REPLY = FIRST_REPLY + " The release also improves startup and recovery."
NEXT_DRAFT = "Keep this next draft."
WIDGET_PATH = "/__openclaw__/canvas/documents/counter/index.html"
AGENT_BUTTON_ROLES = ("button", "push button", "combo box")
WIDGET_DOCUMENT = b"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Release checklist</title><meta name="color-scheme" content="light dark">
<style>body{margin:20px;font:14px system-ui;color:CanvasText;background:Canvas}
h1{font-size:16px;margin:0 0 12px}p{margin:0 0 20px}
button{font:inherit;padding:8px 14px;border:1px solid GrayText;border-radius:8px;
background:ButtonFace;color:ButtonText}</style></head><body>
<h1>Release checklist</h1><p id="counter" role="status">Items reviewed: 0</p>
<button id="review">Mark item reviewed</button><script>
let count = 0;
function report(trusted) {
  fetch('/fixture/widget-state', {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({count,trusted})});
}
document.getElementById('review').addEventListener('click', event => {
  document.getElementById('counter').textContent = 'Items reviewed: ' + (++count);
  report(event.isTrusted);
});
report(false);
</script></body></html>"""


class QuickChatFixture(GatewayFixture):
    def __init__(self, artifacts_dir):
        super().__init__(artifacts_dir)
        self.RequestHandlerClass = QuickChatHandler
        self.chrome = WindowChromeFixture(None)
        self.vault = None
        self.lock = threading.RLock()
        self.clients = set()
        self.requests = []
        self.sends = []
        self.hold_next_ack = False
        self.quickchat_window = None
        self.checks = []
        self.canvas_surface = f"http://127.0.0.1:{self.server_port}/__openclaw__/cap/quickchat-fixture"
        self.widget_loads = 0
        self.widget_state = None
        self.widget_hit_windows = {}

    def start(self):
        self.chrome.start()
        self.vault = start_private_vault(self.chrome)
        super().start()

    def request(self, client, frame):
        method = frame.get("method")
        params = frame.get("params") or {}
        with self.lock:
            self.requests.append(method)
            if len(self.requests) > 200:
                raise RuntimeError("Quick Chat fixture exceeded 200 RPC requests")
            if method == "connect":
                return {
                    "type": "hello-ok", "protocol": 4, "auth": {},
                    "features": {"methods": ["agents.list", "config.get", "chat.send", "chat.history"]},
                    "policy": {"tickIntervalMs": 60000},
                    "pluginSurfaceUrls": {"canvas": self.canvas_surface},
                }
            if method == "agents.list":
                return {
                    "defaultId": "main", "mainKey": "main", "scope": "per-sender",
                    "agents": [
                        {"id": "main", "kind": "agent", "name": "Claw"},
                        {"id": "writer", "kind": "agent", "name": "Research"},
                    ],
                }
            if method == "config.get":
                return {"config": {"ui": {"prefs": {"accent": "#c44536"}}}}
            if method == "chat.send":
                if not isinstance(params.get("idempotencyKey"), str) or not params.get("message"):
                    raise RuntimeError("Native send omitted its message or idempotency identity")
                send = {"client": client, "requestId": frame["id"], **params}
                self.sends.append(send)
                if self.hold_next_ack:
                    self.hold_next_ack = False
                    return None
                return {"runId": params["idempotencyKey"], "status": "started"}
            if method == "chat.history":
                return {
                    "sessionKey": params["sessionKey"], "sessionId": "quickchat-fixture",
                    "messages": [], "hasMore": False, "truncated": False,
                }
            raise RuntimeError(f"Unexpected Quick Chat fixture RPC: {method}")

    def wait_for_send(self, count):
        return self.chrome.until(
            lambda: self.sends[count - 1] if len(self.sends) >= count else None,
            f"native chat.send {count}",
        )

    def acknowledge(self, send):
        send["client"].send_json({
            "type": "res", "id": send["requestId"], "ok": True,
            "payload": {"runId": send["idempotencyKey"], "status": "started"},
        })

    def reply(self, send, text, state="delta", *, widget=False):
        content = [{"type": "text", "text": text}]
        if widget:
            content.append({"type": "canvas", "preview": {
                "kind": "canvas", "surface": "assistant_message", "render": "url",
                "sandbox": "scripts", "title": "Release checklist", "url": WIDGET_PATH,
                "viewId": "release-checklist", "preferredHeight": 180,
            }})
        send["client"].send_json({
            "type": "event", "event": "chat", "payload": {
                "sessionKey": send["sessionKey"], "runId": send["idempotencyKey"],
                "state": state,
                "message": {"role": "assistant", "content": content},
            },
        })

    def record(self, name):
        self.checks.append(name)
        print(f"PASS Quick Chat: {name}", flush=True)

    def capture(self, name, *, expanded=None):
        if self.artifacts_dir is None:
            return
        if expanded is not None:
            self.chrome.until(
                lambda: (self.chrome.geometry(self.quickchat_window)["height"] >= 300) == expanded,
                "the native capture geometry",
            )
        destination = self.artifacts_dir / f"quick-chat-{name}.png"
        attempt = 0
        started = time.monotonic()

        def painted():
            nonlocal attempt
            attempt += 1
            frame = self.artifacts_dir / f"quick-chat-{name}-paint-{attempt:02}.png"
            arguments = ["import", "-window", "root"]
            if self.quickchat_window is not None:
                bounds = self.chrome.geometry(self.quickchat_window)
                arguments.extend(["-crop", (
                    f"{bounds['width']}x{bounds['height']}{bounds['x']:+d}{bounds['y']:+d}"
                ), "+repage"])
            self.chrome.command(*arguments, str(frame))
            colors = int(self.chrome.command("identify", "-format", "%k", str(frame)))
            if colors <= 2 or time.monotonic() - started < 1:
                return False
            destination.write_bytes(frame.read_bytes())
            return True

        self.chrome.until(painted, "a painted native Quick Chat frame")
        print(f"Screenshot: {destination}", flush=True)

    def activate(self, app):
        from gi.repository import Gio, GLib

        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

        def state():
            present = bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "NameHasOwner", GLib.Variant("(s)", ("ai.openclaw.Desktop",)), None,
                Gio.DBusCallFlags.NONE, 1000, None,
            ).unpack()[0]
            if not present:
                return None
            owner = bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "GetConnectionUnixProcessID", GLib.Variant("(s)", ("ai.openclaw.Desktop",)),
                None, Gio.DBusCallFlags.NONE, 1000, None,
            ).unpack()[0]
            if owner != app.pid:
                raise RuntimeError("Quick Chat bridge belongs to another process")
            value = json.loads(bus.call_sync(
                "ai.openclaw.Desktop", "/ai/openclaw/Desktop", "ai.openclaw.Desktop1", "GetState",
                None, None, Gio.DBusCallFlags.NONE, 1000, None,
            ).unpack()[0])
            return value if value["ready"] else None

        ready = self.chrome.until(state, "the isolated native Gateway connection")
        bus.call_sync(
            "ai.openclaw.Desktop", "/ai/openclaw/Desktop", "ai.openclaw.Desktop1", "Activate",
            GLib.Variant("(ssss)", (ready["routeId"], "quickchat", "", "")), None,
            Gio.DBusCallFlags.NONE, 2000, None,
        )

    def exercise(self, app, _binary, wait, Atspi):
        self.activate(app)

        def find_window():
            for line in self.chrome.command("wmctrl", "-lp").splitlines():
                parts = line.split(None, 4)
                if len(parts) == 5 and parts[2] == str(app.pid) and parts[4] == "Quick Chat":
                    return parts[0]
            return None

        self.quickchat_window = self.chrome.until(find_window, "the native Quick Chat window")

        def message():
            return wait("Quick Chat message", ("entry", "text", "text entry"))

        def value():
            return Atspi.Text.get_text(message().get_text_iface(), 0, -1)

        def point_at(bounds):
            if bounds.width <= 0 or bounds.height <= 0:
                raise RuntimeError("Quick Chat control has no visible bounds")
            x, y = bounds.x + bounds.width // 2, bounds.y + bounds.height // 2
            # Querying coordinates also handles a pointer already resting at the target.
            self.chrome.command("xdotool", "mousemove", str(x), str(y))
            location = dict(line.split("=", 1) for line in self.chrome.command(
                "xdotool", "getmouselocation", "--shell",
            ).splitlines())
            if (int(location["X"]), int(location["Y"])) != (x, y):
                raise RuntimeError("The native pointer did not reach the Quick Chat control")
            return int(location["WINDOW"])

        def fill(text):
            control = wait(
                "Quick Chat message", ("entry", "text", "text entry"),
                predicate=lambda node: node.get_state_set().contains(Atspi.StateType.EDITABLE),
            )
            point_at(control.get_component_iface().get_extents(Atspi.CoordType.SCREEN))
            self.chrome.command("xdotool", "click", "1")
            self.chrome.command("xdotool", "key", "--clearmodifiers", "ctrl+a")
            self.chrome.command("xdotool", "type", "--clearmodifiers", "--delay", "10", text)
            self.chrome.until(lambda: value() == text, "the entered Quick Chat draft")

        def click(label, roles=("button", "push button")):
            control = wait(label, roles, predicate=lambda node:
                           node.get_state_set().contains(Atspi.StateType.SENSITIVE))
            point_at(control.get_component_iface().get_extents(Atspi.CoordType.SCREEN))
            self.chrome.command("xdotool", "click", "1")

        def disclosure(expanded):
            self.chrome.until(
                lambda: (self.chrome.geometry(self.quickchat_window)["height"] >= 300) == expanded,
                "expanded reply" if expanded else "collapsed reply",
            )
            wait("Collapse reply" if expanded else "Expand reply", ("button", "push button"))

        wait("Quick Chat message", ("entry", "text", "text entry"), predicate=lambda node:
             node.get_state_set().contains(Atspi.StateType.SHOWING))
        self.capture("collapsed", expanded=False)
        fill("Summarize the release notes.")
        click("Send message")
        first = self.wait_for_send(1)
        self.reply(first, FIRST_REPLY)
        wait(FIRST_REPLY)
        self.capture("expanded-streaming", expanded=True)
        fill(NEXT_DRAFT)
        send_button = wait("Send message", ("button", "push button"))
        if send_button.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise RuntimeError("Send remained enabled during an active turn")
        agent_button = wait("Choose agent", AGENT_BUTTON_ROLES)
        print(f"Observed native agent selector role: {agent_button.get_localized_role_name()}", flush=True)
        if agent_button.get_state_set().contains(Atspi.StateType.SENSITIVE):
            raise RuntimeError("Agent selection remained enabled during an active turn")
        click("Collapse reply")
        disclosure(False)
        self.reply(first, CONTINUED_REPLY)
        if value() != NEXT_DRAFT:
            raise RuntimeError("Collapsing discarded the next draft")
        self.capture("collapsed-streaming")
        click("Expand reply")
        disclosure(True)
        wait(CONTINUED_REPLY)
        if value() != NEXT_DRAFT or len(self.sends) != 1:
            raise RuntimeError("Reopening changed the draft or sent another message")
        self.capture("reopened-streaming")
        self.record("streaming survives real collapse/reopen with one retained draft")

        self.reply(first, CONTINUED_REPLY, "final")
        wait("Send message", ("button", "push button"), predicate=lambda node:
             node.get_state_set().contains(Atspi.StateType.SENSITIVE))
        self.hold_next_ack = True
        click("Send message")
        second = self.wait_for_send(2)
        click("Collapse reply")
        disclosure(False)
        self.acknowledge(second)
        fill("A draft for Research.")
        disclosure(False)
        self.capture("late-ack-collapsed")
        self.record("a late send acknowledgement preserves the newer collapse")
        self.reply(second, "The follow-up is ready.", "final")
        click("Choose agent", AGENT_BUTTON_ROLES)
        click("Research", ("radio menu item", "menu item", "button", "push button"))
        fill("Please review the changes.")
        click("Send message")
        third = self.wait_for_send(3)
        if third["sessionKey"] != "agent:writer:main":
            raise RuntimeError("Agent selection did not change the native send target")
        self.reply(third, "Research is reviewing the changes.")
        wait("Research is reviewing the changes.")
        self.capture("selected-agent", expanded=True)
        self.reply(third, "Research is reviewing the changes.", "final")
        self.record("agent selection routes the next message to that agent")

        fill("Show an interactive checklist.")
        click("Send message")
        fourth = self.wait_for_send(4)
        self.reply(fourth, "Track the review here.", "final", widget=True)
        wait("Mark item reviewed", ("button", "push button"))
        click("Mark item reviewed")
        wait("Items reviewed: 1")
        self.chrome.until(
            lambda: self.widget_state == {"count": 1, "trusted": True},
            "a trusted native child click",
        )
        child = wait("Mark item reviewed", ("button", "push button"))
        child_bounds = child.get_component_iface().get_extents(Atspi.CoordType.SCREEN)

        self.widget_hit_windows["expanded"] = point_at(child_bounds)
        self.capture("widget-expanded", expanded=True)
        click("Collapse reply")
        disclosure(False)
        self.capture("widget-collapsed")
        if self.artifacts_dir is not None:
            self.chrome.command(
                "import", "-window", "root",
                str(self.artifacts_dir / "quick-chat-widget-collapsed-desktop.png"),
            )
        # WebKit retains descendant SHOWING after GTK hides its WebView. Test native hit behavior.
        self.widget_hit_windows["collapsed"] = point_at(child_bounds)
        if self.widget_hit_windows["collapsed"] == self.widget_hit_windows["expanded"]:
            raise RuntimeError("The collapsed widget remained the native pointer target")
        click("Expand reply")
        disclosure(True)
        wait("Items reviewed: 1")
        if self.widget_state != {"count": 1, "trusted": True}:
            raise RuntimeError("Collapsing or reopening changed the retained widget counter")
        self.widget_hit_windows["reopened"] = point_at(child_bounds)
        if self.widget_hit_windows["reopened"] != self.widget_hit_windows["expanded"]:
            raise RuntimeError("Reopening did not restore the native widget pointer target")
        click("Mark item reviewed")
        wait("Items reviewed: 2")
        self.chrome.until(
            lambda: self.widget_state == {"count": 2, "trusted": True},
            "the retained child to receive native input after reopening",
        )
        if self.widget_loads != 1:
            raise RuntimeError("Collapsing or reopening recreated the native child document")
        self.capture("widget-reopened")
        self.record("widget hides on collapse and retains interactive state on reopening")
        if self.failure:
            raise RuntimeError(self.failure)
        self.passed = True

    def close(self):
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            try:
                client.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.shutdown()
        self.server_close()
        self.server_thread.join(timeout=5)
        stop_private_vault(self.vault)
        self.chrome.close()
        if self.artifacts_dir is not None:
            (self.artifacts_dir / "quick-chat-results.json").write_text(json.dumps({
                "passed": self.passed, "checks": self.checks, "methods": self.requests,
                "sends": [{key: send[key] for key in ("sessionKey", "message", "idempotencyKey")}
                          for send in self.sends], "failure": self.failure,
                "widgetLoads": self.widget_loads, "widgetState": self.widget_state,
                "widgetHitWindows": self.widget_hit_windows,
            }, indent=2) + "\n")


class QuickChatHandler(FixtureHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() != "websocket":
            if self.path == "/__openclaw__/cap/quickchat-fixture" + WIDGET_PATH:
                with self.server.lock:
                    self.server.widget_loads += 1
                self.reply(200, WIDGET_DOCUMENT, "text/html; charset=utf-8")
                return
            self.reply(200, b"<!doctype html><title>Quick Chat fixture</title><h1>Quick Chat fixture</h1>",
                       "text/html; charset=utf-8")
            return
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key or len(key) > 128:
            self.reply(400)
            return
        accept = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode(),
        ).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.connection.settimeout(90)
        self.write_lock = threading.Lock()
        with self.server.lock:
            self.server.clients.add(self)
        try:
            self.send_json({"type": "event", "event": "connect.challenge", "payload": {
                "nonce": "quickchat-fixture", "ts": int(time.time() * 1000),
            }})
            while True:
                payload = self.read_frame()
                if payload is None:
                    return
                frame = json.loads(payload)
                if frame.get("type") != "req" or not isinstance(frame.get("id"), str):
                    raise RuntimeError("Invalid native Gateway request envelope")
                response = self.server.request(self, frame)
                if response is not None:
                    self.send_json({"type": "res", "id": frame["id"], "ok": True, "payload": response})
        except (BrokenPipeError, ConnectionResetError, EOFError, socket.timeout):
            pass
        except Exception as error:
            self.server.failure = str(error)
        finally:
            with self.server.lock:
                self.server.clients.discard(self)
            self.close_connection = True

    def do_POST(self):
        if self.path != "/fixture/widget-state":
            self.reply(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 1024:
            self.reply(400)
            return
        with self.server.lock:
            self.server.widget_state = json.loads(self.rfile.read(length))
        self.reply(204)

    def read_exact(self, count):
        data = self.rfile.read(count)
        if len(data) != count:
            raise EOFError()
        return data

    def read_frame(self):
        while True:
            first, second = self.read_exact(2)
            if first & 0x70 or not first & 0x80 or not second & 0x80:
                raise RuntimeError("Fixture expects complete masked WebSocket frames")
            size = second & 0x7f
            if size == 126:
                size = struct.unpack("!H", self.read_exact(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self.read_exact(8))[0]
            if size > 64 * 1024:
                raise RuntimeError("Native fixture request exceeded 64 KiB")
            mask = self.read_exact(4)
            data = bytes(value ^ mask[index % 4] for index, value in enumerate(self.read_exact(size)))
            opcode = first & 0x0f
            if opcode == 8:
                return None
            if opcode == 9:
                self.send_frame(data, opcode=10)
                continue
            if opcode != 1:
                raise RuntimeError("Fixture expects text Gateway requests")
            return data.decode("utf-8")

    def send_json(self, value):
        self.send_frame(json.dumps(value, separators=(",", ":")).encode())

    def send_frame(self, data, opcode=1):
        prefix = bytes([0x80 | opcode])
        prefix += bytes([len(data)]) if len(data) < 126 else b"\x7e" + struct.pack("!H", len(data))
        with self.write_lock:
            self.wfile.write(prefix + data)
            self.wfile.flush()
