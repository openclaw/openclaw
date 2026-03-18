#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone


DEFAULT_BASE_URL = os.environ.get("SENSE_WORKER_URL", "http://192.168.11.11:8787").rstrip("/")
DEFAULT_TOKEN_ENV = "SENSE_WORKER_TOKEN"
DEFAULT_POLL_INTERVAL = 2.0
DEFAULT_PROCESSING_DELAY = 1.5
DEFAULT_HEARTBEAT_INTERVAL = 30.0
DEFAULT_OLLAMA_URL = "http://192.168.11.11:11434"
DEFAULT_OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gpt-oss:20b")


def log(message: str) -> None:
    timestamp = datetime.now(timezone.utc).isoformat()
    print(f"[{timestamp}] [nemoclaw-runner] {message}", file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Poll Sense async jobs and complete them as a remote NemoClaw-style runner.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Sense worker base URL.")
    parser.add_argument("--token", help="Shared token for X-Sense-Worker-Token.")
    parser.add_argument("--token-env", default=DEFAULT_TOKEN_ENV, help="Environment variable to read the shared token from.")
    parser.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL, help="Seconds to wait between empty polls.")
    parser.add_argument("--processing-delay", type=float, default=DEFAULT_PROCESSING_DELAY, help="Seconds to simulate processing work.")
    parser.add_argument("--heartbeat-interval", type=float, default=DEFAULT_HEARTBEAT_INTERVAL, help="Seconds between job heartbeat calls.")
    parser.add_argument("--runner-name", default="nemoclaw_runner", help="Runner identifier stored in result.runner.")
    parser.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL, help="Local Ollama base URL.")
    parser.add_argument("--ollama-model", default=DEFAULT_OLLAMA_MODEL, help="Ollama model name.")
    parser.add_argument("--ollama-timeout", type=float, default=60.0, help="Timeout for Ollama generate requests.")
    parser.add_argument("--once", action="store_true", help="Handle at most one queued job, then exit.")
    return parser.parse_args()


def resolve_token(args: argparse.Namespace) -> str | None:
    if args.token:
        return args.token.strip()
    env_value = os.environ.get(args.token_env or DEFAULT_TOKEN_ENV, "")
    return env_value.strip() or None


def normalize_http_url(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        return DEFAULT_OLLAMA_URL
    if cleaned.startswith("http://") or cleaned.startswith("https://"):
        return cleaned.rstrip("/")
    return f"http://{cleaned.rstrip('/')}"


def resolve_ollama_url(args: argparse.Namespace, params: dict | None) -> str:
    if isinstance(params, dict):
        param_value = params.get("ollama_host")
        if isinstance(param_value, str) and param_value.strip():
            return normalize_http_url(param_value)
    env_value = os.environ.get("OLLAMA_HOST", "").strip()
    if env_value:
        return normalize_http_url(env_value)
    cli_value = getattr(args, "ollama_url", None)
    if isinstance(cli_value, str) and cli_value.strip():
        return normalize_http_url(cli_value)
    legacy_env = os.environ.get("OLLAMA_URL", "").strip()
    if legacy_env:
        return normalize_http_url(legacy_env)
    return DEFAULT_OLLAMA_URL


def request_json(method: str, url: str, token: str | None = None, body: dict | None = None, timeout: float = 10.0) -> tuple[int, dict]:
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["X-Sense-Worker-Token"] = token
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
            return response.getcode(), json.loads(payload) if payload else {}
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8")
        parsed = json.loads(payload) if payload else {}
        return exc.code, parsed


def summarize_text(text: str, limit: int = 140) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3].rstrip() + "..."


def make_key_points(text: str) -> list[str]:
    parts = [segment.strip(" -") for segment in text.replace("\n", " ").split(".") if segment.strip()]
    if not parts:
        parts = [text.strip()] if text.strip() else []
    points = []
    for part in parts[:5]:
        points.append(summarize_text(part, 90))
    while len(points) < 3 and text.strip():
        points.append(summarize_text(text.strip(), 90))
    return points[:5]


def build_prompt(job: dict) -> str:
    input_text = str(job.get("input") or "")
    params = job.get("params") if isinstance(job.get("params"), dict) else {}
    mode = str(params.get("mode") or "nemoclaw_job")
    return (
        "You are a remote NemoClaw execution node. Return JSON only with keys "
        "summary (string), key_points (string array), suggested_next_action (string). "
        "Do not wrap in markdown.\n"
        f"mode: {mode}\n"
        f"input:\n{input_text}"
    )


def parse_ollama_structured(raw_output: str, fallback_input: str) -> tuple[str, list[str], str]:
    text = raw_output.strip()
    if text:
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                summary = parsed.get("summary")
                key_points = parsed.get("key_points")
                next_action = parsed.get("suggested_next_action")
                if isinstance(summary, str) and isinstance(next_action, str):
                    points = key_points if isinstance(key_points, list) else []
                    return (
                        summary,
                        [item for item in points if isinstance(item, str)],
                        next_action,
                    )
        except json.JSONDecodeError:
            pass

    return (
        summarize_text(fallback_input or "NemoClaw job received."),
        make_key_points(fallback_input or "NemoClaw job received."),
        "Review the generated points and hand off the next concrete action.",
    )


def ollama_generate(job: dict, ollama_url: str, ollama_model: str, timeout: float) -> dict:
    prompt = build_prompt(job)
    status, body = request_json(
        "POST",
        f"{ollama_url}/api/generate",
        body={"model": ollama_model, "prompt": prompt, "stream": False},
        timeout=timeout,
    )
    if status != 200:
        raise RuntimeError(f"ollama generate failed with status={status} body={json.dumps(body, ensure_ascii=False)}")
    response_text = body.get("response") if isinstance(body, dict) else None
    if not isinstance(response_text, str):
        raise RuntimeError("ollama generate response missing text body")
    return {"raw_output": response_text, "parsed": parse_ollama_structured(response_text, str(job.get('input') or ''))}


def build_result(job: dict, runner_name: str, ollama_url: str, ollama_model: str, ollama_timeout: float) -> dict:
    input_text = str(job.get("input") or "")
    try:
        generated = ollama_generate(job, ollama_url, ollama_model, ollama_timeout)
        summary, key_points, next_step = generated["parsed"]
        return {
            "summary": summary,
            "key_points": key_points,
            "suggested_next_action": next_step,
            "raw_output": generated["raw_output"],
            "runner": runner_name,
            "exit_code": 0,
        }
    except Exception as exc:
        return {
            "summary": summarize_text(input_text or "NemoClaw job received."),
            "key_points": make_key_points(input_text or "NemoClaw job received."),
            "suggested_next_action": "Check the runner error and retry once Ollama is available.",
            "raw_output": input_text,
            "runner": runner_name,
            "exit_code": 1,
            "error": str(exc),
        }


def fetch_next_job(base_url: str, token: str | None) -> dict | None:
    status, body = request_json("GET", f"{base_url}/jobs/next", token=token)
    if status == 200:
        return body
    if status == 404 and body.get("error") == "no_queued_jobs":
        return None
    raise RuntimeError(f"jobs/next failed with status={status} body={json.dumps(body, ensure_ascii=False)}")


def complete_job(base_url: str, job_id: str, token: str | None, result: dict) -> dict:
    status, body = request_json("POST", f"{base_url}/jobs/{job_id}/complete", token=token, body={"result": result})
    if status != 200:
        raise RuntimeError(f"jobs/{job_id}/complete failed with status={status} body={json.dumps(body, ensure_ascii=False)}")
    return body


def heartbeat_job(base_url: str, job_id: str, token: str | None) -> dict:
    status, body = request_json("POST", f"{base_url}/jobs/{job_id}/heartbeat", token=token)
    if status != 200:
        raise RuntimeError(f"jobs/{job_id}/heartbeat failed with status={status} body={json.dumps(body, ensure_ascii=False)}")
    return body


def resolve_heartbeat_interval(job: dict, requested_interval: float) -> float:
    lease_timeout = job.get("lease_timeout_sec")
    if isinstance(lease_timeout, (int, float)) and lease_timeout > 0:
        return max(1.0, min(float(requested_interval), float(lease_timeout) * 0.4))
    return max(1.0, float(requested_interval))


def heartbeat_loop(base_url: str, job_id: str, token: str | None, interval_sec: float, stop_event: threading.Event) -> None:
    while not stop_event.wait(interval_sec):
        try:
            heartbeat_job(base_url, job_id, token)
            log(f"heartbeat ok job_id={job_id} interval={interval_sec:.1f}s")
        except Exception as exc:
            log(f"heartbeat failed job_id={job_id} error={exc}")


def main() -> int:
    args = parse_args()
    token = resolve_token(args)
    base_url = args.base_url.rstrip("/")

    log(f"starting base_url={base_url} once={args.once} runner={args.runner_name}")
    while True:
        job = fetch_next_job(base_url, token)
        if not job:
            log("no queued jobs")
            if args.once:
                return 0
            time.sleep(args.poll_interval)
            continue

        job_id = str(job.get("job_id") or "")
        mode = ""
        params = job.get("params") if isinstance(job.get("params"), dict) else {}
        if params:
            mode = str(params.get("mode") or "")
        ollama_url = resolve_ollama_url(args, params)
        heartbeat_interval = resolve_heartbeat_interval(job, args.heartbeat_interval)
        log(f"picked job_id={job_id} mode={mode or 'unknown'} status={job.get('status')}")
        log(f"ollama_host={ollama_url}")
        log(f"heartbeat_interval={heartbeat_interval:.1f}s")
        stop_event = threading.Event()
        heartbeat_thread = threading.Thread(
            target=heartbeat_loop,
            args=(base_url, job_id, token, heartbeat_interval, stop_event),
            daemon=True,
        )
        heartbeat_thread.start()
        try:
            time.sleep(max(args.processing_delay, 0.0))
            result = build_result(job, args.runner_name, ollama_url, args.ollama_model, args.ollama_timeout)
            completion = complete_job(base_url, job_id, token, result)
        finally:
            stop_event.set()
            heartbeat_thread.join(timeout=1.0)
        log(f"completed job_id={job_id} status={completion.get('status')}")
        print(json.dumps({"job_id": job_id, "result": result, "completion": completion}, ensure_ascii=False, indent=2))
        if args.once:
            return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        log("stopped by user")
        raise SystemExit(130)
