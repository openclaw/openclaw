#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
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


def strip_input_arg(runtime_args: list[str]) -> list[str]:
    stripped: list[str] = []
    index = 0
    while index < len(runtime_args):
        item = runtime_args[index]
        if item == '--input':
            index += 2
            continue
        stripped.append(item)
        index += 1
    return stripped


def normalize_task_payload(raw_payload: dict | None, fallback_input: str | None) -> dict:
    payload = raw_payload if isinstance(raw_payload, dict) else {}
    raw_params = payload.get('params')
    params = raw_params if isinstance(raw_params, dict) else {}
    task = str(payload.get('task') or params.get('task_type') or 'run')
    input_text = payload.get('input')
    if not isinstance(input_text, str) or not input_text.strip():
        input_text = fallback_input or 'Run a Sense runtime task from the manager executor.'
    return {
        'task': task,
        'input': input_text,
        'params': params,
    }


def execute_step(
    script_dir: Path,
    action: str | None,
    step: str | None,
    runtime_args: list[str],
    task_payload: dict | None = None,
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

    if resolved_action == 'run_runtime_task' or resolved_step == 'run_runtime_task':
        normalized_task_payload = normalize_task_payload(task_payload, None)
        cmd = [
            str(script_dir / 'sense-runtime-manager-task.sh'),
            *strip_input_arg(runtime_args),
            '--task',
            normalized_task_payload['task'],
            '--input',
            normalized_task_payload['input'],
            '--params-json',
            json.dumps(normalized_task_payload['params'], ensure_ascii=False),
        ]
    else:
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


def extract_step_exit_code(step_result: dict) -> int | None:
    if not isinstance(step_result, dict):
        return None
    result = step_result.get('result')
    if not isinstance(result, dict):
        return None
    exit_code = result.get('exit_code')
    return exit_code if isinstance(exit_code, int) else None


def build_secondary_placeholder(action: str | None, step: str | None) -> dict:
    return {
        'action': action,
        'step': step,
        'executed': False,
        'result': None,
    }


def build_exit_summary(
    main_result: dict | None,
    secondary_result: dict | None,
) -> dict:
    return {
        'main_exit_code': extract_step_exit_code(main_result or {}),
        'secondary_executed': bool(
            isinstance(secondary_result, dict) and secondary_result.get('executed')
        ),
        'secondary_exit_code': extract_step_exit_code(secondary_result or {}),
    }


def collect_main_warnings(step_result: dict) -> list[str]:
    if not isinstance(step_result, dict):
        return []
    result = step_result.get('result')
    if not isinstance(result, dict):
        return []

    warnings: list[str] = []
    if result.get('readiness') == 'degraded':
        warnings.append('runtime readiness remains degraded after main action')

    missing_requirements = result.get('missing_requirements')
    if isinstance(missing_requirements, list):
        for requirement in missing_requirements:
            if isinstance(requirement, str) and requirement.strip():
                warnings.append(f'missing requirement remains: {requirement.strip()}')

    details = result.get('details')
    if isinstance(details, dict):
        details_warnings = details.get('warnings')
        if isinstance(details_warnings, list):
            for item in details_warnings:
                if isinstance(item, str) and item.strip():
                    warnings.append(item.strip())
        warning_text = details.get('warning')
        if isinstance(warning_text, str) and warning_text.strip():
            warnings.append(warning_text.strip())

    for status_key, label in (
        ('provider_status', 'provider'),
        ('gpu_status', 'gpu'),
        ('nim_status_info', 'nim'),
        ('model_status', 'model'),
    ):
        status = result.get(status_key)
        if not isinstance(status, dict):
            continue
        nested_missing = status.get('missing_requirements')
        if isinstance(nested_missing, list):
            for requirement in nested_missing:
                if isinstance(requirement, str) and requirement.strip():
                    warnings.append(f'{label} requirement remains: {requirement.strip()}')
        for ready_key, ready_label in (
            ('provider_ready', 'provider readiness'),
            ('gpu_ready', 'gpu readiness'),
            ('nim_ready', 'nim readiness'),
            ('model_ready', 'model readiness'),
        ):
            if status.get(ready_key) is False:
                warnings.append(f'{ready_label} is still false after main action')

    top_level_warnings = result.get('warnings')
    if isinstance(top_level_warnings, list):
        for item in top_level_warnings:
            if isinstance(item, str) and item.strip():
                warnings.append(item.strip())

    deduped: list[str] = []
    seen: set[str] = set()
    for warning in warnings:
        if warning not in seen:
            deduped.append(warning)
            seen.add(warning)
    return deduped


def main() -> int:
    started_at = time.monotonic()
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
    main_task_payload = normalize_task_payload(
        policy.get('main_task_payload') or policy.get('task_payload'),
        args.input,
    )
    secondary_task_payload = normalize_task_payload(
        policy.get('secondary_task_payload') or policy.get('task_payload'),
        args.input,
    )

    secondary_placeholder = build_secondary_placeholder(
        secondary_action, secondary_next_step
    )
    empty_warnings: list[str] = []

    if confidence_gate_applied or manager_action in NON_EXECUTING_ACTIONS:
        main_placeholder = {
            'action': manager_action,
            'step': next_step,
            'executed': False,
            'result': None,
        }
        output = {
            'executor_state': 'stopped',
            'stop_reason': 'confidence gate requested fallback handling' if confidence_gate_applied else f'manager action {manager_action} is non-executing',
            'secondary_gate_decision': 'stop_secondary',
            'secondary_gate_reason': 'executor stopped before main execution',
            'secondary_gate_warning': False,
            'warnings': empty_warnings,
            'warning_count': 0,
            'main_action': main_placeholder,
            'secondary_action': secondary_placeholder,
            'task_payload': {
                'main': main_task_payload if manager_action == 'run_runtime_task' else None,
                'secondary': secondary_task_payload if secondary_action == 'run_runtime_task' else None,
            },
            'fallback_action': fallback_action,
            'duration_sec': round(time.monotonic() - started_at, 3),
            'exit_summary': build_exit_summary(main_placeholder, secondary_placeholder),
            'policy_trace': policy.get('policy_trace', {}),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    main_result = execute_step(
        script_dir,
        manager_action,
        next_step,
        runtime_args,
        main_task_payload,
    )
    main_exit_code = extract_step_exit_code(main_result)
    main_error = (
        main_result.get('executed')
        and isinstance(main_result.get('result'), dict)
        and main_result['result'].get('error')
    )
    main_warnings = collect_main_warnings(main_result)
    if main_error:
        output = {
            'executor_state': 'failed',
            'secondary_gate_decision': 'skip_secondary',
            'secondary_gate_reason': 'main action returned an error payload',
            'secondary_gate_warning': False,
            'warnings': main_warnings,
            'warning_count': len(main_warnings),
            'main_action': main_result,
            'secondary_action': secondary_placeholder,
            'task_payload': {
                'main': main_task_payload if manager_action == 'run_runtime_task' else None,
                'secondary': secondary_task_payload if secondary_action == 'run_runtime_task' else None,
            },
            'fallback_action': fallback_action,
            'duration_sec': round(time.monotonic() - started_at, 3),
            'exit_summary': build_exit_summary(main_result, secondary_placeholder),
            'policy_trace': policy.get('policy_trace', {}),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 1

    if main_exit_code is not None and main_exit_code != 0:
        output = {
            'executor_state': 'partial_failure',
            'secondary_gate_decision': 'skip_secondary',
            'secondary_gate_reason': 'main action failed with non-zero exit_code',
            'secondary_gate_warning': bool(main_warnings),
            'warnings': main_warnings,
            'warning_count': len(main_warnings),
            'main_action': main_result,
            'secondary_action': secondary_placeholder,
            'task_payload': {
                'main': main_task_payload if manager_action == 'run_runtime_task' else None,
                'secondary': secondary_task_payload if secondary_action == 'run_runtime_task' else None,
            },
            'fallback_action': fallback_action,
            'duration_sec': round(time.monotonic() - started_at, 3),
            'exit_summary': build_exit_summary(main_result, secondary_placeholder),
            'policy_trace': policy.get('policy_trace', {}),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 1

    secondary_result = secondary_placeholder
    secondary_gate_decision = 'skip_secondary'
    secondary_gate_reason = 'no secondary action planned'
    secondary_gate_warning = bool(main_warnings)
    if secondary_action:
        if main_warnings:
            secondary_gate_decision = 'continue_with_warning'
            secondary_gate_reason = 'main action completed but runtime readiness signals still show warnings'
        else:
            secondary_gate_decision = 'continue_secondary'
            secondary_gate_reason = 'main action completed without an error payload or non-zero exit code'
        secondary_result = execute_step(
            script_dir,
            secondary_action,
            secondary_next_step,
            runtime_args,
            secondary_task_payload,
        )
        if secondary_result.get('executed') and isinstance(secondary_result.get('result'), dict) and secondary_result['result'].get('error'):
            output = {
                'executor_state': 'failed',
                'secondary_gate_decision': secondary_gate_decision,
                'secondary_gate_reason': secondary_gate_reason,
                'secondary_gate_warning': secondary_gate_warning,
                'warnings': main_warnings,
                'warning_count': len(main_warnings),
                'main_action': main_result,
                'secondary_action': secondary_result,
                'task_payload': {
                    'main': main_task_payload if manager_action == 'run_runtime_task' else None,
                    'secondary': secondary_task_payload if secondary_action == 'run_runtime_task' else None,
                },
                'fallback_action': fallback_action,
                'duration_sec': round(time.monotonic() - started_at, 3),
                'exit_summary': build_exit_summary(main_result, secondary_result),
                'policy_trace': policy.get('policy_trace', {}),
            }
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 1

        secondary_exit_code = extract_step_exit_code(secondary_result)
        if secondary_exit_code is not None and secondary_exit_code != 0:
            output = {
                'executor_state': 'partial_failure',
                'secondary_gate_decision': secondary_gate_decision,
                'secondary_gate_reason': secondary_gate_reason,
                'secondary_gate_warning': secondary_gate_warning,
                'warnings': main_warnings,
                'warning_count': len(main_warnings),
                'main_action': main_result,
                'secondary_action': secondary_result,
                'task_payload': {
                    'main': main_task_payload if manager_action == 'run_runtime_task' else None,
                    'secondary': secondary_task_payload if secondary_action == 'run_runtime_task' else None,
                },
                'fallback_action': fallback_action,
                'duration_sec': round(time.monotonic() - started_at, 3),
                'exit_summary': build_exit_summary(main_result, secondary_result),
                'policy_trace': policy.get('policy_trace', {}),
            }
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 1

    output = {
        'executor_state': 'completed_with_warning' if main_warnings else 'completed',
        'secondary_gate_decision': secondary_gate_decision,
        'secondary_gate_reason': secondary_gate_reason,
        'secondary_gate_warning': secondary_gate_warning,
        'warnings': main_warnings,
        'warning_count': len(main_warnings),
        'main_action': main_result,
        'secondary_action': secondary_result,
        'task_payload': {
            'main': main_task_payload if manager_action == 'run_runtime_task' else None,
            'secondary': secondary_task_payload if secondary_action == 'run_runtime_task' else None,
        },
        'fallback_action': fallback_action,
        'duration_sec': round(time.monotonic() - started_at, 3),
        'exit_summary': build_exit_summary(main_result, secondary_result),
        'policy_trace': policy.get('policy_trace', {}),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
