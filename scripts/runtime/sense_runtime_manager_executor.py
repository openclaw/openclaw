#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4

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


def compact_path_codes(executor_state: str | None, policy: dict) -> list[str]:
    codes: list[str] = []
    policy_trace = policy.get('policy_trace') if isinstance(policy.get('policy_trace'), dict) else {}
    rule_id = str(policy_trace.get('rule_id') or '')
    policy_version = str(policy.get('policy_table_version') or '')
    if 'entry_shortcut' in rule_id or policy_version.endswith('shortcut'):
        codes.extend(['HANDOFF', 'SHORTCUT'])
    elif rule_id:
        codes.append('FULL_EVAL')
    if policy.get('manager_action'):
        codes.append('EXECUTOR')
    if executor_state == 'failed':
        codes.append('FAILED')
    elif executor_state == 'stopped':
        codes.append('STOPPED')
    deduped: list[str] = []
    seen: set[str] = set()
    for code in codes:
        if code not in seen:
            deduped.append(code)
            seen.add(code)
    return deduped


def normalize_executor_error_code(output: dict) -> str:
    executor_state = str(output.get('executor_state') or '')
    if executor_state == 'stopped':
        return 'EXECUTOR_STOPPED'

    main_result = extract_result_payload(output.get('main_action'))
    secondary_result = extract_result_payload(output.get('secondary_action'))
    error_text = str(
        main_result.get('error')
        or secondary_result.get('error')
        or output.get('stop_reason')
        or ''
    ).lower()

    if 'unauthorized' in error_text or 'status=401' in error_text:
        return 'UNAUTHORIZED'
    if 'timeout' in error_text:
        return 'TIMEOUT'
    if 'submit failed' in error_text:
        return 'RUNTIME_SUBMIT_FAILED'
    if executor_state in {'failed', 'partial_failure'}:
        return 'EXECUTOR_FAILED'
    return 'NONE'


def normalize_executor_error_detail_code(output: dict) -> str:
    executor_state = str(output.get('executor_state') or '')
    if executor_state == 'stopped':
        stop_reason = str(output.get('stop_reason') or '').lower()
        if 'confidence gate' in stop_reason:
            return 'EXECUTOR_STOP_CONFIDENCE_GATE'
        return 'EXECUTOR_STOP_MANUAL_REVIEW'

    main_result = extract_result_payload(output.get('main_action'))
    secondary_result = extract_result_payload(output.get('secondary_action'))
    error_text = str(
        main_result.get('error')
        or secondary_result.get('error')
        or output.get('secondary_gate_reason')
        or ''
    ).lower()

    if 'status=401' in error_text or 'unauthorized' in error_text:
        return 'AUTH_401'
    if 'token' in error_text and 'missing' in error_text:
        return 'AUTH_TOKEN_MISSING'
    if 'timeout' in error_text and 'executor' in error_text:
        return 'TIMEOUT_EXECUTOR'
    if 'timeout' in error_text:
        return 'TIMEOUT_EXECUTOR'
    if 'submit failed status=4' in error_text:
        return 'SUBMIT_HTTP_4XX'
    if 'submit failed status=5' in error_text:
        return 'SUBMIT_HTTP_5XX'
    return 'NONE'


def normalize_executor_error_source_layer(output: dict) -> str:
    error_code = str(output.get('error_code') or '')
    error_detail_code = str(output.get('error_detail_code') or '')
    if error_code == 'NONE':
        return 'NONE'
    if error_code == 'EXECUTOR_STOPPED':
        return 'EXECUTOR'
    if error_detail_code in {
        'AUTH_401',
        'AUTH_TOKEN_MISSING',
        'TIMEOUT_EXECUTOR',
        'SUBMIT_HTTP_4XX',
        'SUBMIT_HTTP_5XX',
    }:
        return 'RUNTIME_BRIDGE'
    return 'EXECUTOR'


def normalize_executor_error_stage(output: dict) -> str:
    error_code = str(output.get('error_code') or '')
    error_detail_code = str(output.get('error_detail_code') or '')
    executor_state = str(output.get('executor_state') or '')
    if error_code == 'NONE':
        return 'NONE'
    if executor_state == 'stopped':
        return 'EXECUTOR_GATE'

    followup_result = output.get('post_task_followup_result')
    followup_payload = extract_result_payload(followup_result)
    followup_exit_code = extract_step_exit_code(followup_result or {})
    if (
        output.get('post_task_followup_executed') is True
        and (
            followup_payload.get('error')
            or (followup_exit_code is not None and followup_exit_code != 0)
        )
    ):
        return 'POST_TASK_FOLLOWUP'

    main_action = output.get('main_action') if isinstance(output.get('main_action'), dict) else {}
    secondary_action = output.get('secondary_action') if isinstance(output.get('secondary_action'), dict) else {}
    action_name = str(
        main_action.get('action')
        or secondary_action.get('action')
        or ''
    )
    error_text = str(
        extract_result_payload(main_action).get('error')
        or extract_result_payload(secondary_action).get('error')
        or output.get('secondary_gate_reason')
        or ''
    ).lower()

    if action_name == 'run_runtime_task':
        if 'poll' in error_text or 'wait' in error_text or error_detail_code == 'TIMEOUT_EXECUTOR':
            return 'TASK_POLL'
        return 'TASK_SUBMIT'
    return 'REMEDIATION'


def finalize_output(output: dict) -> dict:
    output['error_code'] = normalize_executor_error_code(output)
    output['error_detail_code'] = normalize_executor_error_detail_code(output)
    output['error_source_layer'] = normalize_executor_error_source_layer(output)
    output['error_stage'] = normalize_executor_error_stage(output)
    output['manager_handoff'] = build_manager_handoff(output)
    return output


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


def extract_result_payload(step_result: dict | None) -> dict:
    if not isinstance(step_result, dict):
        return {}
    result = step_result.get('result')
    return result if isinstance(result, dict) else {}


def collect_remaining_issues(result: dict) -> list[str]:
    issues: list[str] = []
    missing_requirements = result.get('missing_requirements')
    if isinstance(missing_requirements, list):
        for item in missing_requirements:
            if isinstance(item, str) and item.strip():
                issues.append(item.strip())
    for status_key in ('provider_status', 'gpu_status', 'nim_status_info', 'model_status'):
        status = result.get(status_key)
        if not isinstance(status, dict):
            continue
        nested_missing = status.get('missing_requirements')
        if isinstance(nested_missing, list):
            for item in nested_missing:
                if isinstance(item, str) and item.strip():
                    issues.append(item.strip())
    deduped: list[str] = []
    seen: set[str] = set()
    for item in issues:
        if item not in seen:
            deduped.append(item)
            seen.add(item)
    return deduped


def derive_readiness(result: dict) -> str | None:
    readiness = result.get('readiness')
    if isinstance(readiness, str) and readiness.strip():
        return readiness.strip()
    if (
        isinstance(result.get('provider_status'), dict)
        and result['provider_status'].get('provider_ready') is True
        and isinstance(result.get('gpu_status'), dict)
        and result['gpu_status'].get('gpu_ready') is True
        and isinstance(result.get('nim_status_info'), dict)
        and result['nim_status_info'].get('nim_ready') is True
        and isinstance(result.get('model_status'), dict)
        and result['model_status'].get('model_ready') is True
    ):
        return 'ready'
    return None


def evaluate_loop_convergence(
    main_result: dict | None,
    followup_result: dict | None,
    main_warnings: list[str],
) -> dict:
    if not isinstance(followup_result, dict) or not followup_result.get('executed'):
        return {
            'state': 'no_followup',
            'reason': 'no post-task follow-up was executed',
            'improvement_detected': False,
            'remaining_issues': [],
        }

    followup_payload = extract_result_payload(followup_result)
    followup_error = followup_payload.get('error')
    followup_exit_code = extract_step_exit_code(followup_result)
    if followup_error or (followup_exit_code is not None and followup_exit_code != 0):
        return {
            'state': 'unresolved',
            'reason': 'post-task follow-up failed or returned a non-zero exit code',
            'improvement_detected': False,
            'remaining_issues': collect_remaining_issues(followup_payload),
        }

    main_payload = extract_result_payload(main_result)
    main_readiness = derive_readiness(main_payload) or 'unknown'
    followup_readiness = derive_readiness(followup_payload) or 'unknown'
    followup_warnings = collect_main_warnings(followup_result)
    remaining_issues = collect_remaining_issues(followup_payload)
    improvement_detected = (
        main_readiness == 'degraded' and followup_readiness == 'ready'
    )

    if followup_readiness == 'ready' and not remaining_issues and not followup_warnings:
        return {
            'state': 'resolved',
            'reason': 'post-task follow-up reached ready state without remaining issues or warnings',
            'improvement_detected': improvement_detected or not bool(main_warnings),
            'remaining_issues': [],
        }

    if main_readiness == 'ready' and followup_readiness == 'degraded':
        return {
            'state': 'unresolved',
            'reason': 'post-task follow-up regressed runtime readiness from ready to degraded',
            'improvement_detected': False,
            'remaining_issues': remaining_issues or followup_warnings,
        }

    if followup_readiness == 'ready' and (remaining_issues or followup_warnings):
        return {
            'state': 'partially_resolved',
            'reason': 'post-task follow-up reached ready state but still reports issues or warnings',
            'improvement_detected': improvement_detected or bool(main_warnings),
            'remaining_issues': remaining_issues or followup_warnings,
        }

    if followup_readiness == 'degraded' or remaining_issues or followup_warnings:
        return {
            'state': 'partially_resolved',
            'reason': 'post-task follow-up completed but degraded signals or remaining issues are still present',
            'improvement_detected': improvement_detected,
            'remaining_issues': remaining_issues or followup_warnings,
        }

    return {
        'state': 'partially_resolved',
        'reason': 'post-task follow-up completed but convergence could not be confirmed as fully resolved',
        'improvement_detected': improvement_detected,
        'remaining_issues': remaining_issues or followup_warnings,
    }


def classify_remaining_issue(issue: str) -> str | None:
    normalized = issue.strip()
    mapping = (
        ('API key missing:', 'provider_api_key_issue'),
        ('provider runtime not recognizing configured provider', 'provider_recognition_issue'),
        ('nim is not running', 'runtime_capability_issue_nim'),
        ('gpu runtime not enabled', 'runtime_capability_issue_gpu'),
        ('runtime selected model differs from configured selected model', 'selected_model_mismatch_issue'),
        ('runtime not recognizing selected model', 'selected_model_retry_issue'),
    )
    for prefix, classified in mapping:
        if normalized.startswith(prefix):
            return classified
    return None


def summarize_loop_convergence(convergence: dict | None) -> dict | None:
    if not isinstance(convergence, dict):
        return None
    remaining_issues = convergence.get('remaining_issues')
    if not isinstance(remaining_issues, list):
        remaining_issues = []

    priority_order = {
        'provider_api_key_issue': 0,
        'provider_recognition_issue': 1,
        'runtime_capability_issue_nim': 2,
        'runtime_capability_issue_gpu': 3,
        'selected_model_mismatch_issue': 4,
        'selected_model_retry_issue': 5,
    }
    classified: list[str] = []
    for item in remaining_issues:
        if not isinstance(item, str):
            continue
        classified_issue = classify_remaining_issue(item)
        if classified_issue and classified_issue not in classified:
            classified.append(classified_issue)

    classified.sort(key=lambda item: priority_order.get(item, 999))
    primary = classified[0] if classified else None
    secondary = classified[1:] if len(classified) > 1 else []
    suggested_map = {
        'provider_api_key_issue': 'check_api_key_config',
        'provider_recognition_issue': 'check_provider_config',
        'runtime_capability_issue_nim': 'start_nim_runtime',
        'runtime_capability_issue_gpu': 'configure_gpu_runtime',
        'selected_model_mismatch_issue': 'check_selected_model_config',
        'selected_model_retry_issue': 'check_selected_model_config',
    }
    confidence_map = {
        'provider_api_key_issue': 0.86,
        'provider_recognition_issue': 0.8,
        'runtime_capability_issue_nim': 0.72,
        'runtime_capability_issue_gpu': 0.7,
        'selected_model_mismatch_issue': 0.68,
        'selected_model_retry_issue': 0.6,
    }
    return {
        'primary_remaining_issue': primary,
        'secondary_remaining_issues': secondary,
        'suggested_next_step': suggested_map.get(primary),
        'summary_confidence': confidence_map.get(primary, 0.4 if primary else 0.0),
    }


def build_manager_handoff(report: dict) -> dict:
    loop_convergence = report.get('loop_convergence')
    loop_convergence_summary = report.get('loop_convergence_summary')
    summary = loop_convergence_summary if isinstance(loop_convergence_summary, dict) else {}
    convergence = loop_convergence if isinstance(loop_convergence, dict) else {}

    notes: list[str] = []
    warnings = report.get('warnings')
    if isinstance(warnings, list):
        for item in warnings:
            if isinstance(item, str) and item.strip():
                notes.append(item.strip())
    for field in (
        convergence.get('reason'),
        report.get('secondary_gate_reason'),
        report.get('post_task_followup_block_reason'),
    ):
        if isinstance(field, str) and field.strip():
            notes.append(field.strip())
    deduped_notes: list[str] = []
    seen_notes: set[str] = set()
    for item in notes:
        if item not in seen_notes:
            deduped_notes.append(item)
            seen_notes.add(item)
    deduped_notes = deduped_notes[:5]

    main_action = report.get('main_action')
    secondary_action = report.get('secondary_action')
    last_main_action = (
        main_action.get('action') if isinstance(main_action, dict) else None
    )
    last_secondary_action = (
        secondary_action.get('action') if isinstance(secondary_action, dict) else None
    )

    suggested_next_step = summary.get('suggested_next_step')
    if not suggested_next_step and report.get('executor_state') in {'failed', 'stopped'}:
        suggested_next_step = None

    return {
        'handoff_version': 'v1',
        'decision_trace_id': report.get('decision_trace_id'),
        'trace_parent_span_id': report.get('executor_trace_span_id'),
        'path_codes': compact_path_codes(
            report.get('executor_state'),
            {
                'policy_trace': report.get('policy_trace', {}),
                'policy_table_version': report.get('policy_table_version'),
                'manager_action': (report.get('main_action') or {}).get('action') if isinstance(report.get('main_action'), dict) else None,
            },
        ),
        'source': 'sense_runtime_manager_executor',
        'executor_state': report.get('executor_state'),
        'error_code': report.get('error_code'),
        'error_detail_code': report.get('error_detail_code'),
        'error_source_layer': report.get('error_source_layer'),
        'error_stage': report.get('error_stage'),
        'loop_convergence_state': convergence.get('state'),
        'primary_remaining_issue': summary.get('primary_remaining_issue'),
        'secondary_remaining_issues': summary.get('secondary_remaining_issues', []),
        'suggested_next_step': suggested_next_step,
        'summary_confidence': summary.get('summary_confidence', 0.0),
        'last_main_action': last_main_action,
        'last_secondary_action': last_secondary_action,
        'notes': deduped_notes,
    }


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
    decision_trace_id = policy.get('decision_trace_id')
    dispatch_trace_span_id = policy.get('dispatch_trace_span_id')
    executor_trace_span_id = policy.get('executor_trace_span_id') or f'executor-{uuid4().hex[:4]}'
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
            'decision_trace_id': decision_trace_id,
            'dispatch_trace_span_id': dispatch_trace_span_id,
            'executor_trace_span_id': executor_trace_span_id,
            'policy_table_version': policy.get('policy_table_version'),
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
        output = finalize_output(output)
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
            'decision_trace_id': decision_trace_id,
            'dispatch_trace_span_id': dispatch_trace_span_id,
            'executor_trace_span_id': executor_trace_span_id,
            'policy_table_version': policy.get('policy_table_version'),
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
        output = finalize_output(output)
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 1

    if main_exit_code is not None and main_exit_code != 0:
        output = {
            'decision_trace_id': decision_trace_id,
            'dispatch_trace_span_id': dispatch_trace_span_id,
            'executor_trace_span_id': executor_trace_span_id,
            'policy_table_version': policy.get('policy_table_version'),
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
        output = finalize_output(output)
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
                'decision_trace_id': decision_trace_id,
                'dispatch_trace_span_id': dispatch_trace_span_id,
                'executor_trace_span_id': executor_trace_span_id,
                'policy_table_version': policy.get('policy_table_version'),
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
            output = finalize_output(output)
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 1

        secondary_exit_code = extract_step_exit_code(secondary_result)
        if secondary_exit_code is not None and secondary_exit_code != 0:
            output = {
                'decision_trace_id': decision_trace_id,
                'dispatch_trace_span_id': dispatch_trace_span_id,
                'executor_trace_span_id': executor_trace_span_id,
                'policy_table_version': policy.get('policy_table_version'),
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
            output = finalize_output(output)
            print(json.dumps(output, ensure_ascii=False, indent=2))
            return 1

    output = {
        'decision_trace_id': decision_trace_id,
        'dispatch_trace_span_id': dispatch_trace_span_id,
        'executor_trace_span_id': executor_trace_span_id,
        'policy_table_version': policy.get('policy_table_version'),
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
        output['loop_convergence'] = evaluate_loop_convergence(
            main_result,
            None,
            main_warnings,
        )
        output['loop_convergence_summary'] = summarize_loop_convergence(
            output['loop_convergence']
        )
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
            output['loop_convergence'] = evaluate_loop_convergence(
                main_result,
                followup_result,
                main_warnings,
            )
            output['loop_convergence_summary'] = summarize_loop_convergence(
                output['loop_convergence']
            )
            output['executor_state'] = 'completed_with_followup_executed'
        elif post_task_evaluation.get('next_action'):
            output['executor_state'] = 'completed_with_followup_candidate'
        else:
            output['executor_state'] = 'completed_resolved'
    output = finalize_output(output)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
