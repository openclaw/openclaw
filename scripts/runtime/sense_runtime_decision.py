#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Manager decision helper for Sense runtime readiness checks.'
    )
    parser.add_argument('--token', required=True)
    parser.add_argument('--sandbox-name', required=True)
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    return parser


def main() -> int:
    args = build_parser().parse_args()
    script_dir = Path(__file__).resolve().parent
    manager_tool = script_dir / 'sense-runtime-manager-tool.sh'
    dispatcher_tool = script_dir / 'sense-runtime-dispatcher.sh'

    cmd = [
        str(manager_tool),
        '--intent', 'sense sandbox status',
        '--token', args.token,
        '--sandbox-name', args.sandbox_name,
    ]
    if args.timeout is not None:
        cmd.extend(['--timeout', str(args.timeout)])
    if args.wait_timeout is not None:
        cmd.extend(['--wait-timeout', str(args.wait_timeout)])
    if args.poll_interval is not None:
        cmd.extend(['--poll-interval', str(args.poll_interval)])
    if args.input:
        cmd.extend(['--input', args.input])

    sandbox_result = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if sandbox_result.returncode != 0:
        if sandbox_result.stderr:
            sys.stderr.write(sandbox_result.stderr)
            if not sandbox_result.stderr.endswith('\n'):
                sys.stderr.write('\n')
        return sandbox_result.returncode

    dispatch_result = subprocess.run(
        [str(dispatcher_tool)],
        input=sandbox_result.stdout,
        text=True,
        capture_output=True,
        check=False,
    )
    if dispatch_result.returncode != 0:
        if dispatch_result.stderr:
            sys.stderr.write(dispatch_result.stderr)
            if not dispatch_result.stderr.endswith('\n'):
                sys.stderr.write('\n')
        return dispatch_result.returncode

    print(dispatch_result.stdout, end='')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())