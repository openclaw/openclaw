"""Conversation layer — shared by conversation_pulse and conversation_sync.

Provides multi-bridge message fetching, bot identity detection, and group registry.
stdlib only (urllib), reuses patterns from telegram.py.
"""

import json
import logging
import time
import urllib.error
import urllib.request

logger = logging.getLogger("sentinel.conversation")

# Populated by init_bot_ids() at task startup
BOT_SENDER_IDS: set[int] = set()


def init_bot_ids(config: dict) -> set[int]:
    """Call /health on each bridge to discover bot user_ids."""
    global BOT_SENDER_IDS
    bridges = config.get("bridge", {})
    for name, url in bridges.items():
        url = url.rstrip("/")
        try:
            req = urllib.request.Request(f"{url}/health", method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                uid = data.get("user_id")
                if uid:
                    BOT_SENDER_IDS.add(int(uid))
                    logger.debug("Bridge %s → bot user_id %s", name, uid)
        except Exception as e:
            logger.warning("init_bot_ids: bridge %s unreachable: %s", name, e)
    return BOT_SENDER_IDS


def get_groups(config: dict) -> dict:
    """Parse config.json groups + private_chats into enriched registry.

    Returns: {chat_id: {name, bridge, bridge_url, agent_id, priority, is_dm}}
    """
    bridges = config.get("bridge", {})
    groups = {}
    for chat_id, info in config.get("groups", {}).items():
        bridge_name = info.get("bridge", "dufu")
        groups[chat_id] = {
            "name": info.get("name", chat_id),
            "bridge": bridge_name,
            "bridge_url": bridges.get(bridge_name, "http://localhost:18790").rstrip("/"),
            "agent_id": info.get("agent_id"),
            "priority": info.get("priority", "low"),
            "is_dm": False,
        }

    # Private chats: keyed by bridge name → {user_id: {name, ...}}
    for bridge_name, chats in config.get("private_chats", {}).items():
        bridge_url = bridges.get(bridge_name, "http://localhost:18790").rstrip("/")
        for user_id, info in chats.items():
            groups[user_id] = {
                "name": f"DM:{info.get('name', user_id)}",
                "bridge": bridge_name,
                "bridge_url": bridge_url,
                "agent_id": info.get("agent_id"),
                "priority": info.get("priority", "low"),
                "is_dm": True,
            }

    return groups


def _load_bridge_token() -> str | None:
    """Load bridge token from telegram-userbot config."""
    import pathlib
    cfg_path = pathlib.Path.home() / "clawd" / "workspace" / "skills" / "telegram-userbot" / "config.json"
    try:
        with open(cfg_path) as f:
            return json.load(f).get("bridge_token")
    except Exception:
        return None


_BRIDGE_TOKEN: str | None = None


def _get_bridge_token() -> str | None:
    global _BRIDGE_TOKEN
    if _BRIDGE_TOKEN is None:
        _BRIDGE_TOKEN = _load_bridge_token() or ""
    return _BRIDGE_TOKEN or None


def fetch_messages(bridge_url: str, chat_id: str, limit: int = 30,
                   offset_id: int = 0) -> list[dict]:
    """GET /messages from bridge. Returns list of message dicts, empty on failure.

    Each message dict has: id, sender_id, sender_name, text, timestamp, has_media, etc.
    Sleeps 0.3s after each call to avoid rate limiting.

    Args:
        offset_id: Telethon pagination — fetch messages older than this message ID.
    """
    url = f"{bridge_url}/messages?chat={chat_id}&limit={limit}"
    if offset_id:
        url += f"&offset_id={offset_id}"
    try:
        req = urllib.request.Request(url, method="GET")
        token = _get_bridge_token()
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            # Bridge returns {"ok": true, "messages": [...]} or just a list
            if isinstance(data, list):
                messages = data
            elif isinstance(data, dict):
                messages = data.get("messages", [])
            else:
                messages = []
        return messages
    except Exception as e:
        logger.warning("fetch_messages(%s, %s): %s", bridge_url, chat_id, e)
        return []
    finally:
        time.sleep(0.3)


def is_bot(msg: dict) -> bool:
    """Check if a message was sent by one of our bots."""
    sender_id = msg.get("sender_id")
    if sender_id is None:
        return False
    return int(sender_id) in BOT_SENDER_IDS
