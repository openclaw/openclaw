"""Sentinel Config API — lightweight HTTP server for dashboard management.

Runs in a daemon thread alongside the main sentinel loop.
Port: 18801 (configurable via sentinel.yaml http_api.port)
"""
import json
import os
import re
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from collections import defaultdict
from datetime import datetime

BASE = Path(__file__).resolve().parent
OPENCLAW_CFG = Path.home() / ".openclaw" / "openclaw.json"
SENTINEL_CFG = BASE / "config.json"

# Models available for switching
KNOWN_MODELS = [
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5",
    "deepseek/deepseek-chat",
]

_lock = threading.Lock()


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def _write_json(path: Path, data: dict):
    """Atomic write: write to .tmp then rename."""
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    tmp.rename(path)


def _build_roster() -> list[dict]:
    """Build agent roster (same logic as sentinel._build_agent_roster but standalone)."""
    cfg = _read_json(OPENCLAW_CFG)
    agents_list = cfg.get("agents", {}).get("list", [])
    bindings = cfg.get("bindings", [])
    tg_groups = cfg.get("channels", {}).get("telegram", {}).get("groups", {})
    default_deny = tg_groups.get("*", {}).get("tools", {}).get("deny", [])

    meta_path = BASE / "agents-meta.json"
    meta = _read_json(meta_path) if meta_path.exists() else {}

    sentinel_cfg = _read_json(SENTINEL_CFG)
    sentinel_groups = sentinel_cfg.get("groups", {})

    agent_chats: dict[str, list[str]] = defaultdict(list)
    for b in bindings:
        peer = b.get("match", {}).get("peer", {})
        if peer.get("kind") == "group" and peer.get("id"):
            gid = peer["id"]
            aid = b["agentId"]
            if gid not in agent_chats[aid]:
                agent_chats[aid].append(gid)

    for gid, g in sentinel_groups.items():
        aid = g.get("agent_id")
        if aid and gid not in agent_chats.get(aid, []):
            agent_chats[aid].append(gid)

    roster = []
    for agent in agents_list:
        aid = agent["id"]
        if aid == "wuji":
            continue
        m = meta.get(aid, {})
        cat = m.get("category", "tools")
        chat_ids = agent_chats.get(aid, [])

        perms = {}
        for gid in chat_ids:
            gconf = tg_groups.get(gid, {})
            deny = gconf.get("tools", {}).get("deny", default_deny)
            perms[gid] = {"deny": deny, "full": len(deny) == 0}

        roster.append({
            "id": m.get("projectId", aid),
            "name": m.get("name", aid.replace("-", " ").title()),
            "agentId": aid,
            "category": cat,
            "color": m.get("color", "#888888"),
            "emoji": m.get("emoji", ""),
            "chatIds": chat_ids,
            "model": agent.get("model", {}).get("primary", "default"),
            "permissions": perms,
        })
    return roster


def _get_private_chats() -> list[dict]:
    """Get all private chats from sentinel config."""
    sentinel_cfg = _read_json(SENTINEL_CFG)
    private = sentinel_cfg.get("private_chats", {})
    result = []
    for bridge_name, chats in private.items():
        for uid, info in chats.items():
            result.append({
                "userId": uid,
                "name": info.get("name", uid),
                "bridge": bridge_name,
                "priority": info.get("priority", "low"),
                "agentId": info.get("agent_id"),
            })
    return result


def _get_contacts_with_security() -> dict:
    """Known contacts vs unknown (from conversation DB)."""
    import sqlite3

    sentinel_cfg = _read_json(SENTINEL_CFG)
    private = sentinel_cfg.get("private_chats", {})

    # Flatten known user IDs
    known_ids: set[str] = set()
    known_map: dict[str, dict] = {}
    for bridge_name, chats in private.items():
        for uid, info in chats.items():
            known_ids.add(uid)
            known_map[uid] = {**info, "bridge": bridge_name, "userId": uid}

    # Check conversation DB for unknown senders in DMs
    unknown: list[dict] = []
    db_path = BASE / "data" / "conversations.db"
    if db_path.exists():
        try:
            conn = sqlite3.connect(str(db_path), timeout=5)
            conn.row_factory = sqlite3.Row
            # Find distinct senders from non-group chats (positive chat IDs = DM)
            rows = conn.execute("""
                SELECT DISTINCT sender_id, sender_name, chat_id
                FROM messages
                WHERE CAST(chat_id AS INTEGER) > 0
                  AND sender_id IS NOT NULL
                  AND sender_id != ''
                ORDER BY sender_name
            """).fetchall()
            conn.close()

            for row in rows:
                sid = str(row["sender_id"])
                if sid not in known_ids:
                    unknown.append({
                        "userId": sid,
                        "name": row["sender_name"] or sid,
                        "chatId": str(row["chat_id"]),
                        "status": "unknown",
                    })
        except Exception:
            pass

    return {
        "known": list(known_map.values()),
        "unknown": unknown,
        "knownCount": len(known_ids),
        "unknownCount": len(unknown),
    }


class ConfigAPIHandler(BaseHTTPRequestHandler):
    """HTTP request handler for config API."""

    def log_message(self, fmt, *args):
        # Suppress default stderr logging
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json_response(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, msg):
        self._json_response({"error": msg}, status)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/api/roster":
            with _lock:
                self._json_response(_build_roster())

        elif path == "/api/config/agents":
            with _lock:
                cfg = _read_json(OPENCLAW_CFG)
                agents = [a for a in cfg.get("agents", {}).get("list", []) if a["id"] != "wuji"]
                self._json_response(agents)

        elif path == "/api/config/groups":
            with _lock:
                cfg = _read_json(OPENCLAW_CFG)
                tg = cfg.get("channels", {}).get("telegram", {}).get("groups", {})
                sentinel_cfg = _read_json(SENTINEL_CFG)
                sg = sentinel_cfg.get("groups", {})
                # Merge: openclaw deny rules + sentinel names/priority
                result = {}
                for gid in set(list(tg.keys()) + list(sg.keys())):
                    if gid == "*":
                        continue
                    oc = tg.get(gid, {})
                    sc = sg.get(gid, {})
                    result[gid] = {
                        "name": sc.get("name", gid),
                        "priority": sc.get("priority", "low"),
                        "agentId": sc.get("agent_id"),
                        "bridge": sc.get("bridge"),
                        "deny": oc.get("tools", {}).get("deny", tg.get("*", {}).get("tools", {}).get("deny", [])),
                    }
                self._json_response(result)

        elif path == "/api/config/private":
            with _lock:
                self._json_response(_get_private_chats())

        elif path == "/api/config/bridges":
            with _lock:
                sentinel_cfg = _read_json(SENTINEL_CFG)
                self._json_response(sentinel_cfg.get("bridge", {}))

        elif path == "/api/contacts":
            with _lock:
                self._json_response(_get_contacts_with_security())

        elif path == "/api/models":
            self._json_response(KNOWN_MODELS)

        elif path == "/api/creator-state":
            creator_state_path = BASE / "data" / "creator-state.json"
            if creator_state_path.exists():
                self._json_response(_read_json(creator_state_path))
            else:
                self._error(404, "creator-state.json not found")

        else:
            self._error(404, f"Unknown endpoint: {path}")

    def do_PATCH(self):
        path = self.path.split("?")[0]

        # PATCH /api/agents/<agentId>/model
        m = re.match(r"^/api/agents/([^/]+)/model$", path)
        if m:
            agent_id = m.group(1)
            body = self._read_body()
            new_model = body.get("model")
            if not new_model:
                return self._error(400, "model required")

            with _lock:
                cfg = _read_json(OPENCLAW_CFG)
                agents = cfg.get("agents", {}).get("list", [])
                found = False
                for agent in agents:
                    if agent["id"] == agent_id:
                        agent.setdefault("model", {})["primary"] = new_model
                        found = True
                        break
                if not found:
                    return self._error(404, f"Agent {agent_id} not found")
                _write_json(OPENCLAW_CFG, cfg)

            return self._json_response({"ok": True, "agentId": agent_id, "model": new_model})

        # PATCH /api/groups/<groupId>/deny
        m = re.match(r"^/api/groups/([^/]+)/deny$", path)
        if m:
            group_id = m.group(1)
            body = self._read_body()
            deny = body.get("deny")
            if deny is None:
                return self._error(400, "deny array required")

            with _lock:
                cfg = _read_json(OPENCLAW_CFG)
                groups = cfg.setdefault("channels", {}).setdefault("telegram", {}).setdefault("groups", {})
                groups.setdefault(group_id, {}).setdefault("tools", {})["deny"] = deny
                _write_json(OPENCLAW_CFG, cfg)

            return self._json_response({"ok": True, "groupId": group_id, "deny": deny})

        # PATCH /api/groups/<groupId>/priority
        m = re.match(r"^/api/groups/([^/]+)/priority$", path)
        if m:
            group_id = m.group(1)
            body = self._read_body()
            priority = body.get("priority")
            if priority not in ("high", "medium", "low"):
                return self._error(400, "priority must be high/medium/low")

            with _lock:
                sentinel_cfg = _read_json(SENTINEL_CFG)
                groups = sentinel_cfg.get("groups", {})
                if group_id in groups:
                    groups[group_id]["priority"] = priority
                    _write_json(SENTINEL_CFG, sentinel_cfg)
                else:
                    return self._error(404, f"Group {group_id} not in sentinel config")

            return self._json_response({"ok": True, "groupId": group_id, "priority": priority})

        # PATCH /api/private/<userId>
        m = re.match(r"^/api/private/([^/]+)$", path)
        if m:
            user_id = m.group(1)
            body = self._read_body()

            with _lock:
                sentinel_cfg = _read_json(SENTINEL_CFG)
                private = sentinel_cfg.get("private_chats", {})
                found = False
                for bridge_name, chats in private.items():
                    if user_id in chats:
                        if "agentId" in body:
                            if body["agentId"]:
                                chats[user_id]["agent_id"] = body["agentId"]
                            else:
                                chats[user_id].pop("agent_id", None)
                        if "priority" in body:
                            chats[user_id]["priority"] = body["priority"]
                        if "name" in body:
                            chats[user_id]["name"] = body["name"]
                        found = True
                        break
                if not found:
                    return self._error(404, f"Private chat {user_id} not found")
                _write_json(SENTINEL_CFG, sentinel_cfg)

            return self._json_response({"ok": True, "userId": user_id})

        self._error(404, f"Unknown endpoint: {path}")

    def do_POST(self):
        path = self.path.split("?")[0]

        # POST /api/contacts/whitelist
        if path == "/api/contacts/whitelist":
            body = self._read_body()
            user_id = body.get("userId")
            name = body.get("name", user_id)
            bridge = body.get("bridge", "dufu")
            if not user_id:
                return self._error(400, "userId required")

            with _lock:
                sentinel_cfg = _read_json(SENTINEL_CFG)
                private = sentinel_cfg.setdefault("private_chats", {})
                bridge_chats = private.setdefault(bridge, {})
                bridge_chats[user_id] = {
                    "name": name,
                    "priority": body.get("priority", "low"),
                }
                if body.get("agentId"):
                    bridge_chats[user_id]["agent_id"] = body["agentId"]
                _write_json(SENTINEL_CFG, sentinel_cfg)

            return self._json_response({"ok": True, "userId": user_id, "action": "whitelisted"})

        self._error(404, f"Unknown endpoint: {path}")


def start_api_server(port: int = 18801, logger=None) -> threading.Thread:
    """Start the config API server in a daemon thread."""
    server = HTTPServer(("127.0.0.1", port), ConfigAPIHandler)
    server.timeout = 1

    def serve():
        if logger:
            logger.info(f"Config API server started on :{port}")
        server.serve_forever()

    thread = threading.Thread(target=serve, daemon=True, name="config-api")
    thread.start()
    return thread
