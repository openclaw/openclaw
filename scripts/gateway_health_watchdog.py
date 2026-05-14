#!/usr/bin/env python3
"""
gateway_health_watchdog.py — local self-healer for OpenClaw Gateway leak
triad recurrence.

CRUDE / MVP. Ships first, polishes later. No drain, no in-flight check —
that's a follow-up. Trade-off: an active agent run can eat a
`process_lost` on kickstart. Paperclipai's adapter has `idempotencyKey`
so retries dedupe; the cost of a single kicked run is much lower than
the cost of every new wake timing out at WS open.

Triggers (any one fires kickstart):

  T1. WS upgrade probe to ws://127.0.0.1:18789/ does not return 101
      within WS_PROBE_TIMEOUT_S.
  T2. ~/.openclaw/logs/gateway.err.log in the last ERR_LOG_WINDOW_S
      contains any of the leak-triad signatures.

Hysteresis:
  - KICKSTART_COOLDOWN_S between kickstarts (don't flap).
  - KICKSTART_WARMUP_S grace after a fresh gateway start (probe is
    flaky during boot — not a regression).
  - Only count err.log lines newer than the current gateway's PID start
    (stale entries from an earlier process aren't a current signal).
  - If two consecutive ticks both wanted to kickstart but cooldown
    blocked, that's ESCALATION — kickstart isn't recovering it.

State: ~/.openclaw/data/gateway-watchdog-state.json
       (overridable via GATEWAY_WATCHDOG_STATE)
Err log: ~/.openclaw/logs/gateway.err.log
       (overridable via GATEWAY_WATCHDOG_ERR_LOG)

Output (one line per tick — designed for grep):
  HEARTBEAT_OK <subreason>
  KICKSTART <reason>: <detail>
  COOLDOWN <reason>: <detail>
  ESCALATION <reason>: <detail>
  KICKSTART_FAIL <reason>: <error>
  DRY_RUN ...
"""
from __future__ import annotations
import argparse
import base64
import json
import os
import re
import socket
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

GATEWAY_HOST = "127.0.0.1"
GATEWAY_PORT = 18789
GATEWAY_LABEL = "ai.openclaw.gateway"
OPENCLAW_HOME = Path(os.environ.get("OPENCLAW_HOME", Path.home() / ".openclaw"))

ERR_LOG = Path(os.environ.get(
    "GATEWAY_WATCHDOG_ERR_LOG",
    OPENCLAW_HOME / "logs/gateway.err.log",
))
STATE_FILE = Path(os.environ.get(
    "GATEWAY_WATCHDOG_STATE",
    OPENCLAW_HOME / "data/gateway-watchdog-state.json",
))

WS_PROBE_TIMEOUT_S = 10.0
ERR_LOG_WINDOW_S = 60
KICKSTART_COOLDOWN_S = 180  # 3 min — gateway boot to listening can take
                             # 30-60s, full settle 60-90s, plus probe slop;
                             # 60s and 120s were too tight on slow boots
                             # under load (cold-start cascade hit a stuck-
                             # boot loop with the previous values).
# Warmup must exceed the time from launchd-spawn until the gateway binds
# port :18789. Observed cold-boot timeline: T+0 launch → T+15s "loading
# configuration" → T+30s "resolving authentication" → T+30-60s "starting"
# → T+45-90s actually listening. Set warmup well above the worst observed
# bind time to avoid kicking during a slow-but-healthy boot.
KICKSTART_WARMUP_S = 120
# WS-upgrade probe failures are not always a real symptom — empirically,
# a healthy gateway returns 101 in 1.7–12s under varying load. Require
# two consecutive failures before counting as a trigger.
WS_PROBE_FAIL_DEBOUNCE = 2
CONFIG_FILE = Path(os.environ.get(
    "OPENCLAW_CONFIG_PATH",
    OPENCLAW_HOME / "openclaw.json",
))

# HARD signals — kick alone (subject to ws-probe debounce + cooldown).
# These are unambiguous bugs; their presence means the gateway is actively
# degrading and a restart is the right call.
HARD_PATTERNS = [
    (re.compile(r"EADDRINUSE"), "manifest-eaddrinuse"),
    (re.compile(r"releasing lock held for (\d{5,})ms"), "session-write-lock-stall"),
]

# SOFT signal — does NOT kick on its own. Node fires `MaxListenersExceeded`
# exactly once per signal-name per process when the count crosses 10→11, then
# stays silent even as listeners keep growing. Empirically a gateway can serve
# fine for hours past the warning. On 4.23 the warning fires once per gateway
# lifetime (~7-8 min in) but no other triad signature accompanies it; kicking
# on it alone causes more harm (in-flight `process_lost`) than good. Only kick
# if a HARD signal or a ws-probe failure is also present in the same tick.
SOFT_PATTERNS = [
    (re.compile(r"MaxListenersExceededWarning"), "signal-handler-leak"),
]
SOFT_REASONS = {reason for _, reason in SOFT_PATTERNS}

# History notes:
# - `stuck session ... age=Ns` was a trigger but generated false positives on
#   normal long-running LLM calls (`state=processing age=120s+ queueDepth=0`
#   is what the gateway emits for any agent run >100s — tool-use loops, deep
#   thinking, large-context responses). Removed 2026-04-28 (RPAA-1476).
# - `MaxListenersExceededWarning` was a HARD trigger but on 4.23 it fires once
#   per gateway lifetime without other triad signatures, and kicking on it
#   killed live agents mid-LLM-call. Demoted to SOFT 2026-04-28 (RPAA-1476).
# - The 2-strike `ws-upgrade-fail` is treated as HARD — it's classified inline
#   in main() since it's not pattern-driven (the trigger comes from the WS
#   probe, not from err.log scanning).

LOG_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z))")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(tmp, STATE_FILE)


def parse_log_ts(line: str) -> datetime | None:
    m = LOG_TS_RE.match(line)
    if not m:
        return None
    raw = m.group(1)
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _recv_exact(sock: socket.socket, n: int, deadline: float) -> bytes:
    chunks: list[bytes] = []
    remaining = n
    while remaining > 0:
        if time.monotonic() >= deadline:
            raise socket.timeout("deadline while reading websocket frame")
        buf = sock.recv(remaining)
        if not buf:
            raise ConnectionError("socket closed while reading websocket frame")
        chunks.append(buf)
        remaining -= len(buf)
    return b"".join(chunks)


def _read_ws_frame(sock: socket.socket, deadline: float) -> tuple[int, bytes]:
    header = _recv_exact(sock, 2, deadline)
    opcode = header[0] & 0x0F
    length = header[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", _recv_exact(sock, 2, deadline))[0]
    elif length == 127:
        length = struct.unpack("!Q", _recv_exact(sock, 8, deadline))[0]
    masked = bool(header[1] & 0x80)
    mask = _recv_exact(sock, 4, deadline) if masked else b""
    payload = _recv_exact(sock, length, deadline) if length else b""
    if masked and payload:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def _send_ws_frame(sock: socket.socket, opcode: int, payload: bytes = b"") -> None:
    # Client-to-server websocket frames must be masked.
    mask = os.urandom(4)
    length = len(payload)
    if length < 126:
        header = bytes([0x80 | opcode, 0x80 | length])
    elif length <= 0xFFFF:
        header = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack("!H", length)
    else:
        header = bytes([0x80 | opcode, 0x80 | 127]) + struct.pack("!Q", length)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(header + mask + masked)


def _load_gateway_token() -> str | None:
    env_token = os.environ.get("OPENCLAW_GATEWAY_TOKEN")
    if env_token:
        return env_token
    try:
        data = json.loads(CONFIG_FILE.read_text())
    except Exception:
        return None
    token = data.get("gateway", {}).get("auth", {}).get("token")
    return token if isinstance(token, str) and token else None


def probe_ws_upgrade(host: str, port: int, timeout_s: float) -> tuple[bool, str, float]:
    token = _load_gateway_token()
    if not token:
        return False, "missing gateway auth token for websocket handshake probe", 0.0
    request = (
        f"GET / HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"Connection: Upgrade\r\n"
        f"Upgrade: websocket\r\n"
        f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"User-Agent: gateway-health-watchdog/1.0\r\n"
        f"\r\n"
    ).encode()
    start = time.monotonic()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout_s)
    try:
        sock.connect((host, port))
        sock.sendall(request)
        chunks = []
        deadline = start + timeout_s
        while time.monotonic() < deadline:
            try:
                buf = sock.recv(512)
            except socket.timeout:
                break
            if not buf:
                break
            chunks.append(buf)
            if b"\r\n\r\n" in b"".join(chunks):
                break
        elapsed = time.monotonic() - start
        data = b"".join(chunks)
        if not data:
            return False, f"no-response after {elapsed:.2f}s", elapsed
        first_line = data.decode("utf-8", errors="replace").split("\r\n", 1)[0]
        if "101" in first_line and "Switching Protocols" in first_line:
            deadline = start + timeout_s
            # Drain the pre-connect challenge if it arrives, then complete the
            # minimal authenticated gateway handshake. Closing after only the
            # HTTP upgrade leaves the gateway with an unauthenticated client and
            # produces noisy "closed before connect" warnings every watchdog tick.
            try:
                opcode, payload = _read_ws_frame(sock, deadline)
                if opcode == 8:
                    return False, "server closed before connect challenge", time.monotonic() - start
                if opcode != 1:
                    return False, f"unexpected pre-connect opcode={opcode}", time.monotonic() - start
                challenge = json.loads(payload.decode("utf-8", errors="replace"))
                if challenge.get("event") != "connect.challenge":
                    return False, "missing connect.challenge", time.monotonic() - start
                connect_frame = {
                    "type": "req",
                    "id": "gateway-health-watchdog-connect",
                    "method": "connect",
                    "params": {
                        "minProtocol": 3,
                        "maxProtocol": 3,
                        "client": {
                            "id": "gateway-client",
                            "version": "1.0.0",
                            "platform": "macos",
                            "mode": "backend",
                            "displayName": "Gateway Health Watchdog",
                        },
                        "role": "operator",
                        "scopes": ["operator.read"],
                        "caps": [],
                        "commands": [],
                        "permissions": {},
                        "auth": {"token": token},
                        "locale": "en-US",
                        "userAgent": "gateway-health-watchdog/1.0",
                    },
                }
                _send_ws_frame(sock, 1, json.dumps(connect_frame, separators=(",", ":")).encode())
                opcode, payload = _read_ws_frame(sock, deadline)
                if opcode != 1:
                    return False, f"unexpected connect response opcode={opcode}", time.monotonic() - start
                response = json.loads(payload.decode("utf-8", errors="replace"))
                if response.get("ok") is True:
                    _send_ws_frame(sock, 8, struct.pack("!H", 1000))
                    return True, "101 + connect ok", time.monotonic() - start
                error = response.get("error", {})
                code = error.get("code", "unknown")
                message = str(error.get("message", ""))[:80]
                return False, f"connect failed {code}: {message}", time.monotonic() - start
            except Exception as e:
                return False, f"connect-probe error: {type(e).__name__}: {e}", time.monotonic() - start
        return False, f"non-101: {first_line!r}", elapsed
    except socket.timeout:
        return False, f"socket-timeout after {timeout_s:.1f}s", time.monotonic() - start
    except Exception as e:
        return False, f"error: {type(e).__name__}: {e}", time.monotonic() - start
    finally:
        try:
            sock.close()
        except Exception:
            pass


def scan_err_log(path: Path, window_s: int, now: datetime,
                 floor: datetime | None) -> list[tuple[str, str]]:
    if not path.exists():
        return []
    cutoff = now - timedelta(seconds=window_s)
    if floor is not None and floor > cutoff:
        cutoff = floor
    hits: list[tuple[str, str]] = []
    seen: set[str] = set()
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            offset = max(0, size - 200_000)
            f.seek(offset)
            if offset > 0:
                f.readline()
            data = f.read()
    except OSError:
        return []
    all_patterns = HARD_PATTERNS + SOFT_PATTERNS
    for line in data.decode("utf-8", errors="replace").splitlines():
        ts = parse_log_ts(line)
        if ts is None or ts < cutoff:
            continue
        for pat, reason in all_patterns:
            if reason in seen:
                continue
            if pat.search(line):
                hits.append((reason, line[:200]))
                seen.add(reason)
                break
    return hits


def get_gateway_pid() -> int | None:
    patterns = [
        "openclaw/dist/index.js gateway --port 18789",
        "openclaw-gateway",
    ]
    for pattern in patterns:
        try:
            out = subprocess.check_output(
                ["pgrep", "-f", pattern], text=True, timeout=5
            ).strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue
        for line in out.splitlines():
            line = line.strip()
            if line.isdigit():
                return int(line)
    return None


def gateway_started_at(pid: int) -> datetime | None:
    try:
        out = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "lstart="], text=True, timeout=5
        ).strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    if not out:
        return None
    for fmt in ("%a %b %d %H:%M:%S %Y", "%a %b  %d %H:%M:%S %Y"):
        try:
            dt = datetime.strptime(out, fmt)
            return dt.astimezone(timezone.utc)
        except ValueError:
            continue
    return None


def kickstart_gateway(label: str) -> tuple[bool, str]:
    uid = os.getuid()
    cmd = ["launchctl", "kickstart", "-k", f"gui/{uid}/{label}"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return False, "kickstart timed out (15s)"
    out = (proc.stdout + proc.stderr).strip()
    return proc.returncode == 0, out or f"rc={proc.returncode}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--simulate-trigger",
        choices=[r for _, r in HARD_PATTERNS + SOFT_PATTERNS] + ["ws-timeout"],
        help="Force a synthetic trigger (testing only).",
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="Detect triggers and update state, but don't kickstart.")
    args = ap.parse_args()

    now = utcnow()
    state = load_state()
    last_kickstart = None
    if state.get("last_kickstart_at"):
        try:
            last_kickstart = datetime.fromisoformat(
                state["last_kickstart_at"].replace("Z", "+00:00")
            )
        except Exception:
            last_kickstart = None
    last_verdict = state.get("last_verdict", "")

    state["last_check_at"] = now.isoformat()
    gw_pid = get_gateway_pid()
    gw_started = gateway_started_at(gw_pid) if gw_pid else None
    state["gateway_pid"] = gw_pid
    state["gateway_started_at"] = gw_started.isoformat() if gw_started else None

    # Warmup: skip checks while a freshly-restarted gateway is still booting.
    warmup_ref = max(filter(None, [last_kickstart, gw_started]), default=None)
    if (not args.simulate_trigger
            and warmup_ref is not None
            and (now - warmup_ref).total_seconds() < KICKSTART_WARMUP_S):
        # Reset probe-failure counter on warmup so a fresh gateway gets a
        # clean slate. Otherwise old failures from before the kickstart
        # carry forward and one fresh failure after warmup re-trips the
        # debounce immediately.
        state["ws_consecutive_failures"] = 0
        state["last_verdict"] = "WARMING"
        save_state(state)
        age = (now - warmup_ref).total_seconds()
        print(f"HEARTBEAT_OK warming (gateway {age:.0f}s old, <{KICKSTART_WARMUP_S}s)")
        return 0

    # Detect triggers.
    triggers: list[tuple[str, str]] = []
    ws_failures = int(state.get("ws_consecutive_failures", 0))
    ws_flap_note = ""  # appended to HEARTBEAT_OK if probe missed but didn't trigger
    if args.simulate_trigger:
        triggers.append((args.simulate_trigger, "[simulated]"))
        if args.simulate_trigger in ("ws-timeout", "ws-upgrade-fail"):
            ws_failures += 1
    else:
        ok, detail, elapsed = probe_ws_upgrade(GATEWAY_HOST, GATEWAY_PORT, WS_PROBE_TIMEOUT_S)
        if ok:
            ws_failures = 0
        else:
            ws_failures += 1
            if ws_failures >= WS_PROBE_FAIL_DEBOUNCE:
                triggers.append((
                    "ws-upgrade-fail",
                    f"{detail} (elapsed={elapsed:.2f}s, consecutive={ws_failures})",
                ))
            else:
                ws_flap_note = (f" ws_flap=({detail}, elapsed={elapsed:.2f}s, "
                                f"consecutive={ws_failures}/{WS_PROBE_FAIL_DEBOUNCE})")
        # err.log floor: max(now-window, last_kickstart, gw_started). Stale
        # signatures from before the current process aren't a current signal.
        floor = max(filter(None, [last_kickstart, gw_started]),
                    default=now - timedelta(seconds=ERR_LOG_WINDOW_S))
        triggers.extend(scan_err_log(ERR_LOG, ERR_LOG_WINDOW_S, now, floor))
    state["ws_consecutive_failures"] = ws_failures

    if not triggers:
        state["last_verdict"] = "HEARTBEAT_OK"
        save_state(state)
        ws_state = "ok" if ws_failures == 0 else f"flap-{ws_failures}"
        print(f"HEARTBEAT_OK ws={ws_state} err_log_clean{ws_flap_note}")
        return 0

    # Composite gating: SOFT signals alone don't kick. They only kick when
    # paired with a HARD signal in the same tick, OR when the WS probe is
    # also degrading (ws_failures > 0). MaxListenersExceeded by itself on a
    # gateway that's still serving cleanly is not an actionable trigger.
    hard_triggers = [t for t in triggers if t[0] not in SOFT_REASONS]
    soft_triggers = [t for t in triggers if t[0] in SOFT_REASONS]
    if soft_triggers and not hard_triggers and ws_failures == 0:
        soft_summary = "; ".join(f"{r}: {d[:80]}" for r, d in soft_triggers[:3])
        state["last_verdict"] = "SOFT_LEAK_OBSERVED"
        history = state.setdefault("history", [])
        history.append({"ts": now.isoformat(), "verdict": "SOFT_LEAK_OBSERVED",
                        "reason": soft_triggers[0][0], "detail": soft_summary})
        state["history"] = history[-50:]
        save_state(state)
        print(f"SOFT_LEAK_OBSERVED {soft_triggers[0][0]}: {soft_summary} "
              f"(no kick — needs hard signal or probe failure)")
        return 0

    primary = triggers[0][0]
    summary = "; ".join(f"{r}: {d[:80]}" for r, d in triggers[:3])

    cooldown_active = (last_kickstart is not None
                       and (now - last_kickstart).total_seconds() < KICKSTART_COOLDOWN_S)

    history = state.setdefault("history", [])

    if cooldown_active:
        # ESCALATION = two cooldown-blocked ticks in a row, meaning the prior
        # kickstart didn't fix it AND we're still under cooldown. A single
        # COOLDOWN right after a KICKSTART is normal (gateway booting/settling).
        verdict = "ESCALATION" if last_verdict == "COOLDOWN" else "COOLDOWN"
        state["last_verdict"] = verdict
        history.append({"ts": now.isoformat(), "verdict": verdict,
                        "reason": primary, "detail": summary})
        state["history"] = history[-50:]
        save_state(state)
        if verdict == "ESCALATION":
            print(f"ESCALATION {primary}: cooldown blocked TWICE in a row "
                  f"({(now - last_kickstart).total_seconds():.0f}s since last); "
                  f"gateway not recovering. Triggers: {summary}")
            return 2
        print(f"COOLDOWN {primary}: {(now - last_kickstart).total_seconds():.0f}s "
              f"since last kickstart (<{KICKSTART_COOLDOWN_S}s). Triggers: {summary}")
        return 0

    if args.dry_run or args.simulate_trigger:
        state["last_verdict"] = "DRY_RUN"
        history.append({"ts": now.isoformat(), "verdict": "DRY_RUN",
                        "reason": primary, "detail": summary})
        state["history"] = history[-50:]
        save_state(state)
        print(f"DRY_RUN would-kickstart {primary}: {summary}")
        return 0

    ok, kick_out = kickstart_gateway(GATEWAY_LABEL)
    if ok:
        state["last_kickstart_at"] = now.isoformat()
    state["last_verdict"] = "KICKSTART" if ok else "KICKSTART_FAIL"
    history.append({"ts": now.isoformat(),
                    "verdict": "KICKSTART" if ok else "KICKSTART_FAIL",
                    "reason": primary, "detail": summary, "kick_out": kick_out})
    state["history"] = history[-50:]
    save_state(state)
    if ok:
        print(f"KICKSTART {primary}: {summary}")
        return 0
    print(f"KICKSTART_FAIL {primary}: {kick_out} | triggers: {summary}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
