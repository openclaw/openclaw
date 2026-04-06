#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys


ACTION_TO_STEP = {
    'start_nim_runtime': 'start_nim_runtime',
    'configure_gpu_runtime': 'configure_gpu_runtime',
    'configure_provider': 'check_provider_config',
    'configure_model': 'check_selected_model_config',
    'review_runtime_capabilities': 'review_runtime_capabilities',
    'run_runtime_task': 'run_runtime_task',
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Bridge a high-confidence shortcut plan into a lightweight manager policy outcome.'
    )
    parser.add_argument('--entry-json', required=True)
    parser.add_argument('--handoff-json')
    return parser


def build_bridge_input(entry_payload: dict) -> dict:
    entry_result = entry_payload.get('entry_result')
    if not isinstance(entry_result, dict):
        return {}
    return {
        'recommended_action': entry_result.get('recommended_action'),
        'primary_remaining_issue': entry_payload.get('primary_remaining_issue'),
        'summary_confidence': entry_payload.get('summary_confidence'),
    }


def main() -> int:
    args = build_parser().parse_args()
    entry_payload = json.loads(args.entry_json)
    entry_result = entry_payload.get('entry_result')
    shortcut_plan = entry_result.get('shortcut_plan') if isinstance(entry_result, dict) else None
    bridge_input = build_bridge_input(entry_payload)
    manager_plan = shortcut_plan.get('manager_plan') if isinstance(shortcut_plan, dict) else None
    recommended_action = bridge_input.get('recommended_action')
    next_step = ACTION_TO_STEP.get(str(recommended_action)) if recommended_action else None

    bridge_used = (
        isinstance(shortcut_plan, dict)
        and shortcut_plan.get('shortcut_used') is True
        and isinstance(manager_plan, dict)
        and next_step is not None
    )

    outcome = {
        'bridge_used': bool(bridge_used),
        'bridge_mode': 'shortcut_policy_outcome' if bridge_used else None,
        'bridge_reason': (
            'high-confidence handoff shortcut was promoted into a lightweight manager policy outcome'
            if bridge_used
            else 'shortcut policy bridge was not used because no valid high-confidence shortcut plan was available'
        ),
        'manager_policy_outcome': (
            {
                'manager_action': recommended_action,
                'next_step': next_step,
                'secondary_action': None,
                'secondary_next_step': None,
                'fallback_action': 'manual_review',
            }
            if bridge_used
            else None
        ),
        'bridge_input': bridge_input,
    }
    print(json.dumps(outcome, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
