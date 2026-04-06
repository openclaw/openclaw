#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json


ACTION_TO_STEP = {
    'start_nim_runtime': 'start_nim_runtime',
    'configure_gpu_runtime': 'configure_gpu_runtime',
    'configure_provider': 'check_provider_config',
    'configure_model': 'check_selected_model_config',
    'review_runtime_capabilities': 'review_runtime_capabilities',
    'run_runtime_task': 'run_runtime_task',
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Build a lightweight manager policy shortcut from a handoff seed.')
    parser.add_argument('--input-json', required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    payload = json.loads(args.input_json)
    recommended_action = payload.get('recommended_action')
    confidence = float(payload.get('summary_confidence') or 0.0)
    next_step = ACTION_TO_STEP.get(str(recommended_action)) if recommended_action else None
    shortcut_used = confidence >= 0.7 and next_step is not None
    result = {
        'shortcut_used': shortcut_used,
        'shortcut_reason': (
            'high-confidence handoff seed was converted into a lightweight manager plan'
            if shortcut_used
            else 'shortcut was not used because confidence was low or recommended_action was unknown'
        ),
        'manager_plan': (
            {
                'manager_action': recommended_action,
                'next_step': next_step,
            }
            if shortcut_used
            else None
        ),
        'shortcut_input': payload,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
