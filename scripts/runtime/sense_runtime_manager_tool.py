#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
from pathlib import Path

INTENT_TO_ACTION = {
    'sense runtime status': 'status',
    'sense runtime start': 'start',
    'sense runtime stop': 'stop',
    'sense sandbox status': 'sandbox-status',
}


def normalize_intent(text: str) -> str:
    return ' '.join(text.strip().lower().replace('_', ' ').replace('-', ' ').split())


def resolve_action(intent: str | None, action: str | None) -> str:
    if action:
        return action
    if not intent:
        raise SystemExit('either --action or --intent is required')
    normalized = normalize_intent(intent)
    if normalized not in INTENT_TO_ACTION:
        raise SystemExit(
            'unsupported intent; expected one of: '
            + ', '.join(sorted(INTENT_TO_ACTION))
        )
    return INTENT_TO_ACTION[normalized]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Manager-facing Sense runtime tool. Maps natural language or explicit action to the Sense runtime subprocess tool.'
    )
    parser.add_argument('--intent')
    parser.add_argument('--action', choices=['status', 'start', 'stop', 'sandbox-status'])
    parser.add_argument('--token', required=True)
    parser.add_argument('--sandbox-name')
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    return parser


def main() -> int:
    args = build_parser().parse_args()
    action = resolve_action(args.intent, args.action)
    script_dir = Path(__file__).resolve().parent
    tool_path = script_dir / 'sense-runtime-subprocess-tool.sh'
    cmd = [str(tool_path), '--action', action, '--token', args.token]
    if args.sandbox_name:
        cmd.extend(['--sandbox-name', args.sandbox_name])
    if args.timeout is not None:
        cmd.extend(['--timeout', str(args.timeout)])
    if args.wait_timeout is not None:
        cmd.extend(['--wait-timeout', str(args.wait_timeout)])
    if args.poll_interval is not None:
        cmd.extend(['--poll-interval', str(args.poll_interval)])
    if args.input:
        cmd.extend(['--input', args.input])

    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        if completed.stderr:
            sys.stderr.write(completed.stderr)
            if not completed.stderr.endswith('\n'):
                sys.stderr.write('\n')
        return completed.returncode

    payload = json.loads(completed.stdout)
    normalized = {
        'summary': payload.get('summary', ''),
        'key_points': payload.get('key_points', []),
        'suggested_next_action': payload.get('suggested_next_action', ''),
    }
    if action == 'sandbox-status':
        normalized['details'] = {
            'action': action,
            'runner': payload.get('runner'),
            'exit_code': payload.get('exit_code'),
            'raw_output': payload.get('raw_output', ''),
        }
    print(json.dumps(normalized, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())