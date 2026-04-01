#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

BACKOFF_SCHEDULE = [2, 4, 8]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Minimal remediation helper for Sense runtime readiness decisions.'
    )
    parser.add_argument('--token', required=True)
    parser.add_argument('--sandbox-name', required=True)
    parser.add_argument('--recommended-action')
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    return parser


def run_cmd(cmd: list[str], stdin_text: str | None = None) -> tuple[int, str, str]:
    completed = subprocess.run(
        cmd,
        input=stdin_text,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


def run_json(cmd: list[str], stdin_text: str | None = None) -> dict:
    code, stdout, stderr = run_cmd(cmd, stdin_text=stdin_text)
    if code != 0:
        if stderr:
            sys.stderr.write(stderr)
            if not stderr.endswith('\n'):
                sys.stderr.write('\n')
        raise SystemExit(code)
    return json.loads(stdout)


def tool_cmd(script_dir: Path, script_name: str, *args: str) -> list[str]:
    return [str(script_dir / script_name), *args]


def maybe_append_runtime_args(cmd: list[str], args: argparse.Namespace) -> list[str]:
    enriched = list(cmd)
    if args.timeout is not None:
        enriched.extend(['--timeout', str(args.timeout)])
    if args.wait_timeout is not None:
        enriched.extend(['--wait-timeout', str(args.wait_timeout)])
    if args.poll_interval is not None:
        enriched.extend(['--poll-interval', str(args.poll_interval)])
    if args.input:
        enriched.extend(['--input', args.input])
    return enriched


def get_decision(script_dir: Path, args: argparse.Namespace) -> dict:
    cmd = tool_cmd(
        script_dir,
        'sense-runtime-decision.sh',
        '--token', args.token,
        '--sandbox-name', args.sandbox_name,
    )
    cmd = maybe_append_runtime_args(cmd, args)
    return run_json(cmd)


def get_sandbox_status(script_dir: Path, args: argparse.Namespace) -> dict:
    cmd = tool_cmd(
        script_dir,
        'sense-runtime-manager-tool.sh',
        '--intent', 'sense sandbox status',
        '--token', args.token,
        '--sandbox-name', args.sandbox_name,
    )
    cmd = maybe_append_runtime_args(cmd, args)
    return run_json(cmd)


def get_runtime_status(script_dir: Path, args: argparse.Namespace) -> dict:
    cmd = tool_cmd(
        script_dir,
        'sense-runtime-manager-tool.sh',
        '--intent', 'sense runtime status',
        '--token', args.token,
    )
    cmd = maybe_append_runtime_args(cmd, args)
    return run_json(cmd)


def run_runtime_start(script_dir: Path, args: argparse.Namespace) -> dict:
    cmd = tool_cmd(
        script_dir,
        'sense-runtime-manager-tool.sh',
        '--intent', 'sense runtime start',
        '--token', args.token,
    )
    cmd = maybe_append_runtime_args(cmd, args)
    return run_json(cmd)


def summarize_capabilities(sandbox_payload: dict) -> dict:
    details = sandbox_payload.get('details') if isinstance(sandbox_payload, dict) else None
    sandbox_status = details.get('sandbox_status') if isinstance(details, dict) else {}
    if not isinstance(sandbox_status, dict):
        sandbox_status = {}
    return {
        'sandbox_name': sandbox_status.get('sandbox_name'),
        'gpu_enabled': sandbox_status.get('gpu_enabled'),
        'policy_names': sandbox_status.get('policy_names') or [],
        'runtime_name': sandbox_status.get('runtime_name'),
        'openshell_status': sandbox_status.get('openshell_status'),
        'nim_status': sandbox_status.get('nim_status'),
        'provider': sandbox_status.get('provider'),
        'model': sandbox_status.get('model'),
    }


def infer_missing_requirements(provider_status: dict, start_result: dict | None) -> list[str]:
    missing: list[str] = []
    provider = str(provider_status.get('provider') or 'unknown')
    model = str(provider_status.get('model') or 'unknown')
    nim_status = str(provider_status.get('nim_status') or 'unknown')
    gpu_enabled = provider_status.get('gpu_enabled')

    if provider in {'', 'unknown'}:
        missing.append('provider configuration missing')
    if model in {'', 'unknown'}:
        missing.append('model configuration missing')
    if nim_status.lower() != 'running':
        missing.append('nim is not running')
    if gpu_enabled is False:
        missing.append('gpu runtime not enabled')

    if isinstance(start_result, dict):
        haystacks = []
        summary = start_result.get('summary')
        if isinstance(summary, str):
            haystacks.append(summary.lower())
        for item in start_result.get('key_points') if isinstance(start_result.get('key_points'), list) else []:
            if isinstance(item, str):
                haystacks.append(item.lower())
        text = ' '.join(haystacks)
        if 'api key required' in text or 'nvidia api key' in text:
            missing.append('API key may be required')

    deduped: list[str] = []
    for item in missing:
        if item not in deduped:
            deduped.append(item)
    return deduped


def build_provider_status(provider_status: dict, start_result: dict | None) -> dict:
    status = dict(provider_status)
    missing = infer_missing_requirements(status, start_result)
    provider_ready = len(missing) == 0
    status['provider_ready'] = provider_ready
    status['missing_requirements'] = missing
    return status


def main() -> int:
    args = build_parser().parse_args()
    script_dir = Path(__file__).resolve().parent

    decision = get_decision(script_dir, args)
    recommended_action = args.recommended_action or str(decision.get('recommended_action') or '')
    readiness = str(decision.get('readiness') or 'unknown')

    response: dict = {
        'readiness': readiness,
        'recommended_action': recommended_action,
        'remediation_action': recommended_action,
        'reasons': decision.get('reasons') if isinstance(decision.get('reasons'), list) else [],
        'next_step': decision.get('next_step') or 'manual_review',
    }

    if recommended_action == 'check_runtime_provider':
        sandbox_payload = get_sandbox_status(script_dir, args)
        provider_signals = summarize_capabilities(sandbox_payload)
        start_result = run_runtime_start(script_dir, args)
        followup_status = get_decision(script_dir, args)
        provider_status = build_provider_status(provider_signals, start_result)
        response['remediation_result'] = 'checked provider readiness and triggered sense runtime start'
        response['provider_status'] = provider_status
        response['start_result'] = start_result
        response['followup_status'] = followup_status
        if provider_status.get('provider_ready') is False:
            response['next_step'] = 'configure_provider'
        else:
            response['next_step'] = followup_status.get('next_step') or response['next_step']
    elif recommended_action == 'check_gpu_runtime':
        sandbox_payload = get_sandbox_status(script_dir, args)
        response['remediation_result'] = 'captured gpu runtime status'
        response['followup_status'] = summarize_capabilities(sandbox_payload)
        response['next_step'] = 'inspect_gpu_runtime'
    elif recommended_action == 'wait_for_runtime_ready':
        attempts: list[dict] = []
        last_decision = decision
        for delay in BACKOFF_SCHEDULE:
            attempts.append({'sleep_sec': delay, 'decision': last_decision})
            if str(last_decision.get('readiness') or '') == 'ready':
                break
            time.sleep(delay)
            last_decision = get_decision(script_dir, args)
        response['remediation_result'] = 'retried runtime readiness checks'
        response['followup_status'] = {
            'attempts': attempts,
            'final_decision': last_decision,
        }
        response['next_step'] = last_decision.get('next_step') or response['next_step']
    elif recommended_action == 'review_runtime_capabilities':
        sandbox_payload = get_sandbox_status(script_dir, args)
        response['remediation_result'] = 'reviewed runtime capabilities'
        response['followup_status'] = summarize_capabilities(sandbox_payload)
        response['next_step'] = 'review_runtime_capabilities'
    else:
        response['remediation_result'] = 'no remediation mapping found'
        response['followup_status'] = decision
        response['next_step'] = decision.get('next_step') or 'manual_review'

    print(json.dumps(response, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())