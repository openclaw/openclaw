"""LiteLLM callback: F2 (session/agent attribution) + F3 (error.* at the top level).

LiteLLM calls the callbacks listed in ``litellm_settings.callbacks`` in order.
Register this module *before* ``langfuse_otel``::

    litellm_settings:
      callbacks: ["langfuse_trace_context", "langfuse_otel"]

Then the metadata written here is picked up by the Langfuse integration when it
finalises the span:

======================  ==========================================
metadata key           resulting trace attribute
======================  ==========================================
``session_id``         ``langfuse.session.id``
``trace_user_id``      ``langfuse.user.id``
``existing_trace_id``  the call joins the trace of the TILA session
``trace_metadata``     ``langfuse.trace.metadata`` (JSON) -> traces.metadata
======================  ==========================================

Why the session id is recovered from ``metadata.user_id``: the agent harnesses
send their own session id inside a JSON blob in ``metadata.user_id``. LiteLLM
maps that blob verbatim onto ``langfuse.user.id``, so the session id is lost —
which is exactly why tokens and cost could not be attributed to an agent. The
session id is written back as ``session_id`` plus ``existing_trace_id``, so the
model call lands inside the trace of the session.

The agent name is static per harness and is passed as the request header
``langfuse_trace_user_id`` (claude / codex / opencode / minimax / kimi).

The pure helpers are duplicated from the canonical contract module
``tila-sentinel/src/ai_watchdog/langfuse_trace_context.py`` on purpose: this
file runs inside the gateway container, which has no TILA package.
``tila-sentinel/tests/test_langfuse_wave3_fixes.py`` guards the two copies
against drift.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Mapping

HEADER_SESSION_ID = "langfuse_session_id"
HEADER_TRACE_USER_ID = "langfuse_trace_user_id"
HEADER_EXISTING_TRACE_ID = "langfuse_existing_trace_id"

SESSION_ID_KEY = "session_id"
TRACE_USER_ID_KEY = "trace_user_id"
EXISTING_TRACE_ID_KEY = "existing_trace_id"
TRACE_METADATA_KEY = "trace_metadata"

ERROR_TYPE_KEY = "error.type"
ERROR_CODE_KEY = "error.code"
ERROR_MESSAGE_KEY = "error.message"

AGENT_KEY = "agent"
SOURCE_KEY = "source"

_STATUS_RE = re.compile(r"\b([45]\d{2})\b")
_EXCEPTION_RE = re.compile(r"^([A-Za-z_][\w.]*(?:Error|Exception|Timeout|Failure))\b")

_MAX_MESSAGE_LEN = 500


def session_trace_id(session_id: str) -> str:
    """Deterministic Langfuse trace id of a TILA session."""
    return hashlib.sha256(f"trace:{session_id}".encode("utf-8")).hexdigest()[:32]


def parse_user_id_blob(user_id: Any) -> dict[str, Any]:
    """Parse the JSON blob an agent harness puts into ``metadata.user_id``."""
    if not isinstance(user_id, str):
        return {}
    text = user_id.strip()
    if not text.startswith("{"):
        return {}
    try:
        data = json.loads(text)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def error_fields(error_text: str) -> dict[str, str]:
    """Split a raw error string into top level ``error.*`` keys."""
    text = (error_text or "").strip()
    if not text:
        return {}
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    head = lines[0] if lines else ""
    match = _EXCEPTION_RE.match(head)
    code_match = _STATUS_RE.search(text)
    return {
        ERROR_TYPE_KEY: match.group(1) if match else "session_error",
        ERROR_CODE_KEY: code_match.group(1) if code_match else "",
        ERROR_MESSAGE_KEY: (lines[-1] if lines else text)[:_MAX_MESSAGE_LEN],
    }


def context_from_headers(headers: Mapping[str, Any] | None) -> dict[str, str]:
    """Session/agent/existing-trace ids taken from ``langfuse_*`` headers."""
    normalized = {str(key).lower(): value for key, value in dict(headers or {}).items()}
    return {
        "session_id": str(normalized.get(HEADER_SESSION_ID) or "").strip(),
        "agent": str(normalized.get(HEADER_TRACE_USER_ID) or "").strip(),
        "existing_trace_id": str(normalized.get(HEADER_EXISTING_TRACE_ID) or "").strip(),
    }


def context_from_metadata(metadata: Mapping[str, Any] | None) -> dict[str, str]:
    """Session/agent ids taken from the request metadata."""
    meta = dict(metadata or {})
    session_id = str(meta.get(SESSION_ID_KEY) or "").strip()
    agent = str(meta.get(TRACE_USER_ID_KEY) or meta.get(AGENT_KEY) or "").strip()
    if not session_id:
        blob = parse_user_id_blob(meta.get("user_id"))
        session_id = str(blob.get("session_id") or blob.get("sessionId") or "").strip()
    return {"session_id": session_id, "agent": agent}


def trace_metadata(
    session_id: str,
    agent: str = "",
    *,
    error_text: str = "",
    source: str = "",
) -> dict[str, Any]:
    """Flat metadata of a trace: attribution keys plus top level error keys."""
    meta: dict[str, Any] = {"session_id": session_id}
    if agent:
        meta[AGENT_KEY] = agent
    if source:
        meta[SOURCE_KEY] = source
    meta.update(error_fields(error_text))
    return meta


def enrich_litellm_metadata(
    metadata: Mapping[str, Any] | None = None,
    headers: Mapping[str, Any] | None = None,
    *,
    error_text: str = "",
    agent: str = "",
) -> dict[str, Any]:
    """Metadata LiteLLM's ``langfuse_otel`` integration maps onto the trace."""
    enriched = dict(metadata or {})
    from_headers = context_from_headers(headers)
    from_meta = context_from_metadata(enriched)
    session_id = from_headers["session_id"] or from_meta["session_id"]
    resolved_agent = agent or from_headers["agent"] or from_meta["agent"]

    if session_id:
        enriched[SESSION_ID_KEY] = session_id
        if not from_headers["existing_trace_id"]:
            enriched.setdefault(EXISTING_TRACE_ID_KEY, session_trace_id(session_id))
    if resolved_agent:
        enriched[TRACE_USER_ID_KEY] = resolved_agent

    meta = trace_metadata(session_id, resolved_agent, error_text=error_text)
    if session_id or error_text:
        enriched[TRACE_METADATA_KEY] = json.dumps(meta, sort_keys=True)
    return enriched


# --- LiteLLM callback entry points -----------------------------------------


def _error_text(kwargs: Mapping[str, Any]) -> str:
    for key in ("exception", "original_exception"):
        exc = kwargs.get(key)
        if exc is None:
            continue
        text = str(exc)
        if text:
            return text
    return ""


def _apply(kwargs: Any, *, error_text: str = "") -> None:
    """Rewrite ``litellm_params.metadata`` in place."""
    if not isinstance(kwargs, dict):
        return
    params = kwargs.get("litellm_params")
    if not isinstance(params, dict):
        return
    metadata = params.get("metadata") or {}
    request = params.get("proxy_server_request") or {}
    headers = request.get("headers") if isinstance(request, dict) else {}
    params["metadata"] = enrich_litellm_metadata(
        metadata, headers, error_text=error_text
    )
    kwargs["litellm_params"] = params


async def async_pre_call_hook(kwargs: Any, *args: Any, **kwargs_extra: Any) -> Any:
    """Runs before the model call: normalise the metadata of the request."""
    _apply(kwargs)
    return kwargs


async def log_success_event(
    kwargs: Any, response_obj: Any, start_time: Any = None, end_time: Any = None
) -> Any:
    """Successful call: the trace keeps the session id and the agent."""
    _apply(kwargs)


async def log_failure_event(
    kwargs: Any, response_obj: Any, start_time: Any = None, end_time: Any = None
) -> Any:
    """Failed call: the error is hoisted to the top level of the trace metadata."""
    _apply(kwargs, error_text=_error_text(kwargs))
