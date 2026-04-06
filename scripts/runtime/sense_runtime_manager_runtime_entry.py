#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


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
    entry_result = run_entry(script_dir, args, runtime_args)
    bridge_result = run_bridge(script_dir, entry_result, args.handoff_json)
    if bridge_result.get('bridge_used') is True:
        manager_policy_outcome = bridge_result.get('manager_policy_outcome') or {}
        dispatch_result = {
            'dispatch_mode': 'shortcut_executor',
            'shortcut_used': True,
            'dispatch_reason': 'lightweight policy bridge promoted the handoff shortcut into a direct executor path',
            'dispatch_result': run_executor(script_dir, manager_policy_outcome, runtime_args),
        }
    else:
        dispatch_result = run_dispatch(script_dir, entry_result, runtime_args)
    feedback_summary = build_feedback_summary(entry_result, dispatch_result)
    feedback_memory = build_feedback_memory(entry_result, dispatch_result, feedback_summary)
    output = {
        'entry_decision': entry_result.get('entry_decision'),
        'dispatch_mode': dispatch_result.get('dispatch_mode'),
        'runtime_entry_state': infer_runtime_entry_state(dispatch_result),
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


if __name__ == '__main__':
    raise SystemExit(main())
