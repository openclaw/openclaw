#!/usr/bin/env python3
"""rockie-loop — the daemon that makes Rockie "never sleep".

Per-tenant Fly machine background process. Wakes on an adaptive
schedule (every 30s when work is active, every 5m when idle), reads
loop state from platform-context, and decides what to do this
iteration:

  1. If user-paused or auto-paused (credit < $1): record `paused` /
     `credit_low` iteration, sleep, repeat.
  2. If there's an in-flight experiment, poll its job status. If
     done, transition the queue row to done/failed.
  3. If the queue is non-empty and no experiment is running, pop
     the highest-priority queued row. Fixed `gpu_smoke` rows launch
     through the GPU broker; other rows use `experiment_submit`.
  4. If the queue is shallow (depth < 3) and we're not paused,
     run an "idle planning" pass — proposes 1-3 candidate
     experiments via the broker `/chat-pty` LLM substrate, queues
     the ones that pass adversarial review.

Every iteration records a `loop_iteration` row and (on meaningful
work) emits a chat-channel artifact so the user sees narration on
re-login.

Multi-lab: a single daemon process serves ALL labs owned by the
tenant. Each wake, it iterates labs and picks the one with the
freshest queue activity. The lab list comes from
`GET /api/notebooks?tenant=...` (the existing notebook router).

Reads two env vars set by `overlay/multitenant/entrypoint.sh`:

  ROCKIELAB_API_BASE        — e.g. https://api.rockielab.com
  ROCKIELAB_TENANT_TOKEN    — passed as X-Tenant-Token for auth
  ROCKIELAB_TENANT_DEV_TOKEN — compatibility alias for the same auth token
  ROCKIELAB_TENANT_ID       — passed as X-Tenant-Id for tenant scope

And the broker is on localhost (same Fly machine):

  BROKER_PORT               — default 7681
  BROKER_TENANT_TOKEN       — for /chat-pty auth

CLI:

  rockie-loop run         — start the daemon (default)
  rockie-loop iter        — run a single iteration + exit
  rockie-loop status      — print the current loop state JSON for ALL
                            labs owned by this tenant + exit.
  rockie-loop --help

Exit codes:
  0   normal exit (SIGTERM)
  1   network error talking to platform-context
  2   bad argv / usage
  3   server returned HTTP 4xx
  4   server returned HTTP 5xx
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


DEFAULT_API_BASE = os.environ.get(
    "ROCKIELAB_API_BASE", "https://api.rockielab.com"
)
TENANT_TOKEN = (
    os.environ.get("ROCKIELAB_TENANT_TOKEN")
    or os.environ.get("ROCKIELAB_TENANT_DEV_TOKEN")
    or ""
).strip()
TENANT_ID = os.environ.get("ROCKIELAB_TENANT_ID", "").strip()
# Bearer for PasswordAuthMiddleware on platform-context. Mirrors the
# env-var fallback chain mcp-rockie uses.
API_PASSWORD = os.environ.get("ROCKIELAB_API_PASSWORD") or os.environ.get(
    "OPEN_NOTEBOOK_PASSWORD", ""
)
BROKER_PORT = int(os.environ.get("BROKER_PORT", "7681"))
BROKER_TENANT_TOKEN = os.environ.get("BROKER_TENANT_TOKEN", "")
RUNTIME_MODE = os.environ.get("MODE", "subscription")

# Sleep schedule — must mirror api/services/loop_service.py constants.
# Authoritative source is the service; these are fall-back defaults
# used if /loop-state ever omits `sleep_seconds`.
ACTIVE_SLEEP_SECONDS = 30
IDLE_SLEEP_SECONDS = 300

# Idle planning: only trigger when queue depth is below this threshold.
IDLE_PLAN_QUEUE_DEPTH = 3
GPU_SMOKE_TYPES = {"A40_48GB", "A100_80GB"}
GPU_SMOKE_MAX_HOURS = 0.25

# Stop sentinel — flipped by SIGTERM / SIGINT handlers.
_STOP = False


def _handle_stop(signum, frame):  # noqa: ANN001
    global _STOP
    _STOP = True


# ---------------------------------------------------------------------------
# HTTP helper — stdlib only
# ---------------------------------------------------------------------------


class CLIError(Exception):
    def __init__(self, message: str, exit_code: int = 1):
        super().__init__(message)
        self.exit_code = exit_code


def _build_request(
    method: str,
    path: str,
    body: Optional[dict] = None,
    *,
    base: Optional[str] = None,
    token: Optional[str] = None,
) -> urllib.request.Request:
    base_url = base or DEFAULT_API_BASE
    url = f"{base_url.rstrip('/')}{path}"
    # Cloudflare in front of api.rockielab.com bot-blocks Python's
    # default `Python-urllib/3.x` User-Agent (Error 1010: browser
    # signature banned), which silently breaks lab discovery and every
    # subsequent /loop-state call. Identify as a real client.
    headers = {
        "Accept": "application/json",
        "User-Agent": "rockie-loop/1.0",
    }
    # PasswordAuthMiddleware on platform-context requires a Bearer
    # header on every authenticated request. The daemon authenticates
    # at the global layer with the API password and at the tenant
    # layer with X-Tenant-Token. Without Authorization every call 401s
    # with "Missing authorization header" before X-Tenant-Token is
    # even consulted. Mirrors mcp-rockie/server.js.
    # NOTE 2026-05-12: ROCKIELAB_API_PASSWORD is NOT staged in tenant
    # Fly secrets today. Until provisioning sets it (task #63), the
    # daemon's authenticated calls still 401. The Bearer wiring here
    # is half of the fix; the other half is server-side.
    if API_PASSWORD:
        headers["Authorization"] = f"Bearer {API_PASSWORD}"
    token = token if token is not None else TENANT_TOKEN
    if not token:
        raise CLIError(
            "ROCKIELAB_TENANT_TOKEN or ROCKIELAB_TENANT_DEV_TOKEN is required",
            exit_code=2,
        )
    if not TENANT_ID:
        raise CLIError("ROCKIELAB_TENANT_ID is required", exit_code=2)
    headers["X-Tenant-Token"] = token
    headers["X-Tenant-Id"] = TENANT_ID
    data: Optional[bytes] = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    return urllib.request.Request(
        url, data=data, headers=headers, method=method
    )


def _http(
    method: str,
    path: str,
    body: Optional[dict] = None,
    *,
    base: Optional[str] = None,
    token: Optional[str] = None,
    timeout: int = 30,
) -> Any:
    req = _build_request(method, path, body, base=base, token=token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8")) if raw else None
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            payload = {"detail": str(e)}
        code = 3 if 400 <= e.code < 500 else 4
        raise CLIError(
            f"HTTP {e.code} on {path}: {json.dumps(payload)}",
            exit_code=code,
        ) from e
    except urllib.error.URLError as e:
        raise CLIError(
            f"Network error on {path}: {e.reason}", exit_code=1
        ) from e


def _log(msg: str) -> None:
    """Daemon log line, stderr, prefixed for grepability."""
    sys.stderr.write(f"[rockie-loop] {msg}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# Lab discovery (multi-lab tenant)
# ---------------------------------------------------------------------------


def _resolve_labs(explicit_lab: Optional[str]) -> list[str]:
    """If the caller passed --lab-id, return [that]. Otherwise list the
    tenant's labs via the notebook router. Sorted by latest activity
    descending so the daemon prefers the most-active lab first."""
    if explicit_lab:
        return [explicit_lab]
    try:
        rows = _http("GET", "/api/notebooks") or []
    except CLIError as e:
        _log(f"WARN: lab discovery failed: {e}")
        return []
    # Notebook router returns a list of notebooks; pick stable
    # 'id' or 'notebook_id' field.
    out: list[str] = []
    for r in rows if isinstance(rows, list) else []:
        nid = r.get("id") or r.get("notebook_id")
        if nid:
            out.append(str(nid))
    return out


# ---------------------------------------------------------------------------
# Iteration logic — pure & testable
# ---------------------------------------------------------------------------


def _has_inflight(state: dict) -> bool:
    return bool(
        state.get("in_flight_experiment_id")
        or state.get("in_flight_queue_id")
    )


def decide_action(state: dict) -> str:
    """Given a /loop-state snapshot, what should we do this wake?

    Returns one of: paused | credit_low | queue_poll | queue_launch
    | idle_plan | no_op. Pure function — unit-tested without I/O.
    """
    if state.get("user_paused"):
        return "paused"
    if state.get("credit_low"):
        return "credit_low"
    if state.get("paused"):
        return "paused"
    if _has_inflight(state):
        return "queue_poll"
    if int(state.get("queue_depth") or 0) > 0:
        return "queue_launch"
    return "idle_plan"


def compute_sleep_seconds(state: dict) -> int:
    """Mirror loop_service.compute_sleep_seconds for the daemon's
    fall-back when the API doesn't return sleep_seconds. The API's
    value is authoritative when present."""
    if "sleep_seconds" in state and state.get("sleep_seconds"):
        return int(state["sleep_seconds"])
    depth = int(state.get("queue_depth") or 0)
    in_flight = bool(state.get("in_flight_experiment_id"))
    if state.get("paused"):
        return IDLE_SLEEP_SECONDS
    return ACTIVE_SLEEP_SECONDS if (in_flight or depth > 0) else IDLE_SLEEP_SECONDS


# ---------------------------------------------------------------------------
# LLM substrate dispatch — broker /chat-pty (subscription) or warn (BYOK)
# ---------------------------------------------------------------------------


def _broker_chat_pty(prompt: str, *, session_id: str) -> Optional[dict]:
    """Submit a planning prompt to the broker's persistent claude PTY.

    Returns the parsed JSON-lines result (last `result` frame) or None
    if the broker is unreachable / the substrate doesn't support it.
    In BYOK mode we return None — the OpenClaw gateway path isn't
    wired through here yet (task #62).
    """
    if RUNTIME_MODE != "subscription":
        _log(
            f"BYOK/open-weights mode: skipping idle-plan LLM call "
            f"(see task #62). mode={RUNTIME_MODE}"
        )
        return None
    broker_url = f"http://127.0.0.1:{BROKER_PORT}"
    path = f"/chat-pty?session_id={urllib.parse.quote(session_id)}&binary=claude"
    if BROKER_TENANT_TOKEN:
        path += f"&token={urllib.parse.quote(BROKER_TENANT_TOKEN)}"
    try:
        resp = _http(
            "POST", path, body={"prompt": prompt},
            base=broker_url, token=None, timeout=120,
        )
    except CLIError as e:
        _log(f"WARN: /chat-pty unreachable: {e}")
        return None
    return resp if isinstance(resp, dict) else None


_IDLE_PLAN_PROMPT = (
    "You are the lab's autoresearch loop running in idle planning mode. "
    "Keep a gentle, dry Rockie voice. Occasional subtle rock puns or 🗿 "
    "are allowed only when they feel natural. Do not use rock puns or 🗿 "
    "in debugging, code, error analysis, numerical/data analysis, "
    "citations, structured output, or serious/sensitive answers. "
    "The queue is shallow — propose 1-3 next experiments that test an "
    "active hypothesis or fill a calibration gap. For each, justify in "
    "≤ 200 words against the lab journal (hypothesis_list + "
    "dead_end_search + calibration_brier_score). Then call "
    "experiment_submit only if the proposal passes adversarial review "
    "against the dead-end registry. Otherwise call dead_end_record with "
    "what failed and why."
)


# ---------------------------------------------------------------------------
# Iteration: side-effect orchestration
# ---------------------------------------------------------------------------


def _emit_artifact(
    *, lab_id: str, title: str, body: str
) -> None:
    """Fire-and-forget chat-channel artifact emission via the
    agent-tools HTTP surface. Failure here doesn't break the loop;
    we just log."""
    payload = {
        "arguments": {
            # emit_artifact's schema uses notebook_id, not lab_id.
            "notebook_id": lab_id,
            # `markdown` is the closest valid kind for a short narration
            # frame — the schema doesn't have a dedicated "notice" type.
            "kind": "markdown",
            "title": title,
            "content": body,
            "destinations": ["chat"],
        }
    }
    try:
        _http("POST", "/api/agent-tools/emit_artifact", body=payload)
    except CLIError as e:
        _log(f"WARN: emit_artifact failed: {e}")


def _record_iter(
    *,
    lab_id: str,
    action: str,
    summary: str = "",
    duration_ms: Optional[int] = None,
    **extras: Any,
) -> Optional[dict]:
    body: dict[str, Any] = {
        "action": action,
        "summary": summary,
        "duration_ms": duration_ms,
    }
    for k, v in extras.items():
        if v is not None:
            body[k] = v
    try:
        return _http(
            "POST", f"/api/labs/{lab_id}/loop-iter", body=body
        )
    except CLIError as e:
        _log(f"WARN: loop-iter record failed: {e}")
        return None


def _job_status(handle: str) -> Optional[dict]:
    try:
        return _http(
            "POST",
            "/api/agent-tools/job_status",
            body={"arguments": {"handle": handle}},
        )
    except CLIError as e:
        _log(f"WARN: job_status({handle}) failed: {e}")
        return None


def _submit_experiment(spec: dict) -> Optional[dict]:
    try:
        return _http(
            "POST",
            "/api/agent-tools/experiment_submit",
            body={"arguments": spec},
        )
    except CLIError as e:
        _log(f"WARN: experiment_submit failed: {e}")
        return None


def _gpu_smoke_body(spec: dict) -> Optional[dict]:
    if spec.get("kind") != "gpu_smoke":
        return None
    if any(k in spec for k in ("env", "command", "credentials", "credential")):
        return None
    gpu_type = str(spec.get("gpu_type") or "")
    if gpu_type not in GPU_SMOKE_TYPES:
        return None
    if spec.get("route_quote_available") is not True:
        return None
    if not spec.get("route_quote_provider"):
        return None
    if spec.get("route_quote_gpu_type") != gpu_type:
        return None
    if spec.get("route_quote_spot") is not True:
        return None
    if spec.get("dry_run_preflight") is not True:
        return None
    if not spec.get("dry_run_preflight_pod_id"):
        return None
    try:
        hours = float(spec.get("hours") or GPU_SMOKE_MAX_HOURS)
    except (TypeError, ValueError):
        return None
    if hours <= 0 or hours > GPU_SMOKE_MAX_HOURS:
        return None
    if spec.get("gpu_count") != 1 or spec.get("spot") is not True:
        return None

    body: dict[str, Any] = {
        "gpu_type": gpu_type,
        "gpu_count": 1,
        "spot": True,
        "hours": hours,
        "name": "rockie-dogfood-gpu-smoke",
    }
    region = spec.get("region") or spec.get("route_quote_region")
    if region:
        body["region"] = str(region)
    return body


def _provision_gpu_smoke(spec: dict) -> Optional[dict]:
    body = _gpu_smoke_body(spec)
    if body is None:
        _log("WARN: gpu_smoke queue row rejected by bounded-spec guard")
        return None
    try:
        return _http("POST", "/api/gpu/provision", body=body)
    except CLIError as e:
        _log(f"WARN: gpu smoke provision failed: {e}")
        return None


def _teardown_gpu_pod(provider: str, pod_id: str) -> bool:
    path = (
        f"/api/gpu/pods/{urllib.parse.quote(pod_id, safe='')}"
        f"?{urllib.parse.urlencode({'provider': provider})}"
    )
    try:
        _http("DELETE", path)
        return True
    except CLIError as e:
        _log(f"WARN: gpu smoke teardown failed: {e}")
        return False


def _transition_queue(
    *, lab_id: str, qid: str, state: str, experiment_id: Optional[str] = None,
    error: Optional[str] = None,
) -> Optional[dict]:
    body = {"state": state}
    if experiment_id:
        body["experiment_id"] = experiment_id
    if error:
        body["error"] = error
    try:
        return _http(
            "POST",
            f"/api/labs/{lab_id}/loop-queue/{qid}/state",
            body=body,
        )
    except CLIError as e:
        _log(f"WARN: queue transition failed: {e}")
        return None


def _pop_next_queue_row(lab_id: str) -> Optional[dict]:
    try:
        resp = _http("GET", f"/api/labs/{lab_id}/loop-queue/next")
    except CLIError as e:
        _log(f"WARN: queue/next failed: {e}")
        return None
    if not resp:
        return None
    return resp.get("next") if isinstance(resp, dict) else None


def _pause_with_reason(*, lab_id: str, reason: str) -> None:
    try:
        _http(
            "POST",
            f"/api/labs/{lab_id}/loop-pause",
            body={"reason": reason},
        )
    except CLIError as e:
        _log(f"WARN: pause({reason}) failed: {e}")


def _ms_since(start: float) -> int:
    return int((time.monotonic() - start) * 1000)


def _handle_paused(lab_id: str, state: dict, t0: float) -> dict:
    _record_iter(
        lab_id=lab_id,
        action="paused",
        summary=f"lab is paused: {state.get('paused_reason') or 'user'}",
        duration_ms=_ms_since(t0),
    )
    return {"lab_id": lab_id, "action": "paused", "state": state}


def _handle_credit_low(lab_id: str, state: dict, t0: float) -> dict:
    msg = (
        f"GPU credit is below $1 "
        f"({(state.get('gpu_credit_cents') or 0) / 100:.2f}). "
        "Pausing autoresearch. Add credit to resume."
    )
    # Idempotent: pausing is a no-op if already paused.
    _pause_with_reason(lab_id=lab_id, reason="credit_low")
    _emit_artifact(
        lab_id=lab_id, title="Autoresearch paused — credit low", body=msg
    )
    _record_iter(
        lab_id=lab_id, action="credit_low", summary=msg,
        duration_ms=_ms_since(t0),
    )
    return {"lab_id": lab_id, "action": "credit_low", "state": state}


def _classify_job_state(jstate: str) -> Optional[str]:
    """Map an experiment_submit/job_status state to a queue row state."""
    if jstate in {"DONE", "COMPLETED"}:
        return "done"
    if jstate in {"FAILED", "CANCELLED", "PREEMPTED"}:
        return "failed"
    return None


def _handle_queue_poll(lab_id: str, state: dict, t0: float) -> dict:
    in_flight_id = state.get("in_flight_experiment_id")
    queue_qid = state.get("in_flight_queue_id")
    summary = "polling in-flight experiment"
    new_state: Optional[str] = None
    if in_flight_id:
        status = _job_status(in_flight_id) or {}
        jstate = (status.get("state") or "").upper()
        new_state = _classify_job_state(jstate)
        summary = f"in-flight handle={in_flight_id} state={jstate or 'unknown'}"
    if new_state and queue_qid:
        _transition_queue(
            lab_id=lab_id, qid=queue_qid, state=new_state,
            error=(None if new_state == "done" else "job ended without success"),
        )
        _emit_artifact(
            lab_id=lab_id,
            title=f"Experiment finished ({new_state})",
            body=summary,
        )
    _record_iter(
        lab_id=lab_id, action="queue_poll", summary=summary,
        experiment_queue_id=queue_qid, experiment_id=in_flight_id,
        duration_ms=_ms_since(t0),
    )
    return {"lab_id": lab_id, "action": "queue_poll", "state": state}


def _launch_queued_row(lab_id: str, row: dict) -> tuple[Optional[str], str]:
    """Submit one queued experiment. Returns (handle, summary)."""
    qid = row.get("id") or ""
    spec = dict(row.get("spec") or {})
    title = row.get("title")
    if spec.get("kind") == "gpu_smoke":
        result = _provision_gpu_smoke(spec) or {}
        pod_id = result.get("pod_id")
        provider = result.get("provider")
        if pod_id and provider:
            handle = f"gpu:{provider}:{pod_id}"
            teardown_ok = _teardown_gpu_pod(str(provider), str(pod_id))
            if teardown_ok:
                _transition_queue(
                    lab_id=lab_id, qid=qid, state="done", experiment_id=handle
                )
                _emit_artifact(
                    lab_id=lab_id,
                    title=f"GPU smoke provisioned: {title}",
                    body=(
                        f"Provisioned {result.get('gpu_type') or spec.get('gpu_type')} "
                        f"via {provider}; immediate teardown succeeded."
                    ),
                )
                return handle, f"gpu smoke provisioned and torn down: {title!r}"
            _transition_queue(
                lab_id=lab_id, qid=qid, state="failed",
                experiment_id=handle,
                error="gpu smoke provisioned but teardown failed",
            )
            return handle, f"gpu smoke teardown failed: {title!r}"
        _transition_queue(
            lab_id=lab_id, qid=qid, state="failed",
            error="gpu smoke provision returned no pod",
        )
        return None, f"failed gpu smoke provision: {title!r}"

    result = _submit_experiment(spec)
    handle = (result or {}).get("handle")
    if handle:
        _transition_queue(
            lab_id=lab_id, qid=qid, state="running", experiment_id=handle
        )
        _emit_artifact(
            lab_id=lab_id,
            title=f"Experiment launched: {title}",
            body=row.get("rationale") or "(no rationale provided)",
        )
        return handle, f"launched experiment: {title!r} handle={handle}"
    _transition_queue(
        lab_id=lab_id, qid=qid, state="failed",
        error="experiment_submit returned no handle",
    )
    return None, f"failed to launch: {title!r}"


def _handle_queue_launch(lab_id: str, state: dict, t0: float) -> dict:
    row = _pop_next_queue_row(lab_id)
    if not row:
        _record_iter(
            lab_id=lab_id, action="no_op",
            summary="queue depth > 0 but no adversarial-passed row",
            duration_ms=_ms_since(t0),
        )
        return {"lab_id": lab_id, "action": "no_op", "state": state}
    handle, summary = _launch_queued_row(lab_id, row)
    _record_iter(
        lab_id=lab_id, action="queue_launch", summary=summary,
        experiment_queue_id=row.get("id"), experiment_id=handle,
        duration_ms=_ms_since(t0),
    )
    return {"lab_id": lab_id, "action": "queue_launch", "state": state}


def _handle_idle_plan(lab_id: str, state: dict, t0: float) -> dict:
    if RUNTIME_MODE != "subscription":
        # BYOK / open-weights: no LLM dispatch from the daemon today
        # (see task #62 — OpenClaw gateway MCP wiring). Record a no-op
        # so the user can see why the loop went quiet.
        _record_iter(
            lab_id=lab_id, action="no_op",
            summary=(
                f"idle planning skipped in mode={RUNTIME_MODE} "
                "(BYOK gateway MCP pending — task #62)"
            ),
            duration_ms=_ms_since(t0),
        )
        return {"lab_id": lab_id, "action": "no_op", "state": state}
    # Subscription mode: defer to the LLM. We don't parse the response —
    # the LLM is expected to call queue_enqueue + hypothesis_register
    # via MCP itself. We just observe.
    resp = _broker_chat_pty(
        _IDLE_PLAN_PROMPT, session_id=f"loop-{lab_id}"
    )
    summary = (
        "idle plan: invoked /chat-pty"
        if resp is not None
        else "idle plan: /chat-pty unavailable (broker?)"
    )
    _record_iter(
        lab_id=lab_id, action="idle_plan", summary=summary,
        duration_ms=_ms_since(t0),
    )
    return {"lab_id": lab_id, "action": "idle_plan", "state": state}


_HANDLERS = {
    "paused": _handle_paused,
    "credit_low": _handle_credit_low,
    "queue_poll": _handle_queue_poll,
    "queue_launch": _handle_queue_launch,
    "idle_plan": _handle_idle_plan,
}


def iter_lab(lab_id: str) -> dict:
    """Run one iteration on one lab. Returns a small dict the daemon
    uses to decide its next sleep duration. Per-action handlers live
    in `_HANDLERS` so this function stays a thin dispatcher."""
    t0 = time.monotonic()
    state = _http("GET", f"/api/labs/{lab_id}/loop-state")
    if not isinstance(state, dict):
        return {"lab_id": lab_id, "action": "error", "state": None}
    action = decide_action(state)
    handler = _HANDLERS.get(action)
    if handler is None:
        return {"lab_id": lab_id, "action": "no_op", "state": state}
    return handler(lab_id, state, t0)


# ---------------------------------------------------------------------------
# Daemon loop
# ---------------------------------------------------------------------------


def _iterate_labs_once(labs: list[str]) -> int:
    """One sweep over `labs`. Returns the chosen next-sleep duration
    (minimum of each lab's reported sleep — most active wins)."""
    next_sleep = IDLE_SLEEP_SECONDS
    for lab_id in labs:
        if _STOP:
            break
        try:
            result = iter_lab(lab_id)
        except Exception as exc:  # noqa: BLE001
            _log(f"ERROR iter_lab({lab_id}): {exc}")
            continue
        sleep_s = compute_sleep_seconds(result.get("state") or {})
        next_sleep = min(next_sleep, sleep_s)
    return next_sleep


def _interruptible_sleep(seconds: int) -> None:
    """Sleep in 2-second chunks so SIGTERM has sub-second response."""
    slept = 0
    while not _STOP and slept < seconds:
        time.sleep(min(2, seconds - slept))
        slept += 2


def run_daemon(explicit_lab: Optional[str]) -> int:
    """Long-running daemon. Sleeps + iterates until SIGTERM."""
    signal.signal(signal.SIGTERM, _handle_stop)
    signal.signal(signal.SIGINT, _handle_stop)
    _log(
        f"starting: api_base={DEFAULT_API_BASE} mode={RUNTIME_MODE} "
        f"explicit_lab={explicit_lab or '(discover)'}"
    )
    while not _STOP:
        labs = _resolve_labs(explicit_lab)
        if not labs:
            _log("no labs found; sleeping idle")
            _interruptible_sleep(IDLE_SLEEP_SECONDS)
            continue
        next_sleep = _iterate_labs_once(labs)
        _log(f"sleep {next_sleep}s")
        _interruptible_sleep(next_sleep)
    _log("stopping")
    return 0


# ---------------------------------------------------------------------------
# CLI surface
# ---------------------------------------------------------------------------


def cmd_run(args: argparse.Namespace) -> int:
    return run_daemon(args.lab_id)


def cmd_iter(args: argparse.Namespace) -> int:
    labs = _resolve_labs(args.lab_id)
    if not labs:
        _log("no labs to iterate")
        return 0
    results = [iter_lab(lab_id) for lab_id in labs]
    for r in results:
        sys.stdout.write(
            json.dumps({"lab_id": r["lab_id"], "action": r["action"]}) + "\n"
        )
    sys.stdout.flush()
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    labs = _resolve_labs(args.lab_id)
    if not labs:
        sys.stdout.write("[]\n")
        return 0
    out = []
    for lab_id in labs:
        try:
            state = _http("GET", f"/api/labs/{lab_id}/loop-state")
        except CLIError as e:
            _log(f"WARN: status({lab_id}): {e}")
            continue
        if state is not None:
            out.append(state)
    sys.stdout.write(json.dumps(out, indent=2) + "\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rockie-loop",
        description=(
            "Rockie's continuous autoresearch loop — the daemon that "
            "makes the headline pitch 'never sleeps' literally true."
        ),
    )
    sub = parser.add_subparsers(dest="cmd")

    p_run = sub.add_parser("run", help="Run the daemon (default).")
    p_run.add_argument(
        "--lab-id",
        default=None,
        help="Restrict to a single lab. Default: serve all labs owned by "
        "this tenant.",
    )
    p_run.set_defaults(func=cmd_run)

    p_iter = sub.add_parser(
        "iter", help="Run one iteration on each lab + exit."
    )
    p_iter.add_argument("--lab-id", default=None)
    p_iter.set_defaults(func=cmd_iter)

    p_status = sub.add_parser(
        "status", help="Print loop-state JSON for each lab + exit."
    )
    p_status.add_argument("--lab-id", default=None)
    p_status.set_defaults(func=cmd_status)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "cmd", None):
        # `rockie-loop` with no subcommand → run the daemon.
        args.cmd = "run"
        args.lab_id = None
        args.func = cmd_run
    try:
        return int(args.func(args))
    except CLIError as e:
        sys.stderr.write(f"rockie-loop: {e}\n")
        return e.exit_code


if __name__ == "__main__":
    sys.exit(main())
