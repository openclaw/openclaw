"""Telegram bridge HTTP wrapper — stdlib only."""
import json
import urllib.request
import urllib.error

DEFAULT_BRIDGE = "http://localhost:18790"


class TelegramBridge:
    def __init__(self, bridge_url=DEFAULT_BRIDGE, timeout=10):
        self.bridge_url = bridge_url.rstrip("/")
        self.timeout = timeout

    def health(self):
        """Check bridge health. Returns dict with status."""
        try:
            req = urllib.request.Request(f"{self.bridge_url}/health")
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read())
                data["reachable"] = True
                return data
        except Exception as e:
            return {"reachable": False, "error": str(e)}

    def send(self, text, chat_id):
        """Send text message via bridge. Field name is 'chat' (not 'chat_id')."""
        payload = json.dumps({"chat": str(chat_id), "text": text}).encode()
        req = urllib.request.Request(
            f"{self.bridge_url}/send",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode()[:200]
            except Exception:
                pass
            return {"ok": False, "error": f"HTTP {e.code}: {body}"}
        except urllib.error.URLError as e:
            return {"ok": False, "error": str(e)}

    def get_messages(self, chat_id, limit=15):
        """Get recent messages from a chat."""
        url = f"{self.bridge_url}/messages?chat={chat_id}&limit={limit}"
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except Exception as e:
            return {"ok": False, "error": str(e)}
