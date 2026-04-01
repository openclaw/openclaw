#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
from pathlib import Path

MAX_ATTEMPTS_DEFAULT = 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Minimal routing loop for Sense runtime readiness, remediation, and next-step execution.'
    )
    parser.add_argument('--token', required=True)
    parser.add_argument('--sandbox-name', required=True)
    parser.add_argument('--max-attempts', type=int, default=MAX_ATTEMPTS_DEFAULT)
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    parser.add_argument('--override-recommended-action')
    return parser


def run_json(cmd: list[str]) -> dict:
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        if completed.stderr:
            sys.stderr.write(completed.stderr)
            if not completed.stderr.endswith('\n'):
                sys.stderr.write('\n')
        raise SystemExit(completed.returncode)
    return json.loads(completed.stdout)


def base_args(args: argparse.Namespace) -> list[str]:
    result = ['--token', args.token, '--sandbox-name', args.sandbox_name]
    if args.timeout is not None:
        result.extend(['--timeout', str(args.timeout)])
    if args.wait_timeout is not None:
        result.extend(['--wait-timeout', str(args.wait_timeout)])
    if args.poll_interval is not None:
        result.extend(['--poll-interval', str(args.poll_interval)])
    if args.input:
        result.extend(['--input', args.input])
    return result


def manager_cmd(script_dir: Path, args: argparse.Namespace, intent: str) -> list[str]:
    cmd = [str(script_dir / 'sense-runtime-manager-tool.sh'), '--intent', intent, '--token', args.token]
    if intent == 'sense sandbox status':
        cmd.extend(['--sandbox-name', args.sandbox_name])
    if args.timeout is not None:
        cmd.extend(['--timeout', str(args.timeout)])
    if args.wait_timeout is not None:
        cmd.extend(['--wait-timeout', str(args.wait_timeout)])
    if args.poll_interval is not None:
        cmd.extend(['--poll-interval', str(args.poll_interval)])
    if args.input:
        cmd.extend(['--input', args.input])
    return cmd


def main() -> int:
    args = build_parser().parse_args()
    script_dir = Path(__file__).resolve().parent
    decision_tool = script_dir / 'sense-runtime-decision.sh'
    remediation_tool = script_dir / 'sense-runtime-remediation.sh'

    attempts = 0
    executed_steps: list[dict] = []
    seen_signatures: set[tuple[str, str, str]] = set()
    final_state = 'stopped'
    last_decision: dict | None = None
    last_remediation: dict | None = None
    next_step = 'manual_review'

    while attempts < max(1, args.max_attempts):
        attempts += 1
        decision = run_json([str(decision_tool), *base_args(args)])
        if args.override_recommended_action:
            decision = dict(decision)
            decision['recommended_action'] = args.override_recommended_action
        last_decision = decision
        executed_steps.append({'step': 'decision', 'attempt': attempts, 'result': decision})

        signature = (
            str(decision.get('readiness') or ''),
            str(decision.get('recommended_action') or ''),
            str(decision.get('next_step') or ''),
        )
        if signature in seen_signatures:
            final_state = 'stopped_repeated_decision'
            next_step = str(decision.get('next_step') or 'manual_review')
            break
        seen_signatures.add(signature)

        if str(decision.get('readiness') or '') == 'ready':
            final_state = 'ready'
            next_step = str(decision.get('next_step') or 'run_runtime_task')
            break

        remediation_cmd = [str(remediation_tool), *base_args(args)]
        if args.override_recommended_action:
            remediation_cmd.extend(['--recommended-action', args.override_recommended_action])
        remediation = run_json(remediation_cmd)
        last_remediation = remediation
        executed_steps.append({'step': 'remediation', 'attempt': attempts, 'result': remediation})
        resolved_next_step = str(remediation.get('resolved_next_step') or '') if isinstance(remediation, dict) else ''
        next_step = str(resolved_next_step or remediation.get('next_step') or decision.get('next_step') or 'manual_review')

        provider_status = remediation.get('provider_status') if isinstance(remediation, dict) else None
        if isinstance(provider_status, dict) and provider_status.get('provider_ready') is False:
            final_state = 'provider_not_ready'
            next_step = resolved_next_step or 'configure_provider'
            break

        gpu_status = remediation.get('gpu_status') if isinstance(remediation, dict) else None
        remediation_action = str(remediation.get('remediation_action') or '') if isinstance(remediation, dict) else ''
        if next_step == 'configure_gpu_runtime' and remediation_action != 'configure_gpu_runtime':
            configure_cmd = [str(remediation_tool), *base_args(args), '--recommended-action', 'configure_gpu_runtime']
            configure_result = run_json(configure_cmd)
            last_remediation = configure_result
            executed_steps.append({'step': 'runtime_task', 'attempt': attempts, 'action': 'configure_gpu_runtime', 'result': configure_result})
            resolved_next_step = str(configure_result.get('resolved_next_step') or '') if isinstance(configure_result, dict) else ''
            next_step = str(resolved_next_step or configure_result.get('next_step') or next_step)
            configured_gpu_status = configure_result.get('gpu_status') if isinstance(configure_result, dict) else None
            if next_step == 'configure_provider':
                final_state = 'provider_not_ready'
                break
            if next_step == 'start_nim_runtime':
                final_state = 'nim_not_ready'
                break
            if next_step == 'enable_gpu_runtime':
                final_state = 'gpu_not_ready'
                break
            if next_step == 'review_runtime_capabilities':
                final_state = 'capability_limited'
                break
            if isinstance(configured_gpu_status, dict) and configured_gpu_status.get('gpu_ready') is False:
                final_state = 'gpu_not_ready'
                next_step = 'configure_gpu_runtime'
                break
            if next_step == 'run_runtime_task':
                final_state = 'ready_for_runtime_task'
                break

        gpu_status = last_remediation.get('gpu_status') if isinstance(last_remediation, dict) else None
        if next_step == 'configure_provider':
            final_state = 'provider_not_ready'
            break
        if next_step == 'start_nim_runtime':
            final_state = 'nim_not_ready'
            break
        if next_step == 'enable_gpu_runtime':
            final_state = 'gpu_not_ready'
            break
        if next_step == 'review_runtime_capabilities':
            final_state = 'capability_limited'
            break
        if isinstance(gpu_status, dict) and gpu_status.get('gpu_ready') is False and remediation_action == 'configure_gpu_runtime':
            final_state = 'gpu_not_ready'
            next_step = 'configure_gpu_runtime'
            break

        if next_step == 'sense_runtime_start':
            runtime_result = run_json(manager_cmd(script_dir, args, 'sense runtime start'))
            executed_steps.append({'step': 'runtime_task', 'attempt': attempts, 'action': 'sense_runtime_start', 'result': runtime_result})
        elif next_step == 'sense_runtime_status':
            runtime_result = run_json(manager_cmd(script_dir, args, 'sense runtime status'))
            executed_steps.append({'step': 'runtime_task', 'attempt': attempts, 'action': 'sense_runtime_status', 'result': runtime_result})
        elif next_step == 'inspect_gpu_runtime':
            runtime_result = run_json(manager_cmd(script_dir, args, 'sense sandbox status'))
            executed_steps.append({'step': 'runtime_task', 'attempt': attempts, 'action': 'inspect_gpu_runtime', 'result': runtime_result})
        elif next_step == 'run_runtime_task':
            final_state = 'ready_for_runtime_task'
            break
        else:
            final_state = 'stopped_unmapped_next_step'
            break
    else:
        final_state = 'stopped_max_attempts'

    output = {
        'final_state': final_state,
        'executed_steps': executed_steps,
        'last_decision': last_decision,
        'last_remediation': last_remediation,
        'next_step': next_step,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())