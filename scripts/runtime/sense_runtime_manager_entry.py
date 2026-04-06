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
    return parser


def load_handoff(args: argparse.Namespace) -> dict | None:
    if args.handoff_json:
        return json.loads(args.handoff_json)
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

    if decision == 'use_handoff':
        seed_result = run_handoff_seed(script_dir, handoff)
        entry_result = {
            'mode': 'handoff',
            'suggested_next_step': suggested_next_step,
            'primary_remaining_issue': primary_remaining_issue,
            'summary_confidence': summary_confidence,
            'seed': seed_result.get('seed'),
            'recommended_action': seed_result.get('recommended_action'),
        }
        output = {
            'entry_decision': decision,
            'handoff_used': True,
            'suggested_next_step': suggested_next_step,
            'primary_remaining_issue': primary_remaining_issue,
            'summary_confidence': summary_confidence,
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
        'entry_result': evaluator_result,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
