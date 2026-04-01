#!/usr/bin/env python3
import argparse
import json
import re
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


def parse_boolish(value: str | None):
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {'yes', 'true', 'enabled', 'on'}:
        return True
    if normalized in {'no', 'false', 'disabled', 'off'}:
        return False
    return None


def extract_match(pattern: str, text: str, flags: int = 0):
    match = re.search(pattern, text, flags)
    if not match:
        return None
    return match.group(1).strip()


def extract_policy_names(text: str) -> list[str]:
    marker = 'network_policies:'
    if marker not in text:
        return []
    tail = text.split(marker, 1)[1]
    names = re.findall(r'\b([A-Za-z0-9_-]+):\s+name:\s+[A-Za-z0-9_.-]+', tail)
    if names:
        deduped = []
        for name in names:
            if name not in deduped:
                deduped.append(name)
        return deduped
    fallback_names = re.findall(r'\bname:\s+([A-Za-z0-9_.-]+)', tail)
    deduped = []
    for name in fallback_names:
        if name not in deduped:
            deduped.append(name)
    return deduped


def parse_sandbox_status(payload: dict) -> dict:
    raw_output = payload.get('raw_output', '')
    runtime_payload = {}
    if isinstance(raw_output, str) and raw_output.strip():
        try:
            runtime_payload = json.loads(raw_output)
        except json.JSONDecodeError:
            runtime_payload = {}

    stdout = runtime_payload.get('stdout') if isinstance(runtime_payload, dict) else ''
    stdout = stdout if isinstance(stdout, str) else ''
    key_points = payload.get('key_points')
    key_points = key_points if isinstance(key_points, list) else []
    flattened_points = ' '.join(str(item) for item in key_points)
    source_text = stdout or flattened_points

    sandbox_name = extract_match(r'Sandbox:\s*([^\n]+?)\s+Model:', source_text)
    model = extract_match(r'Model:\s*([^\n]+?)\s+Provider:', source_text)
    provider = extract_match(r'Provider:\s*([^\n]+?)\s+GPU:', source_text)
    gpu_raw = extract_match(r'GPU:\s*([^\n]+?)\s+Policies:', source_text)
    sandbox_id = extract_match(r'Id:\s*([^\s]+)', source_text)
    namespace = extract_match(r'Namespace:\s*([^\s]+)', source_text)
    phase = extract_match(r'Phase:\s*([^\s]+)', source_text)
    nim_status = extract_match(r'NIM:\s*([^\n]+)', source_text)

    policy_names = extract_policy_names(source_text)
    runtime_name = namespace or 'openshell'
    openshell_status = 'connected' if phase and phase.lower() == 'ready' else 'unknown'

    return {
        'sandbox_name': sandbox_name or 'unknown',
        'sandbox_id': sandbox_id,
        'namespace': namespace,
        'phase': phase or 'unknown',
        'provider': provider or 'unknown',
        'model': model or 'unknown',
        'gpu_enabled': parse_boolish(gpu_raw),
        'policy_names': policy_names,
        'nim_status': nim_status or 'unknown',
        'runtime_name': runtime_name,
        'openshell_status': openshell_status,
    }


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
            'sandbox_status': parse_sandbox_status(payload),
            'raw_output': payload.get('raw_output', ''),
        }
    print(json.dumps(normalized, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())