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

        remediation = run_json([str(remediation_tool), *base_args(args)])
        last_remediation = remediation
        executed_steps.append({'step': 'remediation', 'attempt': attempts, 'result': remediation})
        next_step = str(remediation.get('next_step') or decision.get('next_step') or 'manual_review')

        provider_status = remediation.get('provider_status') if isinstance(remediation, dict) else None
        if isinstance(provider_status, dict) and provider_status.get('provider_ready') is False:
            final_state = 'provider_not_ready'
            next_step = 'configure_provider'
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