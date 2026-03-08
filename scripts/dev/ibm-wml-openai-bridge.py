#!/usr/bin/env python3
"""
IBM watsonx OpenAI-compatible bridge for OpenClaw.

Why this exists:
- OpenClaw can target OpenAI-compatible endpoints.
- IBM watsonx Python SDK handles IAM token refresh automatically.
- This bridge translates `/v1/chat/completions` to watsonx chat APIs.

Security model:
- No secrets are hardcoded.
- All credentials come from environment variables.
- Optional bearer auth protects bridge endpoints.

Required environment:
- IBM_API_KEY
- IBM_PROJECT_ID

Optional environment:
- IBM_URL (default: https://us-south.ml.cloud.ibm.com)
- IBM_MODEL_ID (default: meta-llama/llama-4-maverick-17b-128e-instruct-fp8)
- BRIDGE_HOST (default: 127.0.0.1)
- BRIDGE_PORT (default: 19090)
- BRIDGE_API_KEY (if set, requests require `Authorization: Bearer <key>`)
- MAX_CONTENT_LENGTH_BYTES (default: 1048576)
- MAX_MESSAGES (default: 120)
- MAX_PROMPT_CHARS (default: 120000)
- MAX_OUTPUT_TOKENS (default: 2048)
- STREAM_TOTAL_TIMEOUT (default: 90)
- STREAM_CHUNK_TIMEOUT (default: 30)
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from threading import Lock
from typing import Any

from flask import Flask, Response, jsonify, request
from ibm_watsonx_ai import Credentials
from ibm_watsonx_ai.foundation_models import ModelInference

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("BRIDGE_PORT", "19090"))
BRIDGE_API_KEY = os.getenv("BRIDGE_API_KEY", "").strip()
MAX_CONTENT_LENGTH_BYTES = int(os.getenv("MAX_CONTENT_LENGTH_BYTES", "1048576"))
MAX_MESSAGES = int(os.getenv("MAX_MESSAGES", "120"))
MAX_PROMPT_CHARS = int(os.getenv("MAX_PROMPT_CHARS", "120000"))
MAX_OUTPUT_TOKENS = int(os.getenv("MAX_OUTPUT_TOKENS", "2048"))
STREAM_TOTAL_TIMEOUT = int(os.getenv("STREAM_TOTAL_TIMEOUT", "90"))
STREAM_CHUNK_TIMEOUT = int(os.getenv("STREAM_CHUNK_TIMEOUT", "30"))

app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH_BYTES

IBM_API_KEY = os.getenv("IBM_API_KEY", "").strip()
IBM_URL = os.getenv("IBM_URL", "https://us-south.ml.cloud.ibm.com").strip()
PROJECT_ID = os.getenv("IBM_PROJECT_ID", "").strip()
MODEL_ID = os.getenv(
    "IBM_MODEL_ID", "meta-llama/llama-4-maverick-17b-128e-instruct-fp8"
).strip()

if not IBM_API_KEY:
    raise RuntimeError("Missing IBM_API_KEY environment variable")
if not PROJECT_ID:
    raise RuntimeError("Missing IBM_PROJECT_ID environment variable")

credentials = Credentials(api_key=IBM_API_KEY, url=IBM_URL)
model_inference = ModelInference(
    model_id=MODEL_ID, credentials=credentials, project_id=PROJECT_ID
)

logger.info("IBM WML bridge initialized with model=%s", MODEL_ID)
logger.info("IBM WML token refresh is handled by the watsonx SDK")
if BRIDGE_API_KEY:
    logger.info("Bridge auth enabled")
else:
    logger.warning("Bridge auth disabled; set BRIDGE_API_KEY to require Bearer auth")

usage_lock = Lock()
usage_stats: dict[str, int] = {
    "requests": 0,
    "stream_requests": 0,
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
    "last_updated": int(time.time()),
}


def _get_bearer_token(auth_header: str) -> str:
    if not auth_header:
        return ""
    prefix = "Bearer "
    if not auth_header.startswith(prefix):
        return ""
    return auth_header[len(prefix) :].strip()


@app.before_request
def _require_auth() -> Response | tuple[Response, int] | None:
    if not BRIDGE_API_KEY:
        return None
    if request.path in {"/health", "/v1/models"}:
        return None
    token = _get_bearer_token(request.headers.get("Authorization", ""))
    if token != BRIDGE_API_KEY:
        return jsonify({"error": "Unauthorized"}), 401
    return None


def _record_usage(prompt_tokens: int, completion_tokens: int, is_stream: bool) -> None:
    with usage_lock:
        usage_stats["requests"] += 1
        if is_stream:
            usage_stats["stream_requests"] += 1
        usage_stats["prompt_tokens"] += max(0, int(prompt_tokens))
        usage_stats["completion_tokens"] += max(0, int(completion_tokens))
        usage_stats["total_tokens"] += max(0, int(prompt_tokens + completion_tokens))
        usage_stats["last_updated"] = int(time.time())


def _normalize_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    for message in messages:
        role = str(message.get("role", "user"))
        if role == "tool":
            continue

        content = message.get("content", "")
        if isinstance(content, list):
            parts: list[str] = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    parts.append(str(part.get("text", "")))
                elif isinstance(part, str):
                    parts.append(part)
            content = "\n".join(parts)

        if role == "assistant" and str(content).strip() == "NO_REPLY":
            content = "(acknowledged)"

        text = str(content)
        if not text and role != "assistant":
            continue

        normalized.append({"role": role, "content": text})

    anti_noreply = {
        "role": "system",
        "content": (
            "CRITICAL: Always answer direct user messages with normal text. "
            "Do not output NO_REPLY unless a response has already been delivered via a tool."
        ),
    }

    last_user_idx = None
    for index in range(len(normalized) - 1, -1, -1):
        if normalized[index]["role"] == "user":
            last_user_idx = index
            break

    if last_user_idx is not None:
        normalized.insert(last_user_idx, anti_noreply)
    else:
        normalized.append(anti_noreply)

    return normalized


def _generate_stream_response(messages: list[dict[str, str]], params: dict[str, Any]):
    chat_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created = int(time.time())
    first_chunk = True

    try:
        logger.info("[STREAM] start messages=%s params=%s", len(messages), params)
        stream = model_inference.chat_stream(messages=messages, params=params)

        chunk_count = 0
        total_content = ""
        ibm_usage: dict[str, Any] | None = None
        stream_start = time.time()
        last_chunk_time = stream_start

        for chunk in stream:
            now = time.time()
            if now - stream_start > STREAM_TOTAL_TIMEOUT:
                logger.warning("[STREAM] total timeout exceeded after %s chunks", chunk_count)
                timeout_chunk = {
                    "id": chat_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": MODEL_ID,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": "\n\n[Response truncated: timeout]"},
                            "finish_reason": "length",
                        }
                    ],
                }
                yield f"data: {json.dumps(timeout_chunk)}\n\n"
                yield "data: [DONE]\n\n"
                return

            if now - last_chunk_time > STREAM_CHUNK_TIMEOUT:
                logger.warning("[STREAM] chunk timeout exceeded after %s chunks", chunk_count)
                timeout_chunk = {
                    "id": chat_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": MODEL_ID,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": "\n\n[Response interrupted: upstream stall]"},
                            "finish_reason": "length",
                        }
                    ],
                }
                yield f"data: {json.dumps(timeout_chunk)}\n\n"
                yield "data: [DONE]\n\n"
                return

            last_chunk_time = now
            chunk_count += 1

            if not isinstance(chunk, dict):
                continue

            if "usage" in chunk and isinstance(chunk["usage"], dict):
                ibm_usage = chunk["usage"]

            choices = chunk.get("choices", [])
            if not choices:
                continue

            delta = choices[0].get("delta", {})
            content = str(delta.get("content", ""))
            finish_reason = choices[0].get("finish_reason")

            if content:
                total_content += content

            if first_chunk:
                sse_chunk = {
                    "id": chat_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": MODEL_ID,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": content},
                            "finish_reason": None,
                        }
                    ],
                }
                first_chunk = False
                yield f"data: {json.dumps(sse_chunk)}\n\n"
                continue

            if not content and not finish_reason:
                continue

            sse_chunk = {
                "id": chat_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": MODEL_ID,
                "choices": [
                    {
                        "index": 0,
                        "delta": ({"content": content} if content else {}),
                        "finish_reason": finish_reason,
                    }
                ],
            }
            yield f"data: {json.dumps(sse_chunk)}\n\n"

        if ibm_usage:
            prompt_tokens = int(ibm_usage.get("prompt_tokens", 0))
            completion_tokens = int(ibm_usage.get("completion_tokens", 0))
        else:
            prompt_tokens = len(str(messages)) // 4
            completion_tokens = len(total_content) // 4

        total_tokens = prompt_tokens + completion_tokens
        usage_chunk = {
            "id": chat_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": MODEL_ID,
            "choices": [],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
            },
        }
        _record_usage(prompt_tokens, completion_tokens, is_stream=True)
        logger.info(
            "[USAGE] prompt=%s completion=%s total=%s",
            prompt_tokens,
            completion_tokens,
            total_tokens,
        )
        yield f"data: {json.dumps(usage_chunk)}\n\n"
        yield "data: [DONE]\n\n"

    except Exception as error:
        logger.exception("[STREAM] error: %s", error)
        error_chunk = {
            "id": chat_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": MODEL_ID,
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": f"\n[Error: {error}]"},
                    "finish_reason": "stop",
                }
            ],
        }
        yield f"data: {json.dumps(error_chunk)}\n\n"
        yield "data: [DONE]\n\n"


@app.route("/v1/chat/completions", methods=["POST"])
def chat_completions():
    try:
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify({"error": "Invalid JSON body"}), 400

        raw_messages = data.get("messages", [])
        if not isinstance(raw_messages, list):
            return jsonify({"error": "messages must be an array"}), 400
        if len(raw_messages) == 0:
            return jsonify({"error": "messages cannot be empty"}), 400
        if len(raw_messages) > MAX_MESSAGES:
            return jsonify({"error": f"Too many messages (max {MAX_MESSAGES})"}), 400

        messages = _normalize_messages(raw_messages)
        prompt_chars = sum(len(str(message.get("content", ""))) for message in messages)
        if prompt_chars > MAX_PROMPT_CHARS:
            return (
                jsonify(
                    {
                        "error": (
                            f"Prompt too large ({prompt_chars} chars; max {MAX_PROMPT_CHARS})"
                        )
                    }
                ),
                400,
            )

        temperature = float(data.get("temperature", 0.7))
        temperature = max(0.0, min(temperature, 2.0))

        requested_tokens = data.get("max_completion_tokens") or data.get("max_tokens")
        if requested_tokens is None:
            requested_tokens = MAX_OUTPUT_TOKENS
        try:
            requested_tokens = int(requested_tokens)
        except (TypeError, ValueError):
            requested_tokens = MAX_OUTPUT_TOKENS
        max_tokens = max(1, min(requested_tokens, MAX_OUTPUT_TOKENS))

        stream = data.get("stream", False)
        if not isinstance(stream, bool):
            stream = bool(stream)

        params = {"temperature": temperature, "max_tokens": max_tokens}
        logger.info(
            "chat request raw=%s normalized=%s prompt_chars=%s max_tokens=%s stream=%s",
            len(raw_messages),
            len(messages),
            prompt_chars,
            max_tokens,
            stream,
        )

        if stream:
            return Response(
                _generate_stream_response(messages, params),
                mimetype="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        response = model_inference.chat(messages=messages, params=params)
        usage = response.get("usage", {}) if isinstance(response, dict) else {}
        prompt_tokens = int(usage.get("prompt_tokens", prompt_chars // 4))
        completion_tokens = int(usage.get("completion_tokens", 0))
        _record_usage(prompt_tokens, completion_tokens, is_stream=False)
        return jsonify(response)

    except Exception as error:
        logger.exception("chat error: %s", error)
        return jsonify({"error": str(error)}), 500


@app.route("/v1/models", methods=["GET"])
def list_models():
    return jsonify(
        {
            "object": "list",
            "data": [
                {
                    "id": MODEL_ID,
                    "object": "model",
                    "owned_by": "ibm-watsonx",
                    "permission": [],
                    "created": 0,
                    "root": MODEL_ID,
                    "parent": None,
                }
            ],
        }
    )


@app.route("/v1/usage", methods=["GET"])
def usage():
    with usage_lock:
        snapshot = dict(usage_stats)
    return jsonify({"object": "usage", "data": snapshot})


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "status": "healthy",
            "model": MODEL_ID,
            "token_management": "automatic (SDK-managed)",
            "sdk": "ibm-watsonx-ai",
            "auth": "enabled" if BRIDGE_API_KEY else "disabled",
            "limits": {
                "max_messages": MAX_MESSAGES,
                "max_prompt_chars": MAX_PROMPT_CHARS,
                "max_output_tokens": MAX_OUTPUT_TOKENS,
                "max_body_bytes": MAX_CONTENT_LENGTH_BYTES,
                "stream_total_timeout": STREAM_TOTAL_TIMEOUT,
                "stream_chunk_timeout": STREAM_CHUNK_TIMEOUT,
            },
        }
    )


if __name__ == "__main__":
    logger.info("Starting IBM WML bridge on %s:%s", HOST, PORT)
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
