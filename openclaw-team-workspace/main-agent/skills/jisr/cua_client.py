"""
cua_client.py — Self-contained Jisr CUA client for OpenClaw.

Features:
  - UTF-8 sanitization on all strings
  - ask_user param_key normalization
  - result_holder pattern (structured JSON output)
  - Partial step capture on timeout / mid-step connection loss
  - step_results accumulation (per-step iterations with reasoning + info)
  - Connection pre-check via /status endpoint (optional)
  - Service health checks for CUA + browser before task execution
  - Login detection: if the user is not logged in, emits the login link and
    exits immediately instead of blocking until login completes

Requires:
  USER_ID environment variable must be set (no hardcoded fallback).

Usage:
  python3 cua_client.py  --task "Approve all leave requests"

  # Resume after ask_user pause:
  python3 cua_client.py  --task "Approve all leave requests" \
      --resume_state_id "abc123" \
      --user_reply '{"leave_type": "annual"}'

Output:
  Prints one or more JSON objects to stdout. Examples:
    {"success": true, "summary": "...", "total_steps": 3}
    {"success": false, "summary": "...", "error": "...", "ask_user": {...}, "state_id": "..."}
    {"success": false, "error": "login_required", "vnc_url": "..."}
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

import websockets

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_HOST = "localhost"
DEFAULT_WS_PORT = "8882"
DEFAULT_JISR_URL = "https://master-works.jisr.net/"
DEFAULT_CHAT_ID: Optional[str] = os.getenv("USER_ID")


# ---------------------------------------------------------------------------
# JISR context injected into every CUA task
# ---------------------------------------------------------------------------

_JISR_ADDITIONAL_PROMPT = """
You are interacting with JISR, an HR management system used by organizations to manage employees and HR operations.

JISR main sections:
- Home
- Requests
- Employees
- Attendance and Leave:
    - Attendance Tracker
    - Shifts & Scheduling
    - Leave Tracker
- Performance

* For leave request, default type is 'annual'
* The requests has 2 filters type: by date, and by request type
* reason_category_dropdown has only 2 options: Personal or Business
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sanitize_string(text: Any) -> str:
    """Sanitize a value to a clean UTF-8 string."""
    if not text:
        return ""
    try:
        return str(text).encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")
    except Exception:
        return str(text)


def _normalize_param_key(s: Optional[str]) -> Optional[str]:
    """Strip whitespace, quotes, and backslashes from a param_key string."""
    if s is None or not isinstance(s, str):
        return s
    s = str(s).strip().strip(" \t\n\r\"'\\").strip()
    return s if s else None


def _normalize_ask_user_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize param_key so keys never mismatch on resume."""
    if not payload or not isinstance(payload, dict):
        return payload
    out = dict(payload)
    pk = out.get("param_key")
    if pk is not None and isinstance(pk, str):
        out["param_key"] = _normalize_param_key(pk) or None
    return out


def _coerce_arguments(raw: Any) -> Optional[Dict[str, Any]]:
    """Parse tool_use input from string or dict."""
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        if not raw.strip():
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    return None


def _format_log(log_lines: List[str], success: bool) -> str:
    """Join accumulated iteration log lines into the summary string."""
    log = "\n".join(log_lines).strip()
    if success:
        return log
    tail = "Task failed. Let me know if you would like to try again."
    return f"{log}\n\n{tail}".strip() if log else tail


# ---------------------------------------------------------------------------
# Health checks (mirrors JisrStatusWatcher probes — CUA + browser only)
# ---------------------------------------------------------------------------


def _probe_http(url: str, *, timeout: float = 5.0) -> Dict[str, Any]:
    """
    Synchronous HTTP GET probe.
    Returns {"ok": bool, "status_code": int|None, "latency_ms": int, "error": str|None}
    """
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ms = int((time.monotonic() - t0) * 1000)
            ok = 200 <= int(resp.status) < 400
            return {
                "ok": ok,
                "status_code": int(resp.status),
                "latency_ms": ms,
                "error": None if ok else f"http_{resp.status}",
            }
    except urllib.error.HTTPError as exc:
        ms = int((time.monotonic() - t0) * 1000)
        return {"ok": False, "status_code": exc.code, "latency_ms": ms, "error": f"http_{exc.code}"}
    except Exception as exc:
        ms = int((time.monotonic() - t0) * 1000)
        return {"ok": False, "status_code": None, "latency_ms": ms, "error": str(exc)}


def _probe_cua_health(cua_health_url: str) -> Dict[str, Any]:
    """
    Probe the CUA service /health endpoint.
    cua_health_url should point directly to the health check URL,
    e.g. http://localhost:8882/health
    """
    if not cua_health_url:
        return {"ok": False, "status_code": None, "latency_ms": 0, "error": "cua_health_url_not_set"}
    return _probe_http(cua_health_url, timeout=3.0)


def _probe_browser_health(orchestrator_url: str) -> Dict[str, Any]:
    """
    Probe the browser orchestrator /health endpoint.
    Also treats HTTP 200 with {"status": "degraded"} as DOWN
    (indicates Docker is disconnected), mirroring JisrStatusWatcher behaviour.
    """
    if not orchestrator_url:
        return {"ok": False, "status_code": None, "latency_ms": 0, "error": "cua_orchestrator_url_not_set"}

    url = orchestrator_url.rstrip("/") + "/health"
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            ms = int((time.monotonic() - t0) * 1000)
            raw = resp.read().decode("utf-8", errors="ignore")
            status_code = int(resp.status)

            if not (200 <= status_code < 400):
                return {"ok": False, "status_code": status_code, "latency_ms": ms, "error": f"http_{status_code}"}

            # Degraded = Docker disconnected — treat as DOWN
            try:
                body = json.loads(raw)
                if isinstance(body, dict) and body.get("status") == "degraded":
                    return {"ok": False, "status_code": status_code, "latency_ms": ms, "error": "docker_disconnected"}
            except json.JSONDecodeError:
                pass

            return {"ok": True, "status_code": status_code, "latency_ms": ms, "error": None}

    except urllib.error.HTTPError as exc:
        ms = int((time.monotonic() - t0) * 1000)
        return {"ok": False, "status_code": exc.code, "latency_ms": ms, "error": f"http_{exc.code}"}
    except Exception as exc:
        ms = int((time.monotonic() - t0) * 1000)
        return {"ok": False, "status_code": None, "latency_ms": ms, "error": str(exc)}


def _check_services_healthy(
    cua_health_url: str,
    orchestrator_url: str,
) -> Dict[str, Any]:
    """
    Run both health probes and return a combined result.
    Returns:
      {"ok": True, "details": {...}}               — both services healthy
      {"ok": False, "reason": str, "details": {...}} — one or more services down
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        fut_cua = pool.submit(_probe_cua_health, cua_health_url)
        fut_browser = pool.submit(_probe_browser_health, orchestrator_url)
        cua = fut_cua.result()
        browser = fut_browser.result()

    details = {
        "cua_health_ok": cua["ok"],
        "cua_health_status_code": cua["status_code"],
        "cua_health_latency_ms": cua["latency_ms"],
        "cua_health_error": cua["error"],
        "browser_health_ok": browser["ok"],
        "browser_health_status_code": browser["status_code"],
        "browser_health_latency_ms": browser["latency_ms"],
        "browser_health_error": browser["error"],
    }

    if not cua["ok"]:
        return {"ok": False, "reason": "cua_service_unreachable", "details": details}
    if not browser["ok"]:
        return {"ok": False, "reason": "browser_service_unreachable", "details": details}

    return {"ok": True, "details": details}


# ---------------------------------------------------------------------------
# Connection check + login flow
# ---------------------------------------------------------------------------

def _fetch_status(chat_id: str, browser_service_url: str) -> Dict[str, Any]:
    """
    GET {browser_service_url}/cua/{chat_id}/api/status
    Returns {"ok": bool, "connected": bool, "session_alive": bool, "login_completed": bool}
    Mirrors jisr_fetch_status from the server codebase.
    """
    try:
        url = f"{browser_service_url}/cua/{chat_id}/api/status"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            session_alive = bool(data.get("session_alive"))
            login_completed = bool(data.get("login_completed"))
            return {
                "ok": True,
                "connected": session_alive and login_completed,
                "session_alive": session_alive,
                "login_completed": login_completed,
            }
    except urllib.error.HTTPError as e:
        return {"ok": False, "connected": False, "reason": f"http_{e.code}"}
    except Exception as e:
        return {"ok": False, "connected": False, "reason": str(e)}


def _fetch_session_info(chat_id: str, orchestrator_url: str) -> Optional[str]:
    """
    GET {orchestrator_url}/sessions/{chat_id}/info
    Returns the vnc_url from the orchestrator (includes token + path), or None on failure.
    """
    try:
        url = f"{orchestrator_url}/sessions/{chat_id}/info"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return data.get("vnc_url") or None
    except Exception as e:
        print(f"[WARNING] Could not fetch session info: {e}.", file=sys.stderr)
        return None


def _start_orchestrator_session(chat_id: str, orchestrator_url: str) -> Optional[str]:
    """
    POST /sessions/start — spins up the browser container.
    Returns vnc_url on success, None on failure.
    chat_id is coerced to int if numeric (orchestrator requires it).
    """
    try:
        try:
            cid: Any = int(chat_id)
        except (ValueError, TypeError):
            cid = chat_id

        body = json.dumps({"chat_id": cid}).encode("utf-8")
        req = urllib.request.Request(
            f"{orchestrator_url}/sessions/start",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data.get("vnc_url")
    except urllib.error.HTTPError as e:
        print(
            f"[WARNING] Orchestrator /sessions/start returned HTTP {e.code}.",
            file=sys.stderr,
        )
        return None
    except Exception as e:
        print(f"[WARNING] Could not reach orchestrator: {e}.", file=sys.stderr)
        return None


def _ensure_connected(
    chat_id: str,
    browser_service_url: str,
    orchestrator_url: str,
) -> Dict[str, Any]:
    """
    Connection flow:
      1. Check if already connected (session_alive + login_completed).
      2. If not, start the browser session and emit the login link.

    Returns:
      {"ok": True, "vnc_url": "..."}                    — connected and ready
      {"ok": False, "reason": "login_required", ...}    — session started, user must log in
      {"ok": False, "reason": "...", ...}                — connection error
    """
    # Step 1 — already connected?
    status = _fetch_status(chat_id, browser_service_url)
    if status.get("connected"):
        print("[CUA] Already connected to Jisr.", file=sys.stderr)
        vnc_url = (
            _fetch_session_info(chat_id, orchestrator_url)
            or f"{browser_service_url}/cua/{chat_id}/vnc/vnc_auto.html"
        )
        return {"ok": True, "vnc_url": vnc_url}

    print("[CUA] Not connected. Starting browser session...", file=sys.stderr)

    # Step 2 — start session and surface login link; do not block
    _start_orchestrator_session(chat_id, orchestrator_url)
    vnc_url = (
        _fetch_session_info(chat_id, orchestrator_url)
        or f"{browser_service_url}/cua/{chat_id}/vnc/vnc_auto.html"
    )

    print(
        f"\n{'='*60}\n"
        f"  ACTION REQUIRED: Please log in to Jisr\n"
        f"{'='*60}\n"
        f"  Open this link in your browser to see the virtual screen:\n"
        f"  👉 {vnc_url}\n\n"
        f"{'='*60}\n",
        file=sys.stderr,
    )

    # Emit structured JSON so OpenClaw can surface the login link to the user
    print(
        json.dumps({
            "status": "login_required",
            "message": "You are not logged in to Jisr. Please log in using the link below.",
            "vnc_url": vnc_url,
        }),
        flush=True,
    )

    return {"ok": False, "reason": "login_required", "vnc_url": vnc_url}


# ---------------------------------------------------------------------------
# Core WebSocket runner
# ---------------------------------------------------------------------------


async def _run_jisr_task_ws(
    chat_id: str,
    task: str,
    result_holder: Dict[str, Any],
    ws_url: str,
    jisr_url: str,
    user_reply: Optional[Dict[str, str]] = None,
    resume_state_id: Optional[str] = None,
) -> None:
    """Connect to the CUA WebSocket service, stream results, populate result_holder."""
    step_results: List[Dict[str, Any]] = []
    log_lines: List[str] = []
    total_steps = 0
    task_completed = False
    stored_ask_user: Optional[Dict[str, Any]] = None

    current_step_number: Optional[int] = None
    current_step_description: Optional[str] = None
    current_step_iterations: List[Dict[str, Any]] = []

    try:
        async with websockets.connect(
            ws_url,
            ping_interval=30,
            ping_timeout=60,
            close_timeout=10,
        ) as ws:
            payload: Dict[str, Any] = {
                "type": "start",
                "chat_id": chat_id,
                "user_goal": task,
                "url": jisr_url,
                "page_context": "home",
                "additional_context": _JISR_ADDITIONAL_PROMPT,
            }
            if user_reply:
                payload["user_reply"] = user_reply
            if resume_state_id:
                payload["resume_state_id"] = resume_state_id

            await ws.send(json.dumps(payload))
            print(f"[CUA] Connected to {ws_url}. Task sent.", file=sys.stderr)

            async for raw_message in ws:
                try:
                    if isinstance(raw_message, bytes):
                        raw_message = raw_message.decode("utf-8", errors="ignore")

                    data = json.loads(raw_message)
                    msg_type = data.get("type", "")

                    # ---- plan_created ----
                    if msg_type == "plan_created":
                        total_steps = data.get("total_steps", 0)
                        print(f"[CUA] Plan created: {total_steps} steps", file=sys.stderr)

                    # ---- step_started ----
                    elif msg_type == "step_started":
                        current_step_number = data.get("step_number")
                        current_step_description = _sanitize_string(
                            data.get("step_description", "")
                        )
                        current_step_iterations = []
                        log_lines.append(
                            f"\n=== Step {current_step_number}/{total_steps}: "
                            f"{current_step_description} ==="
                        )

                    # ---- iteration_update ----
                    elif msg_type == "iteration_update":
                        step_num = data.get("step_number")
                        iteration = data.get("iteration")
                        action = _sanitize_string(data.get("action", ""))
                        reasoning = _sanitize_string(data.get("reasoning", ""))
                        info = _sanitize_string(data.get("info", ""))

                        if step_num == current_step_number:
                            current_step_iterations.append(
                                {
                                    "iteration": iteration,
                                    "action": action,
                                    "reasoning": reasoning or f"Performed {action}",
                                    "info": info,
                                }
                            )

                        line = f"  Iter {iteration} [{action}]: {reasoning}"
                        if info:
                            line += f" | Info: {info}"
                        log_lines.append(line)

                    # ---- step_completed ----
                    elif msg_type == "step_completed":
                        step_num = data.get("step_number")
                        is_partial = data.get("partial", False)
                        step_results.append(
                            {
                                "step": step_num,
                                "description": current_step_description,
                                "total_iterations": data.get("total_iterations", 0),
                                "partial": is_partial,
                                "iterations": current_step_iterations.copy(),
                            }
                        )
                        current_step_iterations = []

                    # ---- ask_user ----
                    elif msg_type == "ask_user":
                        stored_ask_user = _normalize_ask_user_payload(
                            {
                                "question": data.get("question", ""),
                                "param_key": data.get("param_key"),
                                "options": data.get("options"),
                                "step_index": data.get("step_index"),
                            }
                        )
                        # Drop None values
                        stored_ask_user = {
                            k: v for k, v in stored_ask_user.items() if v is not None
                        }
                        print(
                            f"\n[PAUSED] CUA needs input: {stored_ask_user.get('question')}",
                            file=sys.stderr,
                        )

                    # ---- complete ----
                    elif msg_type == "complete":
                        task_completed = True
                        success = data.get("success", True)
                        state_id = data.get("state_id")
                        if state_id:
                            result_holder["state_id"] = state_id

                        # Merge ask_user from complete message if present
                        ask_user_from_complete = data.get("ask_user")
                        if ask_user_from_complete is not None:
                            ask_user_from_complete = _normalize_ask_user_payload(
                                ask_user_from_complete
                            )
                            stored_ask_user = ask_user_from_complete

                        if stored_ask_user is not None:
                            result_holder["ask_user"] = stored_ask_user
                            result_holder["success"] = False
                            result_holder["summary"] = "Task paused: user input required."
                            result_holder["total_steps"] = total_steps
                        else:
                            result_holder["success"] = success
                            result_holder["summary"] = _format_log(log_lines, success)
                            result_holder["total_steps"] = total_steps
                            result_holder["step_results"] = step_results
                        break

                    # ---- error ----
                    elif msg_type == "error":
                        task_completed = True
                        error_msg = _sanitize_string(data.get("message", "Unknown error"))
                        log_lines.append(f"\nError: {error_msg}")
                        result_holder["success"] = False
                        result_holder["summary"] = _format_log(log_lines, False)
                        result_holder["error"] = error_msg
                        result_holder["step_results"] = step_results
                        break

                except json.JSONDecodeError as exc:
                    print(f"[WARNING] Invalid JSON from CUA: {exc}", file=sys.stderr)
                except Exception as exc:
                    print(f"[WARNING] Error processing message: {exc}", file=sys.stderr)

    except websockets.exceptions.ConnectionClosedError as exc:
        # Task already finished cleanly — keepalive timeout during cleanup is safe to ignore
        if task_completed:
            return

        # Task was paused waiting for user input
        if stored_ask_user is not None:
            result_holder["ask_user"] = stored_ask_user
            result_holder["success"] = False
            result_holder["summary"] = "Task paused: user input required."
            result_holder["total_steps"] = total_steps
            return

        # Capture any in-progress step before reporting
        if current_step_number and current_step_iterations:
            step_results.append(
                {
                    "step": current_step_number,
                    "description": current_step_description,
                    "total_iterations": len(current_step_iterations),
                    "partial": True,
                    "iterations": current_step_iterations.copy(),
                }
            )

        is_keepalive = "keepalive ping timeout" in str(exc) or "no close frame received" in str(exc)
        error_msg = (
            "Connection timeout — task did not complete, only partial results received."
            if is_keepalive
            else str(exc)
        )

        log_lines.append(f"\nError: {error_msg}")
        result_holder["success"] = False
        result_holder["summary"] = _format_log(log_lines, False)
        result_holder["error"] = "websocket_timeout" if is_keepalive else str(exc)
        result_holder["step_results"] = step_results
        if is_keepalive:
            result_holder["partial"] = True

    except Exception as exc:
        if task_completed:
            return

        # Capture any in-progress step
        if current_step_number and current_step_iterations:
            step_results.append(
                {
                    "step": current_step_number,
                    "description": current_step_description,
                    "total_iterations": len(current_step_iterations),
                    "partial": True,
                    "iterations": current_step_iterations.copy(),
                }
            )

        log_lines.append(f"\nError: {exc}")
        result_holder["success"] = False
        result_holder["summary"] = _format_log(log_lines, False)
        result_holder["error"] = str(exc)
        result_holder["step_results"] = step_results


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def run_cua_task(
    host: str,
    port: str,
    chat_id: str,
    task: str,
    jisr_url: str,
    resume_state_id: Optional[str] = None,
    user_reply: Optional[Dict[str, str]] = None,
    skip_status_check: bool = False,
) -> Dict[str, Any]:
    ws_url = os.getenv(
        "CUA_SERVICE_WEBSOCKET", f"ws://{host}:{port}/ws/run-agent"
    )
    browser_service_url = os.getenv("BROWSER_SERVICE_URL", f"http://{host}:7002")
    orchestrator_url = os.getenv("CUA_ORCHESTRATOR_URL", f"http://{host}:9000")
    cua_health_url = os.getenv("CUA_HEALTH_URL", f"http://{host}:{port}/health")

    # --- Service health pre-check ---
    health = _check_services_healthy(cua_health_url, orchestrator_url)
    if not health["ok"]:
        print(f"[CUA] Health check failed: {health['reason']}", file=sys.stderr)
        return {
            "success": False,
            "summary": "Services are not ready yet. Please try again later.",
            "error": "services_unavailable",
        }
    print(
        f"[CUA] Health OK — CUA {health['details']['cua_health_latency_ms']}ms, "
        f"browser {health['details']['browser_health_latency_ms']}ms",
        file=sys.stderr,
    )

    # --- Connection check + login gate ---
    if not skip_status_check:
        conn = _ensure_connected(chat_id, browser_service_url, orchestrator_url)
        if not conn["ok"]:
            if conn.get("reason") == "login_required":
                return {
                    "success": False,
                    "summary": "You are not logged in to Jisr. Please log in using the link provided.",
                    "error": "login_required",
                    "vnc_url": conn.get("vnc_url"),
                }
            return {
                "success": False,
                "summary": f"Could not connect to Jisr: {conn.get('reason')}",
                "error": conn.get("reason", "connection_failed"),
            }
        vnc_url = conn["vnc_url"]
    else:
        vnc_url = (
            _fetch_session_info(chat_id, orchestrator_url)
            or f"{browser_service_url}/cua/{chat_id}/vnc/vnc_auto.html"
        )

    print(f"\n[LIVE VIEW] Watch the browser at:\n👉 {vnc_url}\n", file=sys.stderr)

    # Notify the calling agent that the task is starting so it knows to wait
    print(
        json.dumps({
            "status": "task_starting",
            "message": f"Starting task '{task}', please wait…",
            "task": task,
        }),
        flush=True,
    )

    # --- Run the task ---
    result_holder: Dict[str, Any] = {}
    await asyncio.wait_for(
        _run_jisr_task_ws(
            chat_id=chat_id,
            task=task,
            result_holder=result_holder,
            ws_url=ws_url,
            jisr_url=jisr_url,
            user_reply=user_reply,
            resume_state_id=resume_state_id,
        ),
        timeout=300,
    )

    if not result_holder:
        return {
            "success": False,
            "summary": "Browser task completed but no result was returned.",
            "error": "no_result",
        }

    return result_holder


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_user_reply(raw: Optional[str]) -> Optional[Dict[str, str]]:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
        print("[WARNING] --user_reply must be a JSON object; ignoring.", file=sys.stderr)
        return None
    except json.JSONDecodeError as exc:
        print(f"[WARNING] Could not parse --user_reply JSON: {exc}; ignoring.", file=sys.stderr)
        return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Jisr CUA client for OpenClaw — outputs structured JSON to stdout."
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help="CUA service host")
    parser.add_argument("--port", default=DEFAULT_WS_PORT, help="CUA WebSocket port")
    parser.add_argument("--task", required=True, help="Task description in plain English")
    parser.add_argument(
        "--url", default=DEFAULT_JISR_URL, help="Target URL (default: Jisr main page)"
    )
    parser.add_argument(
        "--resume_state_id", default=None, help="State ID to resume a paused task"
    )
    parser.add_argument(
        "--user_reply",
        default=None,
        help='JSON string map answering a previous ask_user, e.g. \'{"leave_type": "annual"}\'',
    )
    parser.add_argument(
        "--skip_status_check",
        action="store_true",
        help="Skip the Jisr connection pre-check",
    )
    parser.add_argument(
        "--raw",
        action="store_true",
        help="Print human-readable output instead of JSON (useful for manual testing)",
    )
    args = parser.parse_args()

    if not DEFAULT_CHAT_ID:
        print(
            json.dumps({
                "success": False,
                "summary": "USER_ID environment variable is not set.",
                "error": "missing_user_id",
            })
        )
        sys.exit(1)

    user_reply = _parse_user_reply(args.user_reply)

    try:
        result = asyncio.run(
            run_cua_task(
                host=args.host,
                port=args.port,
                chat_id=DEFAULT_CHAT_ID,
                task=args.task,
                jisr_url=args.url,
                resume_state_id=args.resume_state_id,
                user_reply=user_reply,
                skip_status_check=args.skip_status_check,
            )
        )
    except asyncio.TimeoutError:
        result = {
            "success": False,
            "summary": "Browser task timed out after 5 minutes.",
            "error": "timeout",
        }
    except Exception as exc:
        result = {
            "success": False,
            "summary": f"Failed to execute browser task: {exc}",
            "error": str(exc),
        }

    if args.raw:
        # Human-readable output for manual testing
        success_icon = "✅" if result.get("success") else "❌"
        print(f"\n{success_icon} {result.get('summary', 'No summary')}")
        if result.get("ask_user"):
            au = result["ask_user"]
            print(f"\n[PAUSED - NEED HUMAN INPUT]")
            print(f"Question : {au.get('question')}")
            print(f"Options  : {au.get('options')}")
            print(f"Param Key: {au.get('param_key')}")
        if result.get("state_id"):
            print(f"State ID : {result['state_id']}")
        if result.get("error") and result["error"] not in ("not_connected", "timeout", "no_result"):
            print(f"Error    : {result['error']}")
    else:
        # Structured JSON output — this is what OpenClaw's agent reads
        print(json.dumps(result, ensure_ascii=False))
