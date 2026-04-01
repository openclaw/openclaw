#!/usr/bin/env python3
import argparse
import json
import os
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


def resolve_token(token: str | None, token_env: str | None) -> str | None:
    if token and token.strip():
        return token.strip()
    env_name = token_env.strip() if token_env and token_env.strip() else DEFAULT_TOKEN_ENV
    value = os.environ.get(env_name)
    return value.strip() if value and value.strip() else None


def try_parse_json(text: str):
    text = text.strip()
    if not text:
        return ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


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
    print(json.dumps(completed, ensure_ascii=False, indent=2))
    result = completed.get("result") if isinstance(completed, dict) else None
    if isinstance(result, dict) and int(result.get("exit_code", 0)) != 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
