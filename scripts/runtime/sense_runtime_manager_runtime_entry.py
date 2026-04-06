#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from uuid import uuid4


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Single manager runtime entrypoint that chains manager entry and dispatch.'
    )
    parser.add_argument('--handoff-json')
    parser.add_argument('--token', required=True)
    parser.add_argument('--sandbox-name', required=True)
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    parser.add_argument('--feedback-json')
    return parser


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


def build_decision_trace_id() -> str:
    timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
    return f'rtx-{timestamp}-{uuid4().hex[:6]}'


def build_span_id(prefix: str) -> str:
    return f'{prefix}-{uuid4().hex[:4]}'


def run_entry(script_dir: Path, args: argparse.Namespace, runtime_args: list[str]) -> dict:
    cmd = [str(script_dir / 'sense-runtime-manager-entry.sh'), *runtime_args]
    if args.handoff_json:
        cmd.extend(['--handoff-json', args.handoff_json])
    if args.feedback_json:
        cmd.extend(['--feedback-json', args.feedback_json])
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'manager entry failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def run_dispatch(script_dir: Path, entry_result: dict, runtime_args: list[str]) -> dict:
    cmd = [
        str(script_dir / 'sense-runtime-manager-dispatch.sh'),
        '--entry-json',
        json.dumps(entry_result, ensure_ascii=False),
        *runtime_args,
    ]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'manager dispatch failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def run_bridge(script_dir: Path, entry_result: dict, handoff_json: str | None) -> dict:
    cmd = [
        str(script_dir / 'sense-runtime-manager-policy-bridge.sh'),
        '--entry-json',
        json.dumps(entry_result, ensure_ascii=False),
    ]
    if handoff_json:
        cmd.extend(['--handoff-json', handoff_json])
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'manager policy bridge failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def run_executor(script_dir: Path, policy_payload: dict, runtime_args: list[str]) -> dict:
    cmd = [
        str(script_dir / 'sense-runtime-manager-executor.sh'),
        '--policy-json',
        json.dumps(policy_payload, ensure_ascii=False),
        *runtime_args,
    ]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'manager executor failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def infer_runtime_entry_state(dispatch_result: dict) -> str:
    result = dispatch_result.get('dispatch_result')
    if isinstance(result, dict):
        executor_state = result.get('executor_state')
        if isinstance(executor_state, str) and executor_state.strip():
            return executor_state
    return 'completed'


def build_path_summary(args: argparse.Namespace, entry_result: dict, bridge_result: dict, dispatch_result: dict) -> dict:
    entry_decision = str(entry_result.get('entry_decision') or 'unknown')
    used_handoff = bool(args.handoff_json)
    used_bridge = bridge_result.get('bridge_used') is True
    used_shortcut = used_bridge or dispatch_result.get('shortcut_used') is True
    used_full_evaluator = str(dispatch_result.get('dispatch_mode') or '') == 'full_evaluator'
    if not used_full_evaluator and (not used_handoff or entry_decision in {'hint_only', 'rerun_full_evaluator'}):
        used_full_evaluator = True

    if not used_handoff:
        path_taken = 'no_handoff -> full_evaluator'
    elif entry_decision == 'use_handoff' and used_shortcut and used_bridge:
        path_taken = 'handoff -> triage(use_handoff) -> shortcut -> bridge -> executor'
    elif entry_decision == 'hint_only':
        path_taken = 'handoff -> triage(hint_only) -> full_evaluator'
    elif entry_decision == 'rerun_full_evaluator':
        path_taken = 'handoff -> triage(rerun_full_evaluator) -> full_evaluator'
    elif entry_decision == 'use_handoff' and used_shortcut:
        path_taken = 'handoff -> triage(use_handoff) -> shortcut -> executor'
    else:
        path_taken = f'handoff -> triage({entry_decision}) -> full_evaluator'

    return {
        'path_taken': path_taken,
        'used_handoff': used_handoff,
        'used_shortcut': used_shortcut,
        'used_bridge': used_bridge,
        'used_full_evaluator': used_full_evaluator,
    }


def build_path_tags(
    args: argparse.Namespace,
    entry_result: dict | None,
    bridge_result: dict | None,
    dispatch_result: dict | None,
    runtime_entry_state: str,
) -> list[str]:
    tags: list[str] = []
    used_handoff = bool(args.handoff_json)
    if used_handoff:
        tags.append('handoff')
    else:
        tags.append('no_handoff')

    if used_handoff and isinstance(entry_result, dict):
        entry_decision = entry_result.get('entry_decision')
        if isinstance(entry_decision, str) and entry_decision.strip():
            tags.append(f'triage:{entry_decision}')

    if isinstance(bridge_result, dict) and bridge_result.get('bridge_used') is True:
        tags.append('shortcut')
        tags.append('bridge')

    if isinstance(dispatch_result, dict):
        dispatch_mode = dispatch_result.get('dispatch_mode')
        if dispatch_mode == 'full_evaluator':
            tags.append('full_evaluator')
        if isinstance(dispatch_result.get('dispatch_result'), dict):
            tags.append('executor')
    elif not used_handoff or (
        isinstance(entry_result, dict)
        and entry_result.get('entry_decision') in {'hint_only', 'rerun_full_evaluator'}
    ):
        tags.append('full_evaluator')

    if runtime_entry_state == 'failed':
        tags.append('failed')
    elif runtime_entry_state == 'stopped':
        tags.append('stopped')

    deduped: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        if tag not in seen:
            deduped.append(tag)
            seen.add(tag)
    return deduped


def build_path_codes(path_tags: list[str]) -> list[str]:
    mapping = {
        'handoff': 'HANDOFF',
        'no_handoff': 'NO_HANDOFF',
        'triage:use_handoff': 'TRIAGE_USE',
        'triage:hint_only': 'TRIAGE_HINT',
        'triage:rerun_full_evaluator': 'TRIAGE_RERUN',
        'shortcut': 'SHORTCUT',
        'bridge': 'BRIDGE',
        'full_evaluator': 'FULL_EVAL',
        'executor': 'EXECUTOR',
        'failed': 'FAILED',
        'stopped': 'STOPPED',
    }
    codes: list[str] = []
    seen: set[str] = set()
    for tag in path_tags:
        code = mapping.get(tag)
        if code and code not in seen:
            codes.append(code)
            seen.add(code)
    return codes


def normalize_error_code(runtime_entry_state: str, error_text: str | None) -> str:
    if runtime_entry_state == 'stopped':
        return 'EXECUTOR_STOPPED'
    if isinstance(error_text, str):
        lowered = error_text.lower()
        if 'unauthorized' in lowered or 'status=401' in lowered:
            return 'UNAUTHORIZED'
        if 'timeout' in lowered:
            return 'TIMEOUT'
        if 'submit failed' in lowered:
            return 'RUNTIME_SUBMIT_FAILED'
    if runtime_entry_state == 'failed':
        return 'EXECUTOR_FAILED'
    return 'NONE'


def normalize_error_detail_code(
    runtime_entry_state: str,
    error_text: str | None,
    dispatch_result: dict | None,
) -> str:
    if runtime_entry_state == 'stopped':
        dispatch_payload = (dispatch_result or {}).get('dispatch_result') if isinstance(dispatch_result, dict) else {}
        if isinstance(dispatch_payload, dict):
            stop_reason = dispatch_payload.get('stop_reason')
            if isinstance(stop_reason, str):
                lowered = stop_reason.lower()
                if 'confidence gate' in lowered:
                    return 'EXECUTOR_STOP_CONFIDENCE_GATE'
                if 'manual_review' in lowered or 'manual review' in lowered:
                    return 'EXECUTOR_STOP_MANUAL_REVIEW'
        return 'EXECUTOR_STOP_MANUAL_REVIEW'
    if isinstance(error_text, str):
        lowered = error_text.lower()
        if 'status=401' in lowered or 'unauthorized' in lowered:
            return 'AUTH_401'
        if 'token' in lowered and 'missing' in lowered:
            return 'AUTH_TOKEN_MISSING'
        if 'timeout' in lowered and 'executor' in lowered:
            return 'TIMEOUT_EXECUTOR'
        if 'timeout' in lowered:
            return 'TIMEOUT_ENTRY'
        if 'submit failed' in lowered and 'status=4' in lowered:
            return 'SUBMIT_HTTP_4XX'
        if 'submit failed' in lowered and 'status=5' in lowered:
            return 'SUBMIT_HTTP_5XX'
    return 'NONE'


def normalize_error_source_layer(
    runtime_entry_state: str,
    error_text: str | None,
    dispatch_result: dict | None,
) -> str:
    dispatch_payload = (dispatch_result or {}).get('dispatch_result') if isinstance(dispatch_result, dict) else None
    if isinstance(dispatch_payload, dict):
        nested_source = dispatch_payload.get('error_source_layer')
        if isinstance(nested_source, str) and nested_source.strip() and nested_source != 'NONE':
            return nested_source

    lowered = str(error_text or '').lower()
    if 'sense_runtime_bridge.py' in lowered or 'submit failed' in lowered or 'status=401' in lowered or 'unauthorized' in lowered:
        return 'RUNTIME_BRIDGE'
    if runtime_entry_state == 'stopped':
        return 'EXECUTOR'
    if runtime_entry_state == 'failed':
        if isinstance(dispatch_result, dict) and (
            dispatch_result.get('dispatch_mode') is not None or dispatch_result.get('error')
        ):
            return 'DISPATCH'
        return 'ENTRY'
    return 'NONE'


def normalize_error_stage(
    runtime_entry_state: str,
    error_text: str | None,
    dispatch_result: dict | None,
) -> str:
    dispatch_payload = (dispatch_result or {}).get('dispatch_result') if isinstance(dispatch_result, dict) else None
    if isinstance(dispatch_payload, dict):
        nested_stage = dispatch_payload.get('error_stage')
        if isinstance(nested_stage, str) and nested_stage.strip() and nested_stage != 'NONE':
            return nested_stage

    lowered = str(error_text or '').lower()
    if 'handoff triage' in lowered or 'triage' in lowered:
        return 'TRIAGE'
    if 'policy bridge failed' in lowered or 'sense-runtime-manager-policy-bridge' in lowered:
        return 'BRIDGE'
    if 'manager dispatch failed' in lowered or 'sense-runtime-manager-dispatch' in lowered:
        return 'DISPATCH'
    if 'sense_runtime_bridge.py' in lowered or 'submit failed' in lowered:
        if 'timeout' in lowered and ('poll' in lowered or 'wait' in lowered):
            return 'TASK_POLL'
        return 'TASK_SUBMIT'
    if runtime_entry_state == 'stopped':
        return 'EXECUTOR_GATE'
    return 'NONE'


def derive_recovery_hint(
    error_code: str | None,
    error_detail_code: str | None,
    error_stage: str | None,
) -> str:
    detail = str(error_detail_code or '')
    stage = str(error_stage or '')
    code = str(error_code or '')
    if detail == 'AUTH_401':
        return 'check_token'
    if stage == 'TASK_SUBMIT':
        return 'check_runtime_submit_path'
    if stage == 'TASK_POLL':
        return 'check_runtime_poll_path'
    if stage == 'EXECUTOR_GATE':
        return 'check_executor_gate'
    if stage == 'BRIDGE':
        return 'check_bridge_mapping'
    if stage == 'DISPATCH':
        return 'check_dispatch_input'
    if stage == 'TRIAGE':
        return 'check_triage_input'
    if code == 'NONE':
        return 'no_action_needed'
    return 'check_dispatch_input'


def derive_recovery_priority(
    error_code: str | None,
    error_detail_code: str | None,
    error_stage: str | None,
) -> str:
    detail = str(error_detail_code or '')
    stage = str(error_stage or '')
    code = str(error_code or '')
    if detail == 'AUTH_401':
        return 'immediate'
    if stage in {'TASK_SUBMIT', 'TASK_POLL'}:
        return 'high'
    if stage in {'EXECUTOR_GATE', 'BRIDGE', 'DISPATCH'}:
        return 'medium'
    if stage == 'TRIAGE':
        return 'low'
    if code == 'NONE':
        return 'none'
    return 'medium'


def build_layer_statuses(entry_result: dict | None, bridge_result: dict | None, dispatch_result: dict | None) -> dict:
    entry_status = 'completed' if isinstance(entry_result, dict) else None
    bridge_status = None
    if isinstance(bridge_result, dict) and bridge_result.get('bridge_used') is True:
        bridge_status = 'used'
    dispatch_status = dispatch_result.get('dispatch_mode') if isinstance(dispatch_result, dict) else None
    executor_status = None
    if isinstance(dispatch_result, dict):
        dispatch_payload = dispatch_result.get('dispatch_result')
        if isinstance(dispatch_payload, dict):
            raw_executor_status = dispatch_payload.get('executor_state')
            executor_status = raw_executor_status if isinstance(raw_executor_status, str) else None
    return {
        'entry_status': entry_status,
        'bridge_status': bridge_status,
        'dispatch_status': dispatch_status,
        'executor_status': executor_status,
    }


def attach_trace_to_dispatch_result(dispatch_result: dict | None, decision_trace_id: str, dispatch_trace_span_id: str) -> str | None:
    if not isinstance(dispatch_result, dict):
        return None
    dispatch_result['decision_trace_id'] = decision_trace_id
    dispatch_result['dispatch_trace_span_id'] = dispatch_trace_span_id
    dispatch_payload = dispatch_result.get('dispatch_result')
    if isinstance(dispatch_payload, dict):
        executor_trace_span_id = dispatch_payload.get('executor_trace_span_id')
        return executor_trace_span_id if isinstance(executor_trace_span_id, str) else None
    return None


def extract_loop_convergence(dispatch_result: dict) -> dict | None:
    result = dispatch_result.get('dispatch_result')
    if isinstance(result, dict):
        convergence = result.get('loop_convergence')
        if isinstance(convergence, dict):
            return convergence
    return None


def extract_manager_handoff(dispatch_result: dict) -> dict | None:
    result = dispatch_result.get('dispatch_result')
    if isinstance(result, dict):
        handoff = result.get('manager_handoff')
        if isinstance(handoff, dict):
            return handoff
    return None


def extract_last_success_action(dispatch_result: dict) -> str | None:
    result = dispatch_result.get('dispatch_result')
    if not isinstance(result, dict):
        return None
    main_action = result.get('main_action')
    if not isinstance(main_action, dict):
        return None
    if main_action.get('executed') is not True:
        return None
    action = main_action.get('action')
    return action if isinstance(action, str) and action.strip() else None


def build_feedback_summary(entry_result: dict, dispatch_result: dict) -> dict:
    shortcut_used = dispatch_result.get('shortcut_used') is True
    dispatch_mode = str(dispatch_result.get('dispatch_mode') or '')
    executor_state = infer_runtime_entry_state(dispatch_result)
    loop_convergence = extract_loop_convergence(dispatch_result)
    convergence_state = None
    if isinstance(loop_convergence, dict):
        raw_state = loop_convergence.get('state')
        convergence_state = raw_state if isinstance(raw_state, str) else None

    feedback_gate_applied = entry_result.get('feedback_gate_applied') is True
    fallback_triggered = dispatch_mode == 'full_evaluator' or feedback_gate_applied
    fallback_reason = None
    if feedback_gate_applied:
        feedback_reason = entry_result.get('feedback_gate_reason')
        fallback_reason = feedback_reason if isinstance(feedback_reason, str) else 'feedback gate forced full evaluator'
    elif dispatch_mode == 'full_evaluator':
        dispatch_reason = dispatch_result.get('dispatch_reason')
        fallback_reason = dispatch_reason if isinstance(dispatch_reason, str) else 'full evaluator path was used'

    if shortcut_used and executor_state.startswith('completed') and convergence_state == 'resolved':
        decision_quality = 'good'
    elif shortcut_used and convergence_state in {'partially_resolved', 'unresolved', 'no_followup'}:
        decision_quality = 'degraded'
    elif dispatch_mode == 'full_evaluator':
        decision_quality = 'poor'
    else:
        decision_quality = 'degraded'

    if shortcut_used:
        loop_efficiency = 'shortcut'
    elif entry_result.get('handoff_used') is True:
        loop_efficiency = 'mixed'
    else:
        loop_efficiency = 'full_evaluator'

    return {
        'decision_quality': decision_quality,
        'shortcut_accuracy': bool(shortcut_used and convergence_state == 'resolved'),
        'fallback_triggered': fallback_triggered,
        'fallback_reason': fallback_reason,
        'loop_efficiency': loop_efficiency,
    }


def build_feedback_memory(entry_result: dict, dispatch_result: dict, feedback_summary: dict) -> dict:
    manager_handoff = extract_manager_handoff(dispatch_result) or {}
    last_primary_issue = manager_handoff.get('primary_remaining_issue')
    if not isinstance(last_primary_issue, str) or not last_primary_issue.strip():
        last_primary_issue = entry_result.get('primary_remaining_issue')
    return {
        'last_decision_quality': feedback_summary.get('decision_quality'),
        'last_primary_issue': last_primary_issue,
        'last_success_action': extract_last_success_action(dispatch_result),
        'last_path_codes': manager_handoff.get('path_codes', []),
        'last_error_code': manager_handoff.get('error_code'),
        'last_error_detail_code': manager_handoff.get('error_detail_code'),
        'last_error_source_layer': manager_handoff.get('error_source_layer'),
        'last_error_stage': manager_handoff.get('error_stage'),
        'last_recovery_hint': manager_handoff.get('recovery_hint'),
        'last_recovery_priority': manager_handoff.get('recovery_priority'),
    }


def main() -> int:
    args = build_parser().parse_args()
    script_dir = Path(__file__).resolve().parent
    runtime_args = build_runtime_args(args)
    decision_trace_id = build_decision_trace_id()
    entry_trace_span_id = build_span_id('entry')
    dispatch_trace_span_id = build_span_id('dispatch')
    entry_result: dict | None = None
    bridge_result: dict | None = None
    dispatch_result: dict | None = None
    entry_duration_sec: float | None = None
    dispatch_duration_sec: float | None = None
    executor_duration_sec: float | None = None
    executor_trace_span_id: str | None = None

    try:
        started = time.perf_counter()
        entry_result = run_entry(script_dir, args, runtime_args)
        entry_duration_sec = round(time.perf_counter() - started, 6)
        entry_result['decision_trace_id'] = decision_trace_id
        entry_result['entry_trace_span_id'] = entry_trace_span_id

        started = time.perf_counter()
        bridge_result = run_bridge(script_dir, entry_result, args.handoff_json)
        dispatch_duration_sec = round(time.perf_counter() - started, 6)
        if isinstance(bridge_result, dict):
            bridge_result['dispatch_trace_span_id'] = dispatch_trace_span_id

        if bridge_result.get('bridge_used') is True:
            manager_policy_outcome = bridge_result.get('manager_policy_outcome') or {}
            manager_policy_outcome['decision_trace_id'] = decision_trace_id
            manager_policy_outcome['dispatch_trace_span_id'] = dispatch_trace_span_id
            executor_trace_span_id = build_span_id('executor')
            manager_policy_outcome['executor_trace_span_id'] = executor_trace_span_id
            started = time.perf_counter()
            executor_result = run_executor(script_dir, manager_policy_outcome, runtime_args)
            executor_duration_sec = round(time.perf_counter() - started, 6)
            dispatch_result = {
                'decision_trace_id': decision_trace_id,
                'dispatch_trace_span_id': dispatch_trace_span_id,
                'dispatch_mode': 'shortcut_executor',
                'shortcut_used': True,
                'dispatch_reason': 'lightweight policy bridge promoted the handoff shortcut into a direct executor path',
                'dispatch_result': executor_result,
            }
        else:
            started = time.perf_counter()
            dispatch_result = run_dispatch(script_dir, entry_result, runtime_args)
            dispatch_duration_sec = round(time.perf_counter() - started, 6)
            executor_trace_span_id = attach_trace_to_dispatch_result(
                dispatch_result,
                decision_trace_id,
                dispatch_trace_span_id,
            )

        runtime_entry_state = infer_runtime_entry_state(dispatch_result)
        feedback_summary = build_feedback_summary(entry_result, dispatch_result)
        feedback_memory = build_feedback_memory(entry_result, dispatch_result, feedback_summary)
        path_summary = build_path_summary(args, entry_result, bridge_result or {}, dispatch_result)
        path_tags = build_path_tags(args, entry_result, bridge_result, dispatch_result, runtime_entry_state)
        layer_statuses = build_layer_statuses(entry_result, bridge_result, dispatch_result)
        error_code = normalize_error_code(runtime_entry_state, None)
        error_detail_code = normalize_error_detail_code(runtime_entry_state, None, dispatch_result)
        error_source_layer = normalize_error_source_layer(runtime_entry_state, None, dispatch_result)
        error_stage = normalize_error_stage(runtime_entry_state, None, dispatch_result)
        output = {
            'decision_trace_id': decision_trace_id,
            'entry_trace_span_id': entry_trace_span_id,
            'dispatch_trace_span_id': dispatch_trace_span_id,
            'dispatch_trace_parent_span_id': entry_trace_span_id,
            'executor_trace_span_id': executor_trace_span_id,
            'executor_trace_parent_span_id': dispatch_trace_span_id if executor_trace_span_id else None,
            'entry_decision': entry_result.get('entry_decision'),
            'dispatch_mode': dispatch_result.get('dispatch_mode'),
            'runtime_entry_state': runtime_entry_state,
            'path_taken': path_summary.get('path_taken'),
            'path_tags': path_tags,
            'path_codes': build_path_codes(path_tags),
            'error_code': error_code,
            'error_detail_code': error_detail_code,
            'error_source_layer': error_source_layer,
            'error_stage': error_stage,
            'recovery_hint': derive_recovery_hint(error_code, error_detail_code, error_stage),
            'recovery_priority': derive_recovery_priority(error_code, error_detail_code, error_stage),
            'used_handoff': path_summary.get('used_handoff'),
            'used_shortcut': path_summary.get('used_shortcut'),
            'used_bridge': path_summary.get('used_bridge'),
            'used_full_evaluator': path_summary.get('used_full_evaluator'),
            'entry_duration_sec': entry_duration_sec,
            'dispatch_duration_sec': dispatch_duration_sec,
            'executor_duration_sec': executor_duration_sec,
            'entry_status': layer_statuses.get('entry_status'),
            'bridge_status': layer_statuses.get('bridge_status'),
            'dispatch_status': layer_statuses.get('dispatch_status'),
            'executor_status': layer_statuses.get('executor_status'),
            'summary_counters': {
                'warning_count': len(((dispatch_result.get('dispatch_result') or {}).get('warnings') or []) if isinstance(dispatch_result, dict) else []),
                'remaining_issue_count': len((((dispatch_result.get('dispatch_result') or {}).get('loop_convergence') or {}).get('remaining_issues') or []) if isinstance(dispatch_result, dict) else []),
                'secondary_action_count': 1 if isinstance(((dispatch_result.get('dispatch_result') or {}).get('secondary_action')), dict) and (((dispatch_result.get('dispatch_result') or {}).get('secondary_action') or {}).get('executed') is True) else 0,
                'followup_executed_count': 1 if ((dispatch_result.get('dispatch_result') or {}).get('post_task_followup_executed') is True if isinstance(dispatch_result, dict) else False) else 0,
                'path_depth': len(build_path_codes(path_tags)),
            },
            'bridge_used': bridge_result.get('bridge_used') is True,
            'bridge_mode': bridge_result.get('bridge_mode'),
            'feedback_summary': feedback_summary,
            'feedback_memory': feedback_memory,
            'result': {
                'bridge': bridge_result,
                'dispatch': dispatch_result,
            },
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        entry_decision = entry_result.get('entry_decision') if isinstance(entry_result, dict) else ('rerun_full_evaluator' if not args.handoff_json else None)
        runtime_entry_state = 'failed'
        path_summary = build_path_summary(args, entry_result or {}, bridge_result or {}, dispatch_result or {})
        path_tags = build_path_tags(args, entry_result, bridge_result, dispatch_result, runtime_entry_state)
        layer_statuses = build_layer_statuses(entry_result, bridge_result, dispatch_result)
        if layer_statuses.get('entry_status') is None:
            layer_statuses['entry_status'] = 'failed'
        error_text = str(exc)
        error_code = normalize_error_code(runtime_entry_state, error_text)
        error_detail_code = normalize_error_detail_code(runtime_entry_state, error_text, dispatch_result)
        error_source_layer = normalize_error_source_layer(runtime_entry_state, error_text, dispatch_result)
        error_stage = normalize_error_stage(runtime_entry_state, error_text, dispatch_result)
        output = {
            'decision_trace_id': decision_trace_id,
            'entry_trace_span_id': entry_trace_span_id,
            'dispatch_trace_span_id': dispatch_trace_span_id,
            'dispatch_trace_parent_span_id': entry_trace_span_id,
            'executor_trace_span_id': executor_trace_span_id,
            'executor_trace_parent_span_id': dispatch_trace_span_id if executor_trace_span_id else None,
            'entry_decision': entry_decision,
            'dispatch_mode': dispatch_result.get('dispatch_mode') if isinstance(dispatch_result, dict) else None,
            'runtime_entry_state': runtime_entry_state,
            'path_taken': path_summary.get('path_taken'),
            'path_tags': path_tags,
            'path_codes': build_path_codes(path_tags),
            'error_code': error_code,
            'error_detail_code': error_detail_code,
            'error_source_layer': error_source_layer,
            'error_stage': error_stage,
            'recovery_hint': derive_recovery_hint(error_code, error_detail_code, error_stage),
            'recovery_priority': derive_recovery_priority(error_code, error_detail_code, error_stage),
            'used_handoff': path_summary.get('used_handoff'),
            'used_shortcut': path_summary.get('used_shortcut'),
            'used_bridge': path_summary.get('used_bridge'),
            'used_full_evaluator': path_summary.get('used_full_evaluator'),
            'entry_duration_sec': entry_duration_sec,
            'dispatch_duration_sec': dispatch_duration_sec,
            'executor_duration_sec': executor_duration_sec,
            'entry_status': layer_statuses.get('entry_status'),
            'bridge_status': layer_statuses.get('bridge_status'),
            'dispatch_status': layer_statuses.get('dispatch_status'),
            'executor_status': layer_statuses.get('executor_status'),
            'summary_counters': {
                'warning_count': 0,
                'remaining_issue_count': 0,
                'secondary_action_count': 0,
                'followup_executed_count': 0,
                'path_depth': len(build_path_codes(path_tags)),
            },
            'bridge_used': isinstance(bridge_result, dict) and bridge_result.get('bridge_used') is True,
            'bridge_mode': bridge_result.get('bridge_mode') if isinstance(bridge_result, dict) else None,
            'feedback_summary': None,
            'feedback_memory': None,
            'result': {
                'bridge': bridge_result,
                'dispatch': dispatch_result,
                'error': str(exc),
            },
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
