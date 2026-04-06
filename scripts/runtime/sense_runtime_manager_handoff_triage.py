#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Thin triage helper for next-turn manager handoff payloads.'
    )
    parser.add_argument('--input-json')
    return parser


def load_payload(args: argparse.Namespace) -> dict:
    if args.input_json:
        return json.loads(args.input_json)
    raw = sys.stdin.read()
    if not raw.strip():
        raise SystemExit('expected handoff JSON on stdin or via --input-json')
    return json.loads(raw)


def main() -> int:
    args = build_parser().parse_args()
    payload = load_payload(args)

    executor_state = str(payload.get('executor_state') or 'unknown')
    primary_remaining_issue = payload.get('primary_remaining_issue')
    suggested_next_step = payload.get('suggested_next_step')
    summary_confidence = payload.get('summary_confidence')
    confidence = (
        float(summary_confidence)
        if isinstance(summary_confidence, (int, float))
        else 0.0
    )

    triage_decision = 'rerun_full_evaluator'
    triage_reason = 'handoff confidence is too low to trust as a next-turn shortcut'

    if executor_state in {'failed', 'stopped'}:
        triage_decision = 'rerun_full_evaluator'
        triage_reason = 'handoff came from a failed or stopped execution, so full evaluation should be rerun'
    elif executor_state == 'completed_resolved':
        triage_decision = 'hint_only'
        triage_reason = 'handoff indicates the prior closed loop resolved, so handoff can be used as a lightweight note'
    elif confidence >= 0.7:
        triage_decision = 'use_handoff'
        triage_reason = 'handoff confidence is high enough to use as the next-turn triage input'
    elif confidence >= 0.5:
        triage_decision = 'hint_only'
        triage_reason = 'handoff confidence is moderate, so it should be treated as a hint before deeper evaluation'

    output = {
        'triage_decision': triage_decision,
        'primary_remaining_issue': primary_remaining_issue,
        'suggested_next_step': suggested_next_step,
        'summary_confidence': confidence,
        'triage_reason': triage_reason,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
