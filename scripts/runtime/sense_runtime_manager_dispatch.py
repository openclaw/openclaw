#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Dispatch manager entry output into either a shortcut executor path or the full evaluator/policy path.'
    )
    parser.add_argument('--entry-json')
    parser.add_argument('--token', required=True)
    parser.add_argument('--sandbox-name', required=True)
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    return parser


def load_entry(args: argparse.Namespace) -> dict:
    if args.entry_json:
        return json.loads(args.entry_json)
    raw = sys.stdin.read()
    if not raw.strip():
        raise SystemExit('expected manager entry JSON on stdin or via --entry-json')
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


def run_policy(script_dir: Path, evaluator_result: dict) -> dict:
    cmd = [
        str(script_dir / 'sense-runtime-manager-policy.sh'),
        '--input-json',
        json.dumps(evaluator_result, ensure_ascii=False),
    ]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'manager policy failed'
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


def build_shortcut_policy(entry_payload: dict) -> dict | None:
    entry_result = entry_payload.get('entry_result')
    if not isinstance(entry_result, dict):
        return None
    shortcut_plan = entry_result.get('shortcut_plan')
    if not isinstance(shortcut_plan, dict) or shortcut_plan.get('shortcut_used') is not True:
        return None
    manager_plan = shortcut_plan.get('manager_plan')
    if not isinstance(manager_plan, dict):
        return None
    manager_action = manager_plan.get('manager_action')
    next_step = manager_plan.get('next_step')
    if not isinstance(manager_action, str) or not manager_action.strip():
        return None
    if not isinstance(next_step, str) or not next_step.strip():
        return None
    return {
        'decision_trace_id': entry_payload.get('decision_trace_id'),
        'manager_action': manager_action,
        'manager_reason': 'high-confidence handoff shortcut was promoted directly into a thin manager execution plan',
        'secondary_action': None,
        'secondary_reason': None,
        'secondary_next_step': None,
        'next_step': next_step,
        'fallback_action': 'manual_review',
        'confidence_gate_applied': False,
        'retry_decision': None,
        'policy_table_version': 'v1-shortcut',
        'policy_trace': {
            'rule_id': 'entry_shortcut_to_executor',
            'matched_on': {
                'entry_decision': entry_payload.get('entry_decision'),
                'shortcut_used': True,
            },
            'selected_action': manager_action,
        },
        'policy_input': {
            'source': 'manager_entry_shortcut',
            'suggested_next_step': entry_payload.get('suggested_next_step'),
            'primary_remaining_issue': entry_payload.get('primary_remaining_issue'),
            'summary_confidence': entry_payload.get('summary_confidence'),
        },
    }


def extract_evaluator_result(entry_payload: dict) -> dict | None:
    entry_result = entry_payload.get('entry_result')
    if isinstance(entry_result, dict) and isinstance(entry_result.get('full_evaluator'), dict):
        return entry_result.get('full_evaluator')
    return entry_result if isinstance(entry_result, dict) else None


def main() -> int:
    args = build_parser().parse_args()
    entry_payload = load_entry(args)
    runtime_args = build_runtime_args(args)
    script_dir = Path(__file__).resolve().parent

    shortcut_policy = build_shortcut_policy(entry_payload)
    if shortcut_policy is not None:
        output = {
            'dispatch_mode': 'shortcut_executor',
            'shortcut_used': True,
            'dispatch_reason': 'high-confidence shortcut manager plan was sent directly to the thin manager executor',
            'dispatch_result': run_executor(script_dir, shortcut_policy, runtime_args),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    evaluator_result = extract_evaluator_result(entry_payload)
    if evaluator_result is None:
        output = {
            'dispatch_mode': 'full_evaluator',
            'shortcut_used': False,
            'dispatch_reason': 'entry payload did not contain a usable shortcut or evaluator result',
            'dispatch_result': None,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    policy_payload = run_policy(script_dir, evaluator_result)
    policy_payload['decision_trace_id'] = entry_payload.get('decision_trace_id')
    output = {
        'dispatch_mode': 'full_evaluator',
        'shortcut_used': False,
        'dispatch_reason': 'shortcut was unavailable, so the manager policy and executor followed the evaluator path',
        'dispatch_result': run_executor(script_dir, policy_payload, runtime_args),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
