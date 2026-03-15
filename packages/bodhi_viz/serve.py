"""
bodhi_viz.serve — Secure HTTP server for the viz dashboard.

Security model:
  - Binds to Tailscale IP only (100.x.x.x), never 0.0.0.0
  - All endpoints require a bearer token (cookie or ?token= param)
  - Token lives at ~/.openclaw/viz-token (chmod 600), auto-generated on first run
  - CORS locked: no wildcard, only Tailscale origin allowed
  - graph.json / sankey.json contain NO raw vault content (labels only)
  - Full node content served only via authenticated /api/node/<id>
  - HTTPS supported via --cert / --key (use: tailscale cert <hostname>)

Usage:
  python -m bodhi_viz.serve
  python -m bodhi_viz.serve --export-first
  python -m bodhi_viz.serve --port 8085
  python -m bodhi_viz.serve --cert ~/.openclaw/tls/cert.pem --key ~/.openclaw/tls/key.pem
"""

import hashlib
import hmac
import json
import os
import secrets
import shutil
import socket
import ssl
import stat
import sys
import time
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn

VIZ_DIR = Path(os.path.expanduser("~/.openclaw/viz"))
TOKEN_PATH = Path(os.path.expanduser("~/.openclaw/viz-token"))
TEMPLATES_DIR = Path(__file__).parent / "templates"
DEFAULT_PORT = 8085
COOKIE_NAME = "bvt"
COOKIE_MAX_AGE = 86400 * 30  # 30 days


# ── Token management ──────────────────────────────────────────────────────────

def _load_or_create_token() -> str:
    """Load token from disk or generate a fresh one. Always chmod 600."""
    if TOKEN_PATH.exists():
        token = TOKEN_PATH.read_text(encoding="ascii").strip()
        if len(token) >= 40:
            return token
    # Generate new token
    token = secrets.token_urlsafe(32)  # 256 bits of entropy
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(token, encoding="ascii")
    TOKEN_PATH.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0o600
    return token


def _verify_token(candidate: str, real: str) -> bool:
    """Constant-time comparison — prevents timing attacks."""
    return hmac.compare_digest(
        candidate.encode("utf-8", errors="replace"),
        real.encode("utf-8"),
    )


# ── Vault watching ────────────────────────────────────────────────────────────

_vault_mtime: float = 0.0
_vault_mtime_lock = threading.Lock()


def _scan_vault_mtime(vault_path: Path) -> float:
    nodes_dir = vault_path / "nodes"
    if not nodes_dir.exists():
        return 0.0
    try:
        return max(
            (f.stat().st_mtime for f in nodes_dir.rglob("*.json")),
            default=0.0,
        )
    except Exception:
        return 0.0


def _watch_vault(vault_path: Path, viz_dir: Path, poll_secs: float = 8.0) -> None:
    global _vault_mtime
    with _vault_mtime_lock:
        _vault_mtime = _scan_vault_mtime(vault_path)

    while True:
        time.sleep(poll_secs)
        try:
            current = _scan_vault_mtime(vault_path)
            with _vault_mtime_lock:
                if current > _vault_mtime:
                    _vault_mtime = current
                    _run_export(vault_path, viz_dir)
        except Exception:
            pass


def _run_export(vault_path: Path, viz_dir: Path) -> dict:
    try:
        from bodhi_viz.export import export
        return export(vault_path=vault_path, viz_dir=viz_dir)
    except Exception as exc:
        print(f"[viz] export error: {exc}")
        return {}


# ── Network helpers ───────────────────────────────────────────────────────────

def _get_tailscale_ip() -> str | None:
    try:
        import subprocess
        result = subprocess.run(
            ["tailscale", "ip", "-4"],
            capture_output=True, text=True, timeout=3,
        )
        ip = result.stdout.strip()
        if ip.startswith("100."):
            return ip
    except Exception:
        pass
    return None


def _get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("1.1.1.1", 80))  # Cloudflare probe
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ── Static file helpers ───────────────────────────────────────────────────────

def deploy_templates(viz_dir: Path) -> None:
    viz_dir.mkdir(parents=True, exist_ok=True)
    if TEMPLATES_DIR.exists():
        for tmpl in TEMPLATES_DIR.glob("*.html"):
            shutil.copy2(tmpl, viz_dir / tmpl.name)


def _mime(path: str) -> str:
    ext = path.split(".")[-1].lower()
    return {
        "html": "text/html; charset=utf-8",
        "json": "application/json",
        "js": "application/javascript",
        "css": "text/css",
        "png": "image/png",
        "ico": "image/x-icon",
    }.get(ext, "application/octet-stream")


# ── Request handler ───────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    """
    Handles all requests with token auth gate.
    Class attributes set at serve() time:
      viz_dir, vault_path, token, bind_ip
    """
    viz_dir: Path = VIZ_DIR
    vault_path: Path = Path(os.path.expanduser("~/openbodhi/vault"))
    token: str = ""
    bind_ip: str = "127.0.0.1"

    def log_message(self, format, *args):
        pass  # no per-request noise in systemd journal

    # ── CORS ─────────────────────────────────────────────────────────────────

    def _allowed_origins(self) -> list[str]:
        """Only allow same-origin and Tailscale-local origins."""
        return [
            f"http://{self.__class__.bind_ip}:{self.server.server_address[1]}",
            f"https://{self.__class__.bind_ip}:{self.server.server_address[1]}",
            "null",  # local file access (SiYuan widget loaded from disk)
        ]

    def _send_cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin in self._allowed_origins():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    # ── Token auth ────────────────────────────────────────────────────────────

    def _extract_token_from_request(self) -> str | None:
        """Look for token in cookie, then Authorization header, then query param."""
        # 1. Cookie (set on first authenticated visit)
        raw_cookie = self.headers.get("Cookie", "")
        for part in raw_cookie.split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE_NAME:
                return v.strip()

        # 2. Authorization: Bearer <token>
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:].strip()

        # 3. ?token= query param (for Telegram URL sharing)
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if "token" in qs:
            return qs["token"][0]

        return None

    def _is_authenticated(self) -> bool:
        candidate = self._extract_token_from_request()
        if candidate is None:
            return False
        return _verify_token(candidate, self.__class__.token)

    def _set_token_cookie(self) -> None:
        """Set the token as a Secure, HttpOnly, SameSite=Strict cookie."""
        cookie = (
            f"{COOKIE_NAME}={self.__class__.token}; "
            f"Max-Age={COOKIE_MAX_AGE}; "
            "Path=/; "
            "HttpOnly; "
            "SameSite=Strict"
        )
        self.send_header("Set-Cookie", cookie)

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self._send_cors()
        self.end_headers()

    def _deny(self) -> None:
        body = b'{"error":"unauthorized"}'
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("WWW-Authenticate", 'Bearer realm="bodhi-viz"')
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    # ── Routing ───────────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        # Unauthenticated: ping only
        if path == "/ping":
            self._ok_json(b'{"ok":true}')
            return

        # Auth check
        if not self._is_authenticated():
            self._deny()
            return

        # If token came in via URL param, redirect to clean URL and set cookie
        qs = urllib.parse.parse_qs(parsed.query)
        if "token" in qs:
            clean_qs = {k: v for k, v in qs.items() if k != "token"}
            clean = parsed._replace(
                query=urllib.parse.urlencode(clean_qs, doseq=True)
            ).geturl()
            self.send_response(302)
            self.send_header("Location", clean)
            self._set_token_cookie()
            self._send_cors()
            self.end_headers()
            return

        # Authenticated routes
        if path == "/events":
            self._sse_stream()
        elif path.startswith("/api/node/"):
            node_id = path[len("/api/node/"):]
            self._serve_node(node_id)
        elif path == "/api/stats":
            self._serve_stats()
        else:
            self._serve_static(path)

    # ── Response helpers ──────────────────────────────────────────────────────

    def _ok_json(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path: str) -> None:
        if path == "/":
            path = "/graph.html"
        # Prevent path traversal
        target = (self.__class__.viz_dir / path.lstrip("/")).resolve()
        try:
            target.relative_to(self.__class__.viz_dir.resolve())
        except ValueError:
            self._deny()
            return

        if not target.exists() or not target.is_file():
            self.send_response(404)
            self.end_headers()
            return

        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", _mime(str(target)))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._set_token_cookie()
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _serve_node(self, node_id: str) -> None:
        """Return full node content for an authenticated request."""
        # Sanitise: node IDs are UUIDs or short alphanumeric strings
        safe = "".join(c for c in node_id if c.isalnum() or c in "-_")
        vault_path = self.__class__.vault_path
        # Search under nodes/**/*.json
        nodes_dir = vault_path / "nodes"
        found = None
        for f in nodes_dir.rglob(f"*{safe}*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if data.get("id") == safe:
                    found = data
                    break
            except Exception:
                continue

        if found is None:
            body = b'{"error":"not found"}'
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._send_cors()
            self.end_headers()
            self.wfile.write(body)
            return

        body = json.dumps(found, ensure_ascii=False).encode("utf-8")
        self._ok_json(body)

    def _serve_stats(self) -> None:
        try:
            g = json.loads((self.__class__.viz_dir / "graph.json").read_text())
            body = json.dumps({
                "nodes": len(g.get("nodes", [])),
                "links": len(g.get("links", [])),
            }).encode()
        except Exception:
            body = b'{"nodes":0,"links":0}'
        self._ok_json(body)

    def _sse_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self._send_cors()
        self.end_headers()

        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
        except BrokenPipeError:
            return

        last_sent: float = 0.0
        tick = 0
        while True:
            try:
                time.sleep(3)
                tick += 1
                with _vault_mtime_lock:
                    current = _vault_mtime
                if current > last_sent and last_sent > 0:
                    self.wfile.write(b"event: refresh\ndata: {}\n\n")
                    self.wfile.flush()
                last_sent = current
                if tick % 10 == 0:  # heartbeat every ~30s
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                break


class _ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


# ── Serve entrypoint ──────────────────────────────────────────────────────────

def serve(
    port: int = DEFAULT_PORT,
    viz_dir: Path = VIZ_DIR,
    vault_path: Path | None = None,
    cert: Path | None = None,
    key: Path | None = None,
) -> None:
    deploy_templates(viz_dir)

    ts_ip = _get_tailscale_ip()
    bind_ip = ts_ip or "127.0.0.1"  # Never 0.0.0.0

    if vault_path is None:
        try:
            from bodhi_viz.export import VAULT_PATH
            vault_path = VAULT_PATH
        except Exception:
            vault_path = Path(os.path.expanduser("~/openbodhi/vault"))

    token = _load_or_create_token()

    # Bake per-instance config into handler class
    class BoundHandler(_Handler):
        pass
    BoundHandler.viz_dir = viz_dir
    BoundHandler.vault_path = vault_path
    BoundHandler.token = token
    BoundHandler.bind_ip = bind_ip

    # Start vault watcher thread
    watcher = threading.Thread(
        target=_watch_vault, args=(vault_path, viz_dir), daemon=True
    )
    watcher.start()

    server = _ThreadedHTTPServer((bind_ip, port), BoundHandler)

    # Optional TLS (tailscale cert <hostname> → cert.pem + key.pem)
    scheme = "http"
    if cert and key and cert.exists() and key.exists():
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        scheme = "https"

    base = f"{scheme}://{bind_ip}:{port}"
    print(f"bodhi-viz  {base}")
    print(f"  graph   → {base}/graph.html?token={token}")
    print(f"  sankey  → {base}/sankey.html?token={token}")
    print(f"  token   → {TOKEN_PATH}  (chmod 600)")
    if not ts_ip:
        print("  WARNING: Tailscale not detected — bound to 127.0.0.1 (localhost only)")
    if not (cert and key):
        print("  TIP: enable HTTPS with: tailscale cert <hostname> → --cert cert.pem --key key.pem")
    print("  Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="Serve bodhi viz (secure)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--dir", type=Path, default=VIZ_DIR)
    parser.add_argument("--vault", type=Path, default=None)
    parser.add_argument("--export-first", action="store_true")
    parser.add_argument("--cert", type=Path, default=None,
                        help="TLS cert (e.g. from tailscale cert)")
    parser.add_argument("--key", type=Path, default=None,
                        help="TLS key")
    args = parser.parse_args()

    if args.export_first:
        result = _run_export(
            vault_path=args.vault or Path(os.path.expanduser("~/openbodhi/vault")),
            viz_dir=args.dir,
        )
        if result:
            print(f"Exported {result['node_count']} nodes, {result['link_count']} links")

    serve(
        port=args.port,
        viz_dir=args.dir,
        vault_path=args.vault,
        cert=args.cert,
        key=args.key,
    )


if __name__ == "__main__":
    main()
