#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Single manager runtime entrypoint that chains manager entry and dispatch.'
    )
    parser.add_argument('--handoff-json')
    parser.add_argument('--token', required=True)
    parser.add_argument('--sandbox-name', required=True)
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    return parser


def build_runtime_args(args: argparse.Namespace) -> list[str]:
    runtime_args = ['--token', args.token, '--sandbox-name', args.sandbox_name]
    if args.timeout is not None:
        runtime_args.extend(['--timeout', str(args.timeout)])
    if args.wait_timeout is not None:
        runtime_args.extend(['--wait-timeout', str(args.wait_timeout)])
    if args.poll_interval is not None:
        runtime_args.extend(['--poll-interval', str(args.poll_interval)])
    if args.input:
        runtime_args.extend(['--input', args.input])
    return runtime_args


def run_entry(script_dir: Path, args: argparse.Namespace, runtime_args: list[str]) -> dict:
    cmd = [str(script_dir / 'sense-runtime-manager-entry.sh'), *runtime_args]
    if args.handoff_json:
        cmd.extend(['--handoff-json', args.handoff_json])
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'manager entry failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def run_dispatch(script_dir: Path, entry_result: dict, runtime_args: list[str]) -> dict:
    cmd = [
        str(script_dir / 'sense-runtime-manager-dispatch.sh'),
        '--entry-json',
        json.dumps(entry_result, ensure_ascii=False),
        *runtime_args,
    ]
    completed = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        error_text = completed.stderr.strip() or completed.stdout.strip() or 'manager dispatch failed'
        raise RuntimeError(error_text)
    return json.loads(completed.stdout)


def infer_runtime_entry_state(dispatch_result: dict) -> str:
    result = dispatch_result.get('dispatch_result')
    if isinstance(result, dict):
        executor_state = result.get('executor_state')
        if isinstance(executor_state, str) and executor_state.strip():
            return executor_state
    return 'completed'


def main() -> int:
    args = build_parser().parse_args()
    script_dir = Path(__file__).resolve().parent
    runtime_args = build_runtime_args(args)
    entry_result = run_entry(script_dir, args, runtime_args)
    dispatch_result = run_dispatch(script_dir, entry_result, runtime_args)
    output = {
        'entry_decision': entry_result.get('entry_decision'),
        'dispatch_mode': dispatch_result.get('dispatch_mode'),
        'runtime_entry_state': infer_runtime_entry_state(dispatch_result),
        'result': dispatch_result,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
