#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = os.environ.get("SENSE_WORKER_URL", "http://192.168.11.11:8787").rstrip("/")
DEFAULT_TIMEOUT = float(os.environ.get("SENSE_RUNTIME_BRIDGE_TIMEOUT", "10"))
DEFAULT_WAIT_TIMEOUT = float(os.environ.get("SENSE_RUNTIME_BRIDGE_WAIT_TIMEOUT", "180"))
DEFAULT_POLL_INTERVAL = float(os.environ.get("SENSE_RUNTIME_BRIDGE_POLL_INTERVAL", "2"))
DEFAULT_TOKEN_ENV = "SENSE_WORKER_TOKEN"
DEFAULT_WSL_NODE_BIN = "/home/fukaz/.nvm/versions/node/v22.22.2/bin/node"
ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


def resolve_token(token: str | None, token_env: str | None) -> str | None:
    if token and token.strip():
        return token.strip()
    env_name = token_env.strip() if token_env and token_env.strip() else DEFAULT_TOKEN_ENV
    value = os.environ.get(env_name)
    return value.strip() if value and value.strip() else None


def strip_ansi(value: str) -> str:
    cleaned = ANSI_ESCAPE_RE.sub("", value)
    return " ".join(cleaned.replace("\r", " ").split())


def try_parse_json(text: str):
    text = text.strip()
    if not text:
        return ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def sanitize_runtime_result(task_type: str, completed: dict) -> dict:
    if not isinstance(completed, dict):
        return completed
    result = completed.get("result")
    if not isinstance(result, dict):
        return completed

    sanitized = dict(result)
    summary = sanitized.get("summary")
    if isinstance(summary, str):
        sanitized["summary"] = strip_ansi(summary)

    key_points = sanitized.get("key_points")
    if isinstance(key_points, list):
        sanitized["key_points"] = [strip_ansi(str(item)) for item in key_points]

    next_action = sanitized.get("suggested_next_action")
    if isinstance(next_action, str):
        sanitized["suggested_next_action"] = strip_ansi(next_action)

    raw_output = sanitized.get("raw_output")
    if isinstance(raw_output, str) and task_type == "sandbox-status":
        try:
            raw_payload = json.loads(raw_output)
            if isinstance(raw_payload, dict):
                for field in ("stdout", "stderr", "input_excerpt"):
                    if isinstance(raw_payload.get(field), str):
                        raw_payload[field] = strip_ansi(raw_payload[field])
                if isinstance(raw_payload.get("key_points"), list):
                    raw_payload["key_points"] = [strip_ansi(str(item)) for item in raw_payload["key_points"]]
                sanitized["raw_output"] = json.dumps(raw_payload, ensure_ascii=False)
        except json.JSONDecodeError:
            sanitized["raw_output"] = strip_ansi(raw_output)

    merged = dict(completed)
    merged["result"] = sanitized
    return merged


def request_json(method: str, url: str, payload: dict | None, timeout: float, token: str | None = None):
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["X-Sense-Worker-Token"] = token
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, try_parse_json(body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return exc.code, try_parse_json(body)
    except urllib.error.URLError as exc:
        raise RuntimeError(f"request failed: {exc.reason}") from exc


def submit_job(base_url: str, token: str | None, timeout: float, input_text: str, params: dict):
    payload = {
        "task": "heavy_task",
        "input": input_text,
        "params": params,
    }
    status, body = request_json("POST", f"{base_url}/execute", payload, timeout, token=token)
    if status != 200:
        raise RuntimeError(f"submit failed status={status} body={json.dumps(body, ensure_ascii=False)}")
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result, dict) or not result.get("job_id"):
        raise RuntimeError(f"submit returned unexpected body={json.dumps(body, ensure_ascii=False)}")
    return result


def fetch_job(base_url: str, token: str | None, timeout: float, job_id: str):
    status, body = request_json("GET", f"{base_url}/jobs/{urllib.parse.quote(job_id)}", None, timeout, token=token)
    if status != 200:
        raise RuntimeError(f"job status failed status={status} body={json.dumps(body, ensure_ascii=False)}")
    return body


def poll_until_done(base_url: str, token: str | None, timeout: float, wait_timeout: float, poll_interval: float, job_id: str):
    deadline = time.monotonic() + wait_timeout
    while time.monotonic() < deadline:
        body = fetch_job(base_url, token, timeout, job_id)
        status = str(body.get("status") or "")
        if status == "done":
            return body
        time.sleep(max(0.5, poll_interval))
    raise TimeoutError(f"job {job_id} did not complete within {wait_timeout} seconds")


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge a T550 control-plane command into the Sense WSL NemoClaw runtime plane.")
    parser.add_argument("task_type", choices=["help", "list", "status", "start", "stop", "sandbox-status"])
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--token")
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--wait-timeout", type=float, default=DEFAULT_WAIT_TIMEOUT)
    parser.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL)
    parser.add_argument("--input", default="Run a Sense WSL NemoClaw runtime task from the T550 control plane.")
    parser.add_argument("--job-profile", default="future-nemoclaw")
    parser.add_argument("--gpu-profile", default="single-gpu-safe")
    parser.add_argument("--model", default="nemoclaw-minimal")
    parser.add_argument("--runtime-plane", default="wsl")
    parser.add_argument("--wsl-distro", default="Ubuntu")
    parser.add_argument("--wsl-nemoclaw-root", default="~/NemoClaw")
    parser.add_argument("--wsl-node-bin", default=DEFAULT_WSL_NODE_BIN)
    parser.add_argument("--sandbox-name", default="")
    parser.add_argument("--required-vram-mb", type=float)
    parser.add_argument("--timeout-sec", type=float, default=120.0)
    parser.add_argument("--result-only", action="store_true")
    args = parser.parse_args()

    token = resolve_token(args.token, args.token_env)
    params = {
        "mode": "nemoclaw_job",
        "scope": "nemoclaw",
        "job_profile": args.job_profile,
        "runtime_plane": args.runtime_plane,
        "task_type": args.task_type,
        "gpu_profile": args.gpu_profile,
        "model": args.model,
        "timeout_sec": args.timeout_sec,
        "wsl_distro": args.wsl_distro,
        "wsl_nemoclaw_root": args.wsl_nemoclaw_root,
        "wsl_node_bin": args.wsl_node_bin,
    }
    if args.sandbox_name:
        params["sandbox_name"] = args.sandbox_name
    if args.required_vram_mb is not None:
        params["required_vram_mb"] = args.required_vram_mb

    submit_result = submit_job(args.base_url.rstrip("/"), token, args.timeout, args.input, params)
    job_id = str(submit_result["job_id"])
    print(json.dumps({"submitted": submit_result}, ensure_ascii=False, indent=2), file=sys.stderr)
    completed = poll_until_done(args.base_url.rstrip("/"), token, args.timeout, args.wait_timeout, args.poll_interval, job_id)
    completed = sanitize_runtime_result(args.task_type, completed)
    if args.result_only:
        payload = completed.get("result") if isinstance(completed, dict) else completed
    else:
        payload = completed
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    result = completed.get("result") if isinstance(completed, dict) else None
    if isinstance(result, dict) and int(result.get("exit_code", 0)) != 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())