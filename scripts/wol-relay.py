#!/usr/bin/env python3
"""
Minimal WoL relay — listens on a Unix socket, sends magic packets on the host
network stack. Designed to be bind-mounted into a rootless container so the
gateway can wake LAN machines without needing UDP broadcast capability.

Security:
  - Unix socket (no TCP, no network exposure)
  - Bearer token auth (WOL_RELAY_TOKEN env var)
  - MAC allowlist (WOL_RELAY_ALLOWED_MACS env var, comma-separated)
  - No shell execution; pure socket operations
"""

import http.server
import json
import os
import signal
import socket
import socketserver
import sys

SOCKET_PATH = os.environ.get(
    "WOL_RELAY_SOCKET", f"/run/user/{os.getuid()}/openclaw-wol.sock"
)
TOKEN = os.environ.get("WOL_RELAY_TOKEN", "")
ALLOWED_MACS = {
    m.strip().lower()
    for m in os.environ.get("WOL_RELAY_ALLOWED_MACS", "").split(",")
    if m.strip()
}


def normalize_mac(mac: str) -> str:
    return mac.replace(":", "").replace("-", "").lower()


def send_magic_packet(mac: str, broadcast: str) -> None:
    mac_bytes = bytes.fromhex(normalize_mac(mac))
    if len(mac_bytes) != 6:
        raise ValueError(f"Invalid MAC: {mac}")
    magic = b"\xff" * 6 + mac_bytes * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.sendto(magic, (broadcast, 9))


class WolHandler(http.server.BaseHTTPRequestHandler):
    """Handle POST /wake requests only."""

    server_version = "wol-relay/1.0"

    def log_message(self, fmt, *args):
        print(f"[wol-relay] {fmt % args}", flush=True)

    def do_POST(self):
        if self.path != "/wake":
            self._reply(404, {"error": "not found"})
            return

        # Auth check
        if not TOKEN:
            self._reply(500, {"error": "WOL_RELAY_TOKEN not configured"})
            return
        auth = self.headers.get("Authorization", "")
        if auth != f"Bearer {TOKEN}":
            self._reply(403, {"error": "forbidden"})
            return

        # Parse body
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except (json.JSONDecodeError, ValueError):
            self._reply(400, {"error": "invalid JSON"})
            return

        mac = body.get("mac", "")
        broadcast = body.get("broadcast", "255.255.255.255")

        if not mac:
            self._reply(400, {"error": "mac required"})
            return

        # Allowlist check
        if ALLOWED_MACS and normalize_mac(mac) not in {
            normalize_mac(m) for m in ALLOWED_MACS
        }:
            self.log_message("Blocked wake for non-allowlisted MAC: %s", mac)
            self._reply(403, {"error": "MAC not in allowlist"})
            return

        # Send the packet
        try:
            send_magic_packet(mac, broadcast)
            self.log_message("Sent WOL to %s via %s", mac, broadcast)
            self._reply(200, {"ok": True, "mac": mac, "broadcast": broadcast})
        except Exception as e:
            self.log_message("Failed to send WOL: %s", e)
            self._reply(500, {"error": str(e)})

    def do_GET(self):
        if self.path == "/health":
            self._reply(200, {"ok": True})
            return
        self._reply(404, {"error": "not found"})

    def _reply(self, code: int, body: dict):
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class UnixSocketServer(socketserver.UnixStreamServer):
    allow_reuse_address = True

    def server_bind(self):
        # Remove stale socket
        if os.path.exists(self.server_address):
            os.unlink(self.server_address)
        super().server_bind()
        os.chmod(self.server_address, 0o660)


class UnixHTTPServer(UnixSocketServer):
    """HTTP server over a Unix stream socket."""

    def get_request(self):
        req, addr = super().get_request()
        # Wrap the raw socket in a makefile-compatible object
        req.settimeout(10)
        return req, addr


def main():
    if not TOKEN:
        print(
            "[wol-relay] ERROR: WOL_RELAY_TOKEN must be set", file=sys.stderr, flush=True
        )
        sys.exit(1)

    if not ALLOWED_MACS:
        print(
            "[wol-relay] WARNING: WOL_RELAY_ALLOWED_MACS is empty — all MACs blocked",
            file=sys.stderr,
            flush=True,
        )

    # Clean shutdown
    def shutdown(signum, frame):
        print(f"[wol-relay] Caught signal {signum}, shutting down", flush=True)
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(f"[wol-relay] Listening on {SOCKET_PATH}", flush=True)
    print(f"[wol-relay] Allowed MACs: {ALLOWED_MACS or '(none — all blocked)'}", flush=True)

    server = UnixHTTPServer(SOCKET_PATH, WolHandler)
    try:
        server.serve_forever()
    finally:
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)


if __name__ == "__main__":
    main()
