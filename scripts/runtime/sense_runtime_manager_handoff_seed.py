#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys


STEP_TO_ACTION = {
    'check_api_key_config': 'configure_provider',
    'check_provider_config': 'configure_provider',
    'check_model_config': 'configure_model',
    'check_selected_model_config': 'configure_model',
    'configure_gpu_runtime': 'configure_gpu_runtime',
    'start_nim_runtime': 'start_nim_runtime',
    'review_runtime_capabilities': 'review_runtime_capabilities',
    'run_runtime_task': 'run_runtime_task',
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Build a lightweight manager seed from a manager_handoff payload.'
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
    suggested_next_step = payload.get('suggested_next_step')
    seed = {
        'seed_version': 'v1',
        'seed_source': 'manager_handoff',
        'seed_mode': 'lightweight_handoff',
        'suggested_next_step': suggested_next_step,
        'primary_remaining_issue': payload.get('primary_remaining_issue'),
        'secondary_remaining_issues': payload.get('secondary_remaining_issues', []),
        'summary_confidence': payload.get('summary_confidence', 0.0),
        'last_main_action': payload.get('last_main_action'),
        'last_secondary_action': payload.get('last_secondary_action'),
    }
    output = {
        'seed': seed,
        'recommended_action': STEP_TO_ACTION.get(str(suggested_next_step or ''), None),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
