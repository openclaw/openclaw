#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import sense_runtime_bridge as bridge


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Thin manager-side runtime task launcher for Sense runtime.'
    )
    parser.add_argument('--task', required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--params-json')
    parser.add_argument('--base-url', default=bridge.DEFAULT_BASE_URL)
    parser.add_argument('--token')
    parser.add_argument('--token-env', default=bridge.DEFAULT_TOKEN_ENV)
    parser.add_argument('--timeout', type=float, default=bridge.DEFAULT_TIMEOUT)
    parser.add_argument('--wait-timeout', type=float, default=bridge.DEFAULT_WAIT_TIMEOUT)
    parser.add_argument('--poll-interval', type=float, default=bridge.DEFAULT_POLL_INTERVAL)
    parser.add_argument('--sandbox-name')
    return parser


def load_params(raw: str | None) -> dict:
    if not raw:
        return {}
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, dict) else {}


def build_runtime_params(task: str, params: dict, sandbox_name: str | None) -> dict:
    merged = {
        'mode': 'nemoclaw_job',
        'scope': 'nemoclaw',
        'job_profile': 'future-nemoclaw',
        'runtime_plane': 'wsl',
        'gpu_profile': 'single-gpu-safe',
        'model': 'nemoclaw-minimal',
        'timeout_sec': 120.0,
        'wsl_distro': 'Ubuntu',
        'wsl_nemoclaw_root': '~/NemoClaw',
        'wsl_node_bin': bridge.DEFAULT_WSL_NODE_BIN,
    }
    merged.update(params)
    merged['manager_task'] = task
    merged.setdefault('task_type', task)
    if sandbox_name:
        merged['sandbox_name'] = sandbox_name
    return merged


def submit_manager_task(
    base_url: str,
    token: str | None,
    timeout: float,
    task: str,
    input_text: str,
    params: dict,
):
    payload = {
        'task': 'heavy_task',
        'input': input_text,
        'params': params,
    }
    status, body = bridge.request_json(
        'POST',
        f"{base_url.rstrip('/')}/execute",
        payload,
        timeout,
        token=token,
    )
    if status != 200:
        raise RuntimeError(
            f"submit failed status={status} body={json.dumps(body, ensure_ascii=False)}"
        )
    result = body.get('result') if isinstance(body, dict) else None
    if not isinstance(result, dict) or not result.get('job_id'):
        raise RuntimeError(
            f"submit returned unexpected body={json.dumps(body, ensure_ascii=False)}"
        )
    return result


def main() -> int:
    args = build_parser().parse_args()
    token = bridge.resolve_token(args.token, args.token_env)
    params = build_runtime_params(
        args.task,
        load_params(args.params_json),
        args.sandbox_name,
    )
    submit_result = submit_manager_task(
        args.base_url,
        token,
        args.timeout,
        args.task,
        args.input,
        params,
    )
    completed = bridge.poll_until_done(
        args.base_url.rstrip('/'),
        token,
        args.timeout,
        args.wait_timeout,
        args.poll_interval,
        str(submit_result['job_id']),
    )
    task_type = str(params.get('task_type') or args.task)
    completed = bridge.sanitize_runtime_result(task_type, completed)
    result = completed.get('result') if isinstance(completed, dict) else {}
    normalized = result if isinstance(result, dict) else {'result': result}
    normalized['sense_job_id'] = str(submit_result['job_id'])
    normalized['task_payload'] = {
        'task': args.task,
        'input': args.input,
        'params': params,
    }
    print(json.dumps(normalized, ensure_ascii=False))
    if isinstance(result, dict) and int(result.get('exit_code', 0)) != 0:
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
