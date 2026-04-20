"""Async RBAC proxy with HTTP + WebSocket support."""
import asyncio, json, urllib.parse, time, hmac
from collections import defaultdict
from openclaw_guard.config import load_config, hash_token
from openclaw_guard.audit import AuditLog
from openclaw_guard.masking import mask_body
from openclaw_guard.permissions import check_permission

_cfg = None
_audit = None
_rate_limiter = None


class RateLimiter:
    """Token-bucket rate limiter per source IP."""

    def __init__(self, cfg):
        rl = cfg.get("rate_limit", {})
        self.enabled = rl.get("enabled", True)
        self.window = rl.get("window_seconds", 60)
        self.max_attempts = rl.get("max_attempts", 20)
        self.lockout = rl.get("lockout_seconds", 300)
        self._failures = defaultdict(list)  # ip -> [timestamps]
        self._locked = {}  # ip -> unlock_time

    def check(self, ip):
        if not self.enabled:
            return True
        now = time.monotonic()
        if ip in self._locked:
            if now < self._locked[ip]:
                return False
            del self._locked[ip]
        # Clean old entries
        self._failures[ip] = [t for t in self._failures[ip] if now - t < self.window]
        return len(self._failures[ip]) < self.max_attempts

    def record_failure(self, ip):
        if not self.enabled:
            return
        now = time.monotonic()
        self._failures[ip].append(now)
        if len(self._failures[ip]) >= self.max_attempts:
            self._locked[ip] = now + self.lockout
            self._failures[ip] = []


def _auth(headers):
    token = headers.get("x-guard-token", "")
    if not token:
        return None
    th = hash_token(token)
    # Constant-time lookup: iterate all to prevent timing leak
    for stored_hash, user in _cfg["_user_index"].items():
        if hmac.compare_digest(th, stored_hash):
            return user
    return None


def _get_mask_fields(role_name):
    return _cfg.get("roles", {}).get(role_name, {}).get("mask_fields", [])


def _parse_headers(raw):
    headers = {}
    method = path = version = ""
    lines = raw.split(b"\r\n")
    if lines:
        parts = lines[0].decode(errors="replace").split(" ", 2)
        if len(parts) == 3:
            method, path, version = parts
    for line in lines[1:]:
        if b":" in line:
            k, v = line.decode(errors="replace").split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return method, path, version, headers


async def _read_until(reader, sep=b"\r\n\r\n", max_size=None, timeout=None):
    """Read until separator found, with size and time limits."""
    max_size = max_size or _cfg["gateway"].get("max_header_size", 16384)
    timeout = timeout or _cfg["gateway"].get("request_timeout", 30)
    buf = b""
    try:
        async with asyncio.timeout(timeout):
            while sep not in buf:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > max_size:
                    raise ValueError("Request too large")
    except TimeoutError:
        raise ValueError("Request timeout")
    return buf


async def _forward_bytes(reader, writer):
    try:
        while True:
            data = await reader.read(8192)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def _err_response(code, msg):
    body = json.dumps({"error": msg}).encode()
    return (f"HTTP/1.1 {code}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode() + body


def _whoami_response(user):
    body = json.dumps({"name": user["name"], "role": user["role"]}).encode()
    return (f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n\r\n").encode() + body


def _get_client_ip(writer):
    try:
        return writer.get_extra_info("peername", ("unknown",))[0]
    except Exception:
        return "unknown"


async def _handle_websocket(client_r, client_w, path, headers, user):
    up = urllib.parse.urlparse(_cfg["gateway"]["upstream"])
    up_host = up.hostname
    up_port = up.port or 80

    try:
        up_r, up_w = await asyncio.wait_for(
            asyncio.open_connection(up_host, up_port), timeout=10)
    except Exception:
        client_w.write(_err_response(502, "Upstream unavailable"))
        await client_w.drain()
        return

    fwd_lines = [f"GET {path} HTTP/1.1"]
    for k, v in headers.items():
        if k == "x-guard-token":
            continue
        fwd_lines.append(f"{k}: {v}")
    fwd_lines.append("")
    fwd_lines.append("")
    up_w.write("\r\n".join(fwd_lines).encode())
    await up_w.drain()

    up_resp = await _read_until(up_r)
    client_w.write(up_resp)
    await client_w.drain()

    if b"101" not in up_resp.split(b"\r\n")[0]:
        await _audit.log(user["name"], "WS", path, "upstream_rejected")
        return

    await _audit.log(user["name"], "WS", path, "ok")

    t1 = asyncio.create_task(_forward_bytes(client_r, up_w))
    t2 = asyncio.create_task(_forward_bytes(up_r, client_w))
    await asyncio.gather(t1, t2, return_exceptions=True)


async def _handle_http(client_w, method, path, version, headers, body, user):
    up = urllib.parse.urlparse(_cfg["gateway"]["upstream"])
    up_host = up.hostname
    up_port = up.port or 80

    try:
        up_r, up_w = await asyncio.wait_for(
            asyncio.open_connection(up_host, up_port), timeout=10)
    except Exception:
        client_w.write(_err_response(502, "Upstream unavailable"))
        await client_w.drain()
        return

    fwd_lines = [f"{method} {path} {version}"]
    for k, v in headers.items():
        if k == "x-guard-token":
            continue
        if k == "host":
            v = f"{up_host}:{up_port}"
        fwd_lines.append(f"{k}: {v}")
    fwd_req = "\r\n".join(fwd_lines).encode() + b"\r\n\r\n"
    if body:
        fwd_req += body

    up_w.write(fwd_req)
    await up_w.drain()

    resp_hdr = await _read_until(up_r)
    hdr_text = resp_hdr.decode(errors="replace")
    cl_match = next((h for h in hdr_text.split("\r\n")
                     if h.lower().startswith("content-length:")), None)
    max_body = _cfg["gateway"].get("max_body_size", 10 * 1024 * 1024)
    body_part = b""
    if cl_match:
        expected = int(cl_match.split(":", 1)[1].strip())
        if expected > max_body:
            client_w.write(_err_response(502, "Response too large"))
            await client_w.drain()
            up_w.close()
            return
        while len(body_part) < expected:
            chunk = await up_r.read(min(65536, expected - len(body_part)))
            if not chunk:
                break
            body_part += chunk
    else:
        while True:
            try:
                chunk = await asyncio.wait_for(up_r.read(65536), timeout=5.0)
                if not chunk:
                    break
                body_part += chunk
                if len(body_part) > max_body:
                    break
            except asyncio.TimeoutError:
                break
    resp = resp_hdr + body_part

    mask_fields = _get_mask_fields(user["role"])
    if mask_fields and b"\r\n\r\n" in resp:
        hdr_part, body_part = resp.split(b"\r\n\r\n", 1)
        # Extract content-type to avoid corrupting binary responses
        ct_match = next((h for h in hdr_part.decode(errors="replace").split("\r\n")
                         if h.lower().startswith("content-type:")), "")
        content_type = ct_match.split(":", 1)[1].strip() if ct_match else ""
        body_part = mask_body(body_part, mask_fields, content_type)
        hdr_lines = hdr_part.decode(errors="replace").split("\r\n")
        new_hdrs = []
        for h in hdr_lines:
            if h.lower().startswith("content-length:"):
                new_hdrs.append(f"Content-Length: {len(body_part)}")
            else:
                new_hdrs.append(h)
        resp = "\r\n".join(new_hdrs).encode() + b"\r\n\r\n" + body_part

    await _audit.log(user["name"], method, path, "ok")
    client_w.write(resp)
    await client_w.drain()
    up_w.close()


async def _handle_client(reader, writer):
    client_ip = _get_client_ip(writer)
    try:
        # Rate limit check
        if not _rate_limiter.check(client_ip):
            writer.write(_err_response(429, "Too many requests"))
            await writer.drain()
            return

        raw = await _read_until(reader)
        if not raw:
            return

        if b"\r\n\r\n" in raw:
            header_part, body = raw.split(b"\r\n\r\n", 1)
        else:
            header_part, body = raw, b""

        hdr_text = header_part.decode(errors="replace")
        cl_match = next((h for h in hdr_text.split("\r\n")
                         if h.lower().startswith("content-length:")), None)
        if cl_match:
            expected = int(cl_match.split(":", 1)[1].strip())
            max_body = _cfg["gateway"].get("max_body_size", 10 * 1024 * 1024)
            if expected > max_body:
                writer.write(_err_response(413, "Request body too large"))
                await writer.drain()
                return
            body_timeout = _cfg["gateway"].get("request_timeout", 30)
            try:
                async with asyncio.timeout(body_timeout):
                    while len(body) < expected:
                        chunk = await reader.read(expected - len(body))
                        if not chunk:
                            break
                        body += chunk
            except TimeoutError:
                writer.write(_err_response(408, "Request body read timeout"))
                await writer.drain()
                return

        method, path, version, headers = _parse_headers(header_part)

        # Auth
        user = _auth(headers)
        if not user:
            _rate_limiter.record_failure(client_ip)
            await _audit.log("anonymous", method or "?", path or "/", "auth_failed",
                       detail=f"ip={client_ip}")
            writer.write(_err_response(401, "Unauthorized"))
            await writer.drain()
            return

        # /whoami
        if path == "/whoami":
            writer.write(_whoami_response(user))
            await writer.drain()
            return

        # Permission check
        if not check_permission(_cfg.get("roles", {}), user["role"], path):
            await _audit.log(user["name"], method, path, "denied")
            writer.write(_err_response(403, "Forbidden"))
            await writer.drain()
            return

        # WebSocket upgrade?
        upgrade = headers.get("upgrade", "").lower()
        if upgrade == "websocket":
            await _handle_websocket(reader, writer, path, headers, user)
        else:
            await _handle_http(writer, method, path, version, headers, body, user)

    except ValueError as e:
        # Controlled errors (timeout, too large)
        try:
            writer.write(_err_response(400, str(e)))
            await writer.drain()
        except Exception:
            pass
    except Exception:
        try:
            writer.write(_err_response(500, "Internal server error"))
            await writer.drain()
        except Exception:
            pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def _run(host, port):
    server = await asyncio.start_server(_handle_client, host, port)
    upstream = _cfg["gateway"]["upstream"]
    n = len(_cfg.get("users", []))
    audit_status = "on" if _audit.enabled else "off"
    rl_status = "on" if _rate_limiter.enabled else "off"
    print(f"openclaw-guard listening on {host}:{port} → {upstream}")
    print(f"  {n} users, audit={audit_status}, rate_limit={rl_status}")
    async with server:
        await server.serve_forever()


def start_proxy(config_path, port_override=None):
    global _cfg, _audit, _rate_limiter
    _cfg = load_config(config_path)
    _audit = AuditLog(_cfg)
    _rate_limiter = RateLimiter(_cfg)
    host = _cfg["gateway"]["listen"]
    port = port_override or _cfg["gateway"]["port"]
    asyncio.run(_run(host, port))
