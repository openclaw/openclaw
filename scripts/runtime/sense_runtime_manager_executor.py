#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from sense_runtime_manager_signal_classifier import classify_manager_signal


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


def derive_post_task_final_state(result: dict) -> str:
    provider_status = result.get('provider_status')
    gpu_status = result.get('gpu_status')
    nim_status_info = result.get('nim_status_info')
    model_status = result.get('model_status')

    if isinstance(provider_status, dict) and provider_status.get('provider_ready') is False:
        return 'provider_not_ready'
    if isinstance(nim_status_info, dict) and nim_status_info.get('nim_ready') is False:
        return 'nim_not_ready'
    if isinstance(gpu_status, dict) and gpu_status.get('gpu_ready') is False:
        return 'gpu_not_ready'
    if isinstance(model_status, dict):
        if model_status.get('selected_model_match') is False:
            return 'selected_model_mismatch'
        if model_status.get('selected_model_present') is False:
            return 'selected_model_missing'
        if model_status.get('default_model_present') is False:
            return 'default_model_missing'
        if model_status.get('model_ready') is False:
            return 'model_not_ready'
    if result.get('readiness') == 'degraded':
        return 'manager_action_required'
    return 'ready_for_runtime_task'


def build_post_task_policy_payload(task_result: dict) -> dict:
    result = task_result.get('result')
    normalized_result = result if isinstance(result, dict) else {}
    policy_input = (
        normalized_result.get('policy_input')
        if isinstance(normalized_result.get('policy_input'), dict)
        else {}
    )
    merged_policy_input = dict(policy_input)
    for key in (
        'provider_status',
        'gpu_status',
        'nim_status_info',
        'model_status',
        'provider',
        'provider_runtime_recognized',
        'selected_model_expected',
        'selected_model_runtime',
        'selected_model_runtime_recognized',
        'selected_model_diff_reason',
    ):
        if key in normalized_result and key not in merged_policy_input:
            merged_policy_input[key] = normalized_result.get(key)

    retry = normalized_result.get('retry')
    return {
        'final_state': str(
            normalized_result.get('final_state') or derive_post_task_final_state(normalized_result)
        ),
        'next_step': str(
            normalized_result.get('next_step')
            or normalized_result.get('suggested_next_action')
            or 'manual_review'
        ),
        'retry': retry if isinstance(retry, dict) else {},
        'policy_input': merged_policy_input,
    }


def run_post_task_policy(script_dir: Path, payload: dict) -> dict:
    cmd = [
        str(script_dir / 'sense-runtime-manager-policy.sh'),
        '--input-json',
        json.dumps(payload, ensure_ascii=False),
    ]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = (
            completed.stderr.strip()
            or completed.stdout.strip()
            or f'policy command failed with exit code {completed.returncode}'
        )
        return {
            'error': error_text,
            'exit_code': completed.returncode,
        }
    return json.loads(completed.stdout)


def evaluate_post_task_followup(
    script_dir: Path,
    task_result: dict,
    current_action: str | None,
    current_step: str | None,
) -> dict:
    payload = build_post_task_policy_payload(task_result)
    classification = classify_manager_signal(payload)
    confidence = classification.get('confidence')
    same_action = False
    policy_output = run_post_task_policy(script_dir, payload)
    next_action = None
    next_step = None
    stop_reason = None
    if isinstance(policy_output, dict) and not policy_output.get('error'):
        proposed_action = policy_output.get('manager_action')
        proposed_step = policy_output.get('next_step')
        same_action = proposed_action == current_action and proposed_step == current_step
        if isinstance(confidence, (int, float)) and confidence < 0.5:
            stop_reason = 'post-task evaluation confidence is below threshold'
        elif policy_output.get('confidence_gate_applied') is True:
            stop_reason = 'post-task evaluation requested fallback handling'
        elif same_action:
            stop_reason = 'post-task evaluation produced the same action and step, so executor will not loop'
        else:
            next_action = proposed_action
            next_step = proposed_step
    else:
        stop_reason = str(policy_output.get('error') or 'post-task policy evaluation failed')

    return {
        'reclassified_issue': classification.get('primary_issue') or classification.get('classified_issue'),
        'secondary_issues': classification.get('secondary_issues', []),
        'next_action': next_action,
        'next_step': next_step,
        'confidence': confidence,
        'priority': classification.get('priority'),
        'stop_reason': stop_reason,
        'same_action_blocked': same_action,
        'policy_output': policy_output,
    }


def decide_post_task_followup(
    post_task_evaluation: dict | None,
    current_action: str | None,
    current_step: str | None,
    fallback_action: str | None,
) -> tuple[bool, str | None]:
    evaluation = post_task_evaluation if isinstance(post_task_evaluation, dict) else {}
    next_action = evaluation.get('next_action')
    next_step = evaluation.get('next_step')
    confidence = evaluation.get('confidence')
    if evaluation.get('same_action_blocked') is True:
        return False, 'same_action_step'

    if not next_action or not next_step:
        stop_reason = str(evaluation.get('stop_reason') or '')
        if 'confidence is below threshold' in stop_reason:
            return False, 'low_confidence'
        return False, 'incomplete_followup_candidate'
    if next_action == fallback_action:
        return False, 'fallback_action'
    if next_action in NON_EXECUTING_ACTIONS:
        return False, 'non_executing_followup_action'
    if next_action == current_action and next_step == current_step:
        return False, 'same_action_step'
    if not isinstance(confidence, (int, float)) or confidence < 0.5:
        return False, 'low_confidence'
    return True, None


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
    if manager_action == 'run_runtime_task' and main_exit_code == 0:
        post_task_evaluation = evaluate_post_task_followup(
            script_dir,
            main_result,
            manager_action,
            next_step,
        )
        output['post_task_evaluation'] = post_task_evaluation
        allow_followup, block_reason = decide_post_task_followup(
            post_task_evaluation,
            manager_action,
            next_step,
            fallback_action,
        )
        output['post_task_followup_executed'] = False
        output['post_task_followup_blocked'] = not allow_followup
        output['post_task_followup_block_reason'] = block_reason
        output['post_task_followup_result'] = None
        if allow_followup:
            followup_action = str(post_task_evaluation.get('next_action'))
            followup_step = str(post_task_evaluation.get('next_step'))
            followup_task_payload = (
                main_task_payload if followup_action == 'run_runtime_task' else None
            )
            followup_result = execute_step(
                script_dir,
                followup_action,
                followup_step,
                runtime_args,
                followup_task_payload,
            )
            output['post_task_followup_executed'] = True
            output['post_task_followup_blocked'] = False
            output['post_task_followup_block_reason'] = None
            output['post_task_followup_result'] = followup_result
            output['executor_state'] = 'completed_with_followup_executed'
        elif post_task_evaluation.get('next_action'):
            output['executor_state'] = 'completed_with_followup_candidate'
        else:
            output['executor_state'] = 'completed_resolved'
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
