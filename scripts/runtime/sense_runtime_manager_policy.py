#!/usr/bin/env python3
import argparse
import json
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Manager policy table for Sense runtime routing evaluation.'
    )
    parser.add_argument('--input-json')
    return parser


def load_payload(args: argparse.Namespace) -> dict:
    if args.input_json:
        return json.loads(args.input_json)
    raw = sys.stdin.read()
    if not raw.strip():
        raise SystemExit('expected routing evaluation JSON on stdin or via --input-json')
    return json.loads(raw)


def main() -> int:
    args = build_parser().parse_args()
    payload = load_payload(args)
    final_state = str(payload.get('final_state') or 'unknown')
    next_step = str(payload.get('next_step') or 'manual_review')
    retry = payload.get('retry') if isinstance(payload.get('retry'), dict) else {}
    retry_decision = retry.get('retry_decision')

    manager_action = 'stop'
    manager_reason = 'runtime evaluation requires manual review'

    if final_state == 'ready_for_runtime_task':
        manager_action = 'run_next_step'
        manager_reason = 'runtime evaluation indicates the runtime task can proceed'
    elif retry_decision == 'recheck_runtime_status_once' and retry.get('retry_allowed') is True:
        manager_action = 'retry'
        manager_reason = 'runtime model was observed only in start-result and should be confirmed once'
    elif retry_decision == 'runtime_model_confirmed':
        manager_action = 'run_next_step'
        manager_reason = 'runtime model is confirmed by runtime status'
    elif retry_decision == 'skip_restart_repeated_mismatch':
        manager_action = 'stop'
        manager_reason = 'the same selected-model mismatch repeated and restart should be skipped'
    elif final_state == 'manager_action_required':
        manager_action = 'run_next_step'
        manager_reason = 'routing evaluation produced a manager-owned next step'
    elif final_state in {
        'provider_api_key_missing',
        'provider_config_missing',
        'provider_model_missing',
        'provider_not_ready',
        'nim_not_ready',
        'gpu_not_ready',
        'capability_limited',
        'default_model_missing',
        'selected_model_missing',
        'selected_model_not_ready',
        'selected_model_mismatch',
        'model_not_ready',
    }:
        manager_action = 'stop'
        manager_reason = 'routing evaluation found a concrete remediation state that manager should handle explicitly'

    output = {
        'manager_action': manager_action,
        'manager_reason': manager_reason,
        'next_step': next_step,
        'retry_decision': retry_decision,
        'policy_table_version': 'v1',
        'policy_input': payload.get('policy_input', {}),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
