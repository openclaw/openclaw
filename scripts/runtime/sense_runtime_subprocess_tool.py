#!/usr/bin/env python3
import argparse
import subprocess
import sys
from pathlib import Path

ACTION_TO_INTENT = {
    'status': 'sense runtime status',
    'start': 'sense runtime start',
    'stop': 'sense runtime stop',
    'sandbox-status': 'sense sandbox status',
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Manager-facing subprocess tool for the Sense WSL runtime plane.'
    )
    parser.add_argument('--action', required=True, choices=sorted(ACTION_TO_INTENT))
    parser.add_argument('--token', required=True)
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    parser.add_argument('--sandbox-name')
    return parser


def main() -> int:
    args = build_parser().parse_args()
    script_dir = Path(__file__).resolve().parent
    intent_tool = script_dir / 'sense-runtime-intent.sh'
    if not intent_tool.exists():
        raise SystemExit(f'missing intent tool: {intent_tool}')

    cmd = [str(intent_tool), ACTION_TO_INTENT[args.action], '--token', args.token]
    if args.timeout is not None:
        cmd.extend(['--timeout', str(args.timeout)])
    if args.wait_timeout is not None:
        cmd.extend(['--wait-timeout', str(args.wait_timeout)])
    if args.poll_interval is not None:
        cmd.extend(['--poll-interval', str(args.poll_interval)])
    if args.input:
        cmd.extend(['--input', args.input])
    if args.sandbox_name:
        cmd.extend(['--sandbox-name', args.sandbox_name])

    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.stdout:
        sys.stdout.write(completed.stdout)
        if not completed.stdout.endswith('\n'):
            sys.stdout.write('\n')
    if completed.stderr:
        sys.stderr.write(completed.stderr)
        if not completed.stderr.endswith('\n'):
            sys.stderr.write('\n')
    return completed.returncode


if __name__ == '__main__':
    raise SystemExit(main())