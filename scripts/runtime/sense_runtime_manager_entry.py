#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Manager entry helper that triages handoff before running the full evaluator.'
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


def load_handoff(args: argparse.Namespace) -> dict | None:
    if args.handoff_json:
        return json.loads(args.handoff_json)
    return None


def load_feedback(args: argparse.Namespace) -> dict | None:
    if args.feedback_json:
        return json.loads(args.feedback_json)
    return None


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


def run_handoff_triage(script_dir: Path, handoff: dict) -> dict:
    cmd = [
        str(script_dir / 'sense-runtime-manager-handoff-triage.sh'),
        '--input-json',
        json.dumps(handoff, ensure_ascii=False),
    ]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'handoff triage failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def run_handoff_seed(script_dir: Path, handoff: dict) -> dict:
    cmd = [
        str(script_dir / 'sense-runtime-manager-handoff-seed.sh'),
        '--input-json',
        json.dumps(handoff, ensure_ascii=False),
    ]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'handoff seed build failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def run_policy_shortcut(script_dir: Path, seed: dict, recommended_action: str | None) -> dict:
    cmd = [
        str(script_dir / 'sense-runtime-manager-policy-shortcut.sh'),
        '--input-json',
        json.dumps(
            {
                'shortcut_version': 'v1',
                'source': 'lightweight_handoff_seed',
                'recommended_action': recommended_action,
                'suggested_next_step': seed.get('suggested_next_step'),
                'primary_remaining_issue': seed.get('primary_remaining_issue'),
                'summary_confidence': seed.get('summary_confidence'),
            },
            ensure_ascii=False,
        ),
    ]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'policy shortcut build failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def run_full_evaluator(script_dir: Path, runtime_args: list[str]) -> dict:
    cmd = [str(script_dir / 'sense-runtime-routing-loop.sh'), *runtime_args]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'full evaluator failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def main() -> int:
    args = build_parser().parse_args()
    script_dir = Path(__file__).resolve().parent
    handoff = load_handoff(args)
    feedback = load_feedback(args)
    runtime_args = build_runtime_args(args)

    if handoff is None:
        output = {
            'entry_decision': 'rerun_full_evaluator',
            'handoff_used': False,
            'suggested_next_step': None,
            'primary_remaining_issue': None,
            'summary_confidence': 0.0,
            'entry_result': run_full_evaluator(script_dir, runtime_args),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    triage = run_handoff_triage(script_dir, handoff)
    decision = str(triage.get('triage_decision') or 'rerun_full_evaluator')
    primary_remaining_issue = triage.get('primary_remaining_issue')
    suggested_next_step = triage.get('suggested_next_step')
    summary_confidence = triage.get('summary_confidence')
    feedback_gate_applied = False
    feedback_gate_mode = 'none'
    feedback_gate_reason = None
    if decision == 'use_handoff' and isinstance(feedback, dict):
        last_decision_quality = str(feedback.get('last_decision_quality') or '').lower()
        last_primary_issue = feedback.get('last_primary_issue')
        last_success_action = feedback.get('last_success_action')
        current_last_main_action = handoff.get('last_main_action') if isinstance(handoff, dict) else None

        if last_decision_quality == 'poor':
            decision = 'rerun_full_evaluator'
            feedback_gate_applied = True
            feedback_gate_mode = 'reroute_to_full_evaluator'
            feedback_gate_reason = 'last decision quality was poor, so full evaluator was preferred over shortcut reuse'
        elif (
            last_decision_quality == 'degraded'
            and isinstance(current_last_main_action, str)
            and current_last_main_action.strip()
            and current_last_main_action == last_success_action
        ):
            decision = 'rerun_full_evaluator'
            feedback_gate_applied = True
            feedback_gate_mode = 'reroute_to_full_evaluator'
            feedback_gate_reason = 'degraded outcome repeated with the same action; bypassing shortcut'
        elif (
            last_decision_quality == 'good'
            and isinstance(primary_remaining_issue, str)
            and primary_remaining_issue.strip()
            and primary_remaining_issue == last_primary_issue
        ):
            feedback_gate_applied = False
            feedback_gate_mode = 'annotate_only'
            feedback_gate_reason = 'same primary issue repeated after a previously good resolution path'

    if decision == 'use_handoff':
        seed_result = run_handoff_seed(script_dir, handoff)
        shortcut_result = run_policy_shortcut(
            script_dir,
            seed_result.get('seed') or {},
            seed_result.get('recommended_action'),
        )
        entry_result = {
            'mode': 'handoff',
            'suggested_next_step': suggested_next_step,
            'primary_remaining_issue': primary_remaining_issue,
            'summary_confidence': summary_confidence,
            'seed': seed_result.get('seed'),
            'recommended_action': seed_result.get('recommended_action'),
            'shortcut_plan': shortcut_result,
        }
        output = {
            'entry_decision': decision,
            'handoff_used': True,
            'suggested_next_step': suggested_next_step,
            'primary_remaining_issue': primary_remaining_issue,
            'summary_confidence': summary_confidence,
            'feedback_gate_applied': feedback_gate_applied,
            'feedback_gate_mode': feedback_gate_mode,
            'feedback_gate_reason': feedback_gate_reason,
            'entry_result': entry_result,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    evaluator_result = run_full_evaluator(script_dir, runtime_args)
    if decision == 'hint_only':
        entry_result = {
            'full_evaluator': evaluator_result,
            'handoff_hint': {
                'primary_remaining_issue': primary_remaining_issue,
                'suggested_next_step': suggested_next_step,
                'summary_confidence': summary_confidence,
            },
        }
        output = {
            'entry_decision': decision,
            'handoff_used': True,
            'suggested_next_step': suggested_next_step,
            'primary_remaining_issue': primary_remaining_issue,
            'summary_confidence': summary_confidence,
            'feedback_gate_applied': feedback_gate_applied,
            'feedback_gate_mode': feedback_gate_mode,
            'feedback_gate_reason': feedback_gate_reason,
            'entry_result': entry_result,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    output = {
        'entry_decision': 'rerun_full_evaluator',
        'handoff_used': False,
        'suggested_next_step': suggested_next_step,
        'primary_remaining_issue': primary_remaining_issue,
        'summary_confidence': summary_confidence,
        'feedback_gate_applied': feedback_gate_applied,
        'feedback_gate_mode': feedback_gate_mode,
        'feedback_gate_reason': feedback_gate_reason,
        'entry_result': evaluator_result,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
