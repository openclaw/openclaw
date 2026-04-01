#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

REQUIRED_POLICIES = ['nvidia', 'openclaw_api']
NEXT_STEP_BY_ACTION = {
    'proceed': 'run_runtime_task',
    'check_runtime_provider': 'sense_runtime_start',
    'check_gpu_runtime': 'inspect_gpu_runtime',
    'wait_for_runtime_ready': 'sense_runtime_status',
    'review_runtime_capabilities': 'review_runtime_capabilities',
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Minimal dispatcher for Sense runtime sandbox-status results.'
    )
    parser.add_argument('--input-file')
    return parser


def read_payload(input_file: str | None):
    if input_file:
        return json.loads(Path(input_file).read_text(encoding='utf-8'))
    return json.load(sys.stdin)


def evaluate_sandbox_status(sandbox_status: dict) -> dict:
    reasons: list[str] = []
    readiness = 'ready'
    recommended_action = 'proceed'

    phase = str(sandbox_status.get('phase') or 'unknown')
    gpu_enabled = sandbox_status.get('gpu_enabled')
    nim_status = str(sandbox_status.get('nim_status') or 'unknown')
    policy_names = sandbox_status.get('policy_names') if isinstance(sandbox_status.get('policy_names'), list) else []

    missing_policies = [name for name in REQUIRED_POLICIES if name not in policy_names]

    if phase != 'Ready':
        reasons.append(f'phase is {phase}')
        readiness = 'not_ready'
        recommended_action = 'wait_for_runtime_ready'

    if gpu_enabled is False:
        reasons.append('gpu is not enabled')
        if readiness == 'ready':
            readiness = 'degraded'
            recommended_action = 'check_gpu_runtime'

    if nim_status.lower() != 'running':
        reasons.append(f'nim_status is {nim_status}')
        if readiness == 'ready':
            readiness = 'degraded'
            recommended_action = 'check_runtime_provider'
        elif readiness == 'degraded':
            recommended_action = 'check_runtime_provider'

    if missing_policies:
        reasons.append('required policies missing: ' + ', '.join(missing_policies))
        if readiness == 'ready':
            readiness = 'limited'
            recommended_action = 'review_runtime_capabilities'
        elif readiness in {'degraded', 'limited'}:
            recommended_action = 'review_runtime_capabilities'

    if phase == 'Ready' and not reasons:
        reasons.append('runtime plane is ready for manager use')

    return {
        'readiness': readiness,
        'recommended_action': recommended_action,
        'reasons': reasons,
        'next_step': NEXT_STEP_BY_ACTION.get(recommended_action, 'manual_review'),
    }


def main() -> int:
    args = build_parser().parse_args()
    payload = read_payload(args.input_file)
    details = payload.get('details') if isinstance(payload, dict) else None
    sandbox_status = details.get('sandbox_status') if isinstance(details, dict) else None
    if not isinstance(sandbox_status, dict):
        raise SystemExit('expected details.sandbox_status in input payload')

    evaluation = evaluate_sandbox_status(sandbox_status)
    print(json.dumps(evaluation, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())