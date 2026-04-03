#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


NON_EXECUTING_ACTIONS = {'manual_review', 'stop_and_surface_diff'}

ACTION_STEP_DEFAULTS = {
    'configure_provider': 'check_provider_config',
    'configure_model': 'check_selected_model_config',
    'configure_gpu_runtime': 'configure_gpu_runtime',
    'start_nim_runtime': 'start_nim_runtime',
    'review_runtime_capabilities': 'review_runtime_capabilities',
    'retry_once': 'check_selected_model_config',
    'run_runtime_task': 'run_runtime_task',
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Thin manager executor for Sense runtime policy plans.'
    )
    parser.add_argument('--policy-json')
    parser.add_argument('--token', required=True)
    parser.add_argument('--sandbox-name', required=True)
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    return parser


def load_policy(args: argparse.Namespace) -> dict:
    if args.policy_json:
        return json.loads(args.policy_json)
    raw = sys.stdin.read()
    if not raw.strip():
        raise SystemExit('expected policy JSON on stdin or via --policy-json')
    return json.loads(raw)


def build_runtime_args(args: argparse.Namespace) -> list[str]:
    runtime_args = ['--token', args.token, '--sandbox-name', args.sandbox_name]
    if args.timeout is not None:
        runtime_args.extend(['--timeout', str(args.timeout)])
    if args.wait_timeout is not None:
        runtime_args.extend(['--wait-timeout', str(args.wait_timeout)])
    if args.poll_interval is not None:
        runtime_args.extend(['--poll-interval', str(args.poll_interval)])
    if args.input:
        runtime_args.extend(['--input', args.input])
    return runtime_args


def execute_step(
    script_dir: Path,
    action: str | None,
    step: str | None,
    runtime_args: list[str],
) -> dict:
    resolved_action = action or 'unknown'
    resolved_step = step or ACTION_STEP_DEFAULTS.get(resolved_action)
    if resolved_action in NON_EXECUTING_ACTIONS or not resolved_step:
        return {
            'action': resolved_action,
            'step': resolved_step,
            'executed': False,
            'result': None,
        }

    cmd = [
        str(script_dir / 'sense-runtime-remediation.sh'),
        *runtime_args,
        '--recommended-action',
        resolved_step,
    ]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or f'command failed with exit code {completed.returncode}'
        return {
            'action': resolved_action,
            'step': resolved_step,
            'executed': True,
            'result': {
                'error': error_text,
                'exit_code': completed.returncode,
            },
        }
    result = json.loads(completed.stdout)
    return {
        'action': resolved_action,
        'step': resolved_step,
        'executed': True,
        'result': result,
    }


def main() -> int:
    args = build_parser().parse_args()
    policy = load_policy(args)
    script_dir = Path(__file__).resolve().parent
    runtime_args = build_runtime_args(args)

    manager_action = policy.get('manager_action')
    next_step = policy.get('next_step')
    secondary_action = policy.get('secondary_action')
    secondary_next_step = policy.get('secondary_next_step')
    fallback_action = policy.get('fallback_action')
    confidence_gate_applied = policy.get('confidence_gate_applied') is True

    if confidence_gate_applied or manager_action in NON_EXECUTING_ACTIONS:
        output = {
            'executor_state': 'stopped',
            'stop_reason': 'confidence gate requested fallback handling' if confidence_gate_applied else f'manager action {manager_action} is non-executing',
            'main_action': {
                'action': manager_action,
                'step': next_step,
                'executed': False,
                'result': None,
            },
            'secondary_action': {
                'action': secondary_action,
                'step': secondary_next_step,
                'executed': False,
                'result': None,
            },
            'fallback_action': fallback_action,
            'policy_trace': policy.get('policy_trace', {}),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    main_result = execute_step(script_dir, manager_action, next_step, runtime_args)
    if main_result.get('executed') and isinstance(main_result.get('result'), dict) and main_result['result'].get('error'):
        output = {
            'executor_state': 'failed',
            'main_action': main_result,
            'secondary_action': {
                'action': secondary_action,
                'step': secondary_next_step,
                'executed': False,
                'result': None,
            },
            'fallback_action': fallback_action,
            'policy_trace': policy.get('policy_trace', {}),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 1

    secondary_result = {
        'action': secondary_action,
        'step': secondary_next_step,
        'executed': False,
        'result': None,
    }
    if secondary_action:
        secondary_result = execute_step(script_dir, secondary_action, secondary_next_step, runtime_args)
        if secondary_result.get('executed') and isinstance(secondary_result.get('result'), dict) and secondary_result['result'].get('error'):
            output = {
                'executor_state': 'failed',
                'main_action': main_result,
                'secondary_action': secondary_result,
                'fallback_action': fallback_action,
                'policy_trace': policy.get('policy_trace', {}),
            }
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 1

    output = {
        'executor_state': 'completed',
        'main_action': main_result,
        'secondary_action': secondary_result,
        'fallback_action': fallback_action,
        'policy_trace': policy.get('policy_trace', {}),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
