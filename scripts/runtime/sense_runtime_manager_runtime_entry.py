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
    }


def main() -> int:
    args = build_parser().parse_args()
    script_dir = Path(__file__).resolve().parent
    runtime_args = build_runtime_args(args)
    decision_trace_id = build_decision_trace_id()
    entry_result: dict | None = None
    bridge_result: dict | None = None
    dispatch_result: dict | None = None
    entry_duration_sec: float | None = None
    dispatch_duration_sec: float | None = None
    executor_duration_sec: float | None = None

    try:
        started = time.perf_counter()
        entry_result = run_entry(script_dir, args, runtime_args)
        entry_duration_sec = round(time.perf_counter() - started, 6)

        started = time.perf_counter()
        bridge_result = run_bridge(script_dir, entry_result, args.handoff_json)
        dispatch_duration_sec = round(time.perf_counter() - started, 6)

        if bridge_result.get('bridge_used') is True:
            manager_policy_outcome = bridge_result.get('manager_policy_outcome') or {}
            started = time.perf_counter()
            executor_result = run_executor(script_dir, manager_policy_outcome, runtime_args)
            executor_duration_sec = round(time.perf_counter() - started, 6)
            dispatch_result = {
                'dispatch_mode': 'shortcut_executor',
                'shortcut_used': True,
                'dispatch_reason': 'lightweight policy bridge promoted the handoff shortcut into a direct executor path',
                'dispatch_result': executor_result,
            }
        else:
            started = time.perf_counter()
            dispatch_result = run_dispatch(script_dir, entry_result, runtime_args)
            dispatch_duration_sec = round(time.perf_counter() - started, 6)

        runtime_entry_state = infer_runtime_entry_state(dispatch_result)
        feedback_summary = build_feedback_summary(entry_result, dispatch_result)
        feedback_memory = build_feedback_memory(entry_result, dispatch_result, feedback_summary)
        path_summary = build_path_summary(args, entry_result, bridge_result or {}, dispatch_result)
        output = {
            'decision_trace_id': decision_trace_id,
            'entry_decision': entry_result.get('entry_decision'),
            'dispatch_mode': dispatch_result.get('dispatch_mode'),
            'runtime_entry_state': runtime_entry_state,
            'path_taken': path_summary.get('path_taken'),
            'path_tags': build_path_tags(args, entry_result, bridge_result, dispatch_result, runtime_entry_state),
            'used_handoff': path_summary.get('used_handoff'),
            'used_shortcut': path_summary.get('used_shortcut'),
            'used_bridge': path_summary.get('used_bridge'),
            'used_full_evaluator': path_summary.get('used_full_evaluator'),
            'entry_duration_sec': entry_duration_sec,
            'dispatch_duration_sec': dispatch_duration_sec,
            'executor_duration_sec': executor_duration_sec,
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
        output = {
            'decision_trace_id': decision_trace_id,
            'entry_decision': entry_decision,
            'dispatch_mode': dispatch_result.get('dispatch_mode') if isinstance(dispatch_result, dict) else None,
            'runtime_entry_state': runtime_entry_state,
            'path_taken': path_summary.get('path_taken'),
            'path_tags': build_path_tags(args, entry_result, bridge_result, dispatch_result, runtime_entry_state),
            'used_handoff': path_summary.get('used_handoff'),
            'used_shortcut': path_summary.get('used_shortcut'),
            'used_bridge': path_summary.get('used_bridge'),
            'used_full_evaluator': path_summary.get('used_full_evaluator'),
            'entry_duration_sec': entry_duration_sec,
            'dispatch_duration_sec': dispatch_duration_sec,
            'executor_duration_sec': executor_duration_sec,
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
