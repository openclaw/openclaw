#!/usr/bin/env python3
"""Omarchy presentation adapter for OpenClaw's public Gateway CLI."""
import hashlib
import json
import os
import queue
from pathlib import Path
import threading
import shutil
import subprocess
import sys
import time
import uuid


class GatewayError(Exception):
    pass


def cli_path():
    override = os.environ.get("OPENCLAW_DESKTOP_CLI")
    if override:
        return override
    managed = Path.home() / ".openclaw/bin/openclaw"
    return str(managed) if managed.is_file() else shutil.which("openclaw")


def cli_json(cli, arguments):
    if not cli:
        raise GatewayError("OpenClaw is not on PATH. Install it from Omarchy Menu → Install → AI → OpenClaw.")
    try:
        result = subprocess.run(
            [cli, *arguments],
            capture_output=True, text=True, timeout=25, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GatewayError("Gateway did not respond. Open diagnostics to check the connection.") from error
    if result.returncode:
        # CLI stderr may include connection details; keep it in the diagnostics terminal.
        raise GatewayError("Gateway request failed. Update the CLI and check its connection in diagnostics.")
    try:
        value = json.loads(result.stdout)
        if not isinstance(value, dict):
            raise ValueError("Expected object")
        return value
    except (ValueError, TypeError) as error:
        raise GatewayError("Unrecognized Gateway response. Check the installed OpenClaw version.") from error



def rpc(method, params, cli, expected_url):
    return cli_json(cli, ["gateway", "call", method, "--json", "--timeout", "15000",
                          "--expect-url", expected_url, "--params", json.dumps(params)])


def text(value, limit=240):
    return value[:limit] if isinstance(value, str) else ""


def session_id(agent_id, key):
    return json.dumps([agent_id, key], separators=(",", ":"))


def session(row):
    if not isinstance(row, dict) or not isinstance(row.get("key"), str):
        return None
    status = row.get("status", "idle")
    if row.get("hasActiveRun") is True:
        status = "running"
    if status not in ("queued", "running", "done", "failed", "killed", "timeout"):
        status = "idle"
    agent_id = text(row.get("agentId"), 128)
    # Older supported rows encode the owner in the canonical agent session key.
    if not agent_id and row["key"].startswith("agent:"):
        agent_id = row["key"].split(":", 2)[1]
    digest = row.get("observerDigest") or {}
    agent_status = row.get("agentStatus") or {}
    waiting = isinstance(digest, dict) and digest.get("health") == "waiting-on-user"
    attention = (row.get("unread") is True or status in ("failed", "timeout")
                 or (isinstance(digest, dict) and digest.get("health") in ("waiting-on-user", "stuck", "failed"))
                 or (isinstance(agent_status, dict) and bool(agent_status.get("attention"))))
    return {
        "id": session_id(agent_id, row["key"]),
        "key": row["key"], "agentId": agent_id,
        "title": text(row.get("label") or row.get("displayName") or row.get("derivedTitle") or row["key"]),
        "preview": text(row.get("lastMessagePreview"), 360),
        "activity": text(digest.get("headline")) if isinstance(digest, dict) else "",
        "status": status, "unread": row.get("unread") is True,
        "attention": attention, "waiting": waiting,
        "model": text(row.get("model"), 120),
        "channel": text(row.get("channel"), 80),
        "updatedAt": row.get("updatedAt") if isinstance(row.get("updatedAt"), (float, int)) else 0,
        "totalTokens": row.get("totalTokens") if isinstance(row.get("totalTokens"), (float, int)) else 0,
    }


def snapshot_data(cli, expected_url):
    params = {"limit": 40, "includeDerivedTitles": True, "includeLastMessage": True, "includeGlobal": True}
    roster = rpc("agents.list", {}, cli, expected_url)
    recent = rpc("sessions.list", params, cli, expected_url)
    active = rpc("sessions.list", {**params, "activeOnly": True}, cli, expected_url)
    return project(roster, recent, active)


def project(roster, recent, active):
    agents = []
    for row in roster.get("agents", [])[:100]:
        if not isinstance(row, dict) or not row.get("id"):
            continue
        identity = row.get("identity") or {}
        model = row.get("model") or {}
        agents.append({
            "id": text(row["id"], 128),
            "name": text(row.get("name") or identity.get("name") or row["id"], 100),
            "model": text(model.get("primary"), 120) if isinstance(model, dict) else text(model, 120),
        })
    rows = {}
    for row in recent.get("sessions", []) + active.get("sessions", []):
        item = session(row)
        if item:
            rows[item["id"]] = item
    sessions = sorted(rows.values(), key=lambda s: (
        not s["attention"],
        s["status"] not in ("running", "queued"), -s["updatedAt"],
    ))
    return {"ok": True, "agents": agents, "sessions": sessions,
            "defaultAgent": text(roster.get("defaultId"), 128),
            "selectionRequired": roster.get("selectionRequired") is True,
            "hasMore": bool(recent.get("hasMore") or active.get("hasMore")),
            "checkedAt": int(time.time() * 1000)}


def send(request, dispatch):
    agent_id = request.get("agentId")
    message = request.get("message")
    key = request.get("sessionKey", "")
    if not isinstance(agent_id, str) or not agent_id or not isinstance(key, str):
        return {"ok": False, "uncertain": False, "error": "Select an agent and a destination first."}
    if not isinstance(message, str) or not message.strip() or len(message) > 8000:
        return {"ok": False, "uncertain": False, "error": "Enter a prompt of 1–8,000 characters."}
    request_id = str(uuid.uuid4())
    try:
        if key:
            reply = dispatch("chat.send", {"agentId": agent_id, "sessionKey": key,
                        "message": message, "deliver": False, "idempotencyKey": request_id})
        else:
            reply = dispatch("sessions.create", {"agentId": agent_id, "message": message,
                        "idempotencyKey": request_id})
            key = text(reply.get("key"), 2048)
            if reply.get("runError") or reply.get("runStarted") is not True:
                return {"ok": False, "uncertain": True, "sessionKey": key,
                        "requestId": request_id,
                        "error": "Session created, but prompt acceptance was not confirmed. Open the session before sending again."}
        if not reply.get("runId") or reply.get("status") not in ("started", "accepted", "queued", "ok"):
            return {"ok": False, "uncertain": True, "sessionKey": key,
                    "requestId": request_id, "error": "Acceptance was not confirmed. Check the session before sending again."}
        return {"ok": True, "sessionKey": key, "runId": reply["runId"], "requestId": request_id}
    except (GatewayError, ValueError, TypeError, KeyError, AttributeError) as error:
        # A timeout can follow an accepted write. Never retry or switch targets.
        return {"ok": False, "uncertain": True, "sessionKey": key, "requestId": request_id,
                "error": (str(error) if isinstance(error, GatewayError) else "The response was not recognized.") + " Acceptance is unknown; check the session before sending again."}



class Desktop:
    """Use the app's live bus owner and route, never copy its credentials."""

    def __init__(self):
        from gi.repository import Gio, GLib
        self.Gio, self.GLib = Gio, GLib
        try:
            self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except GLib.Error as error:
            raise GatewayError("Session bus unavailable. Check the desktop session.") from error

    def owner(self, name):
        try:
            result = self.bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "GetNameOwner", self.GLib.Variant("(s)", (name,)), None,
                self.Gio.DBusCallFlags.NONE, 2000, None)
            return result.unpack()[0]
        except self.GLib.Error as error:
            if self.Gio.DBusError.get_remote_error(error) == "org.freedesktop.DBus.Error.NameHasNoOwner":
                return ""
            raise GatewayError("Session bus unavailable. Check the desktop app.") from error

    def call(self, owner, method, signature="()", args=()):
        try:
            reply = self.bus.call_sync(
                owner, "/ai/openclaw/Desktop", "ai.openclaw.Desktop1", method,
                self.GLib.Variant(signature, args), None,
                self.Gio.DBusCallFlags.NONE, 65000, None).unpack()
            return json.loads(reply[0]) if reply else None
        except self.GLib.Error as error:
            # Remote errors can contain Gateway URLs or provider diagnostics.
            raise GatewayError("Desktop request failed. Open the app to check its connection.") from error


class Worker:
    def __init__(self):
        self.desktop = Desktop()
        self.state = {}
        self.state_lock = threading.Lock()
        self.output_lock = threading.Lock()
        self.stopped = threading.Event()
        self.cli_state = None
        self.cli_lock = threading.Lock()

    def emit(self, value):
        with self.output_lock:
            print(json.dumps(value), flush=True)

    def probe(self, refresh_cli=False):
        owner = self.desktop.owner("ai.openclaw.Desktop")
        if owner:
            state = self.desktop.call(owner, "GetState")
            if state.get("version") != 1:
                raise GatewayError("Update the Omarchy plugin to match the desktop app.")
            return {"routeId": owner + "/" + state["routeId"], "desktop": True,
                    "ready": state["ready"], "yield": False, "owner": owner,
                    "nativeRoute": state["routeId"]}
        legacy = self.desktop.owner("ai.openclaw.linux.SingleInstance")
        if legacy:
            return {"routeId": legacy, "desktop": True, "ready": False, "yield": True,
                    "error": "This desktop app uses its own tray. Update it to enable the Omarchy panel."}
        cli = cli_path()
        with self.cli_lock:
            if refresh_cli or self.cli_state is None or self.cli_state.get("cli") != cli:
                state = {"desktop": False, "yield": False, "cli": cli, "ready": False,
                         "routeId": "cli:unavailable:" + hashlib.sha256((cli or "").encode()).hexdigest(),
                         "error": "Install OpenClaw from Omarchy Menu → Install → AI → OpenClaw."}
                if cli:
                    try:
                        status = cli_json(cli, ["status", "--json", "--timeout", "1000"])
                        url = status.get("gateway", {}).get("url")
                        if not isinstance(url, str) or not url.startswith(("ws://", "wss://")):
                            raise GatewayError("Could not identify the CLI Gateway. Update OpenClaw and open diagnostics.")
                        route = hashlib.sha256(json.dumps([cli, url]).encode()).hexdigest()
                        state.update(routeId="cli:" + route, cliUrl=url, ready=True, error="")
                    except (GatewayError, AttributeError, TypeError) as error:
                        state["error"] = str(error) if isinstance(error, GatewayError) else "Could not identify the CLI Gateway. Open diagnostics."
                self.cli_state = state
            return dict(self.cli_state)

    def heartbeat(self):
        while not self.stopped.is_set():
            try:
                state = self.probe()
                if state.get("owner"):
                    self.desktop.call(state["owner"], "ClaimPresenter", "(s)", (state["nativeRoute"],))
            except (GatewayError, ValueError, KeyError, TypeError) as error:
                state = {"routeId": "", "desktop": True, "ready": False, "yield": True,
                         "error": str(error) if isinstance(error, GatewayError) else "Desktop response was not recognized."}
            with self.state_lock:
                changed = state != self.state
                self.state = state
            if changed:
                self.emit({"op": "state", **self.public_state(state)})
            self.stopped.wait(3)

    @staticmethod
    def public_state(state):
        return {key: value for key, value in state.items() if key not in ("owner", "nativeRoute", "cli", "cliUrl")}

    def target(self, request, refresh_cli=False):
        state = self.probe(refresh_cli=refresh_cli)
        if not request.get("routeId") or request["routeId"] != state["routeId"] or state["yield"]:
            raise GatewayError("Gateway changed. Review the destination before trying again.")
        return state

    def dispatch(self, state, method, params):
        # Fence once more immediately before writes; never retry over another transport.
        current = self.probe()
        if current["routeId"] != state["routeId"] or current["yield"]:
            raise GatewayError("Gateway changed. Check the session before sending again.")
        if state.get("owner"):
            return self.desktop.call(state["owner"], "SendPrompt", "(sssss)", (
                state["nativeRoute"], params["agentId"], params.get("sessionKey", ""),
                params["message"], params["idempotencyKey"]))
        if method == "chat.send" and params.get("sessionKey") != "global":
            params = {key: value for key, value in params.items() if key != "agentId"}
        return rpc(method, params, state["cli"], state["cliUrl"])

    def activate(self, state, request):
        action = request.get("action")
        key = request.get("sessionKey", "")
        if state.get("owner"):
            if action == "diagnostics":
                raise GatewayError("Open the desktop app to inspect its selected Gateway connection.")
            self.desktop.call(state["owner"], "Activate", "(ssss)",
                              (state["nativeRoute"], action, key, request.get("agentId", "")))
        else:
            cli = cli_path()
            if not cli:
                raise GatewayError("Install OpenClaw first.")
            if action == "dashboard":
                command = ["omarchy-launch-terminal", cli, "dashboard"]
            elif action == "session" and isinstance(key, str) and key:
                agent_id = request.get("agentId", "")
                if key == "global":
                    if not isinstance(agent_id, str) or not agent_id or ":" in agent_id:
                        raise GatewayError("Select the session’s agent first.")
                    key = "agent:" + agent_id + ":global"
                command = ["omarchy-launch-terminal", cli, "tui", "--session", key]
            elif action == "diagnostics":
                command = ["omarchy-launch-terminal", cli, "gateway", "status"]
            else:
                raise GatewayError("This action needs the OpenClaw desktop app.")
            subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        return {"ok": True}

    def handle(self, request):
        operation = request.get("op")
        try:
            state = self.target(request, refresh_cli=True)
            if not state["desktop"] and not state["ready"] and operation != "activate":
                raise GatewayError(state["error"])
            if operation == "snapshot":
                if state.get("owner"):
                    raw = self.desktop.call(state["owner"], "Snapshot", "(s)", (state["nativeRoute"],))
                    result = project(raw["agents"], raw["recent"], raw["active"])
                else:
                    result = snapshot_data(state["cli"], state["cliUrl"])
                self.target(request)
            elif operation == "send":
                result = send(request, lambda method, params: self.dispatch(state, method, params))
                if result.get("sessionKey"):
                    result["sessionId"] = session_id(request["agentId"], result["sessionKey"])
            elif operation == "activate":
                result = self.activate(state, request)
            else:
                raise GatewayError("Unknown widget action.")
        except (GatewayError, ValueError, TypeError, KeyError, AttributeError, OSError) as error:
            result = {"ok": False, "uncertain": False,
                      "error": str(error) if isinstance(error, GatewayError) else "Could not read OpenClaw data. Open the app to check its connection."}
        self.emit({**result, "id": request.get("id"), "op": operation, "routeId": request.get("routeId", "")})

    def serve(self):
        requests = queue.Queue()

        def consume():
            while not self.stopped.is_set():
                request = requests.get()
                self.handle(request)

        threading.Thread(target=self.heartbeat, daemon=True).start()
        threading.Thread(target=consume, daemon=True).start()
        try:
            for line in sys.stdin:
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict):
                        raise ValueError("Expected object")
                    requests.put(request)
                except ValueError:
                    self.emit({"ok": False, "error": "Invalid widget request."})
        finally:
            self.stopped.set()


def main():
    try:
        Worker().serve()
    except (ImportError, GatewayError) as error:
        print(json.dumps({"op": "state", "ready": False, "yield": False, "routeId": "",
                          "error": "The widget needs Python 3, PyGObject, and a working desktop session bus."}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
