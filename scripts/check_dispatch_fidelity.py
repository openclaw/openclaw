#!/usr/bin/env python3
import argparse
import json
import re
import sys
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict, List, Optional

PASS_THROUGH_GATES = {
    'mechanism-analysis-gate',
    'multi-agent-governance',
    'product-dev-pipeline',
    'l3-routing-strict-mode',
    'high-risk-l3',
    'pass-through-gate',
}

BLOCKS = {
    'USER_RAW': ['USER_RAW'],
    'DISPATCHER_NOTE': ['DISPATCHER_ROUTING_NOTE', 'DISPATCHER_NOTE'],
    'ASSUMPTIONS_CHECKLIST': ['ASSUMPTIONS_CHECKLIST'],
    'DROPPED_CONSTRAINTS_LIST': ['DROPPED_CONSTRAINTS_LIST'],
}

@dataclass
class Block:
    name: str
    raw_name: str
    body: str


def extract_block(text: str, aliases: List[str]) -> Optional[Block]:
    for alias in aliases:
        pattern = re.compile(rf'\[{re.escape(alias)}\]\s*:?[ \t]*\n?(.*?)(?=\n\[[A-Z_]+\]|\Z)', re.S)
        m = pattern.search(text)
        if m:
            return Block(name=aliases[0], raw_name=alias, body=m.group(1).strip())
    return None


def normalize(text: str) -> str:
    return re.sub(r'\s+', ' ', text.strip())


def parse_payload(payload: str) -> Dict[str, Optional[Block]]:
    return {key: extract_block(payload, aliases) for key, aliases in BLOCKS.items()}


def parse_gates(payload: str, explicit: List[str]) -> List[str]:
    gates = [g for g in explicit if g]
    m = re.search(r'dispatch_mode\s*:\s*["\']?([^"\'\n]+)', payload)
    if m:
        gates.append(f'mode:{m.group(1).strip()}')
    block = re.search(r'triggered_gates\s*:\s*(.*?)(?=\n(?:source|target|\[USER_RAW\])|\Z)', payload, re.S)
    if block:
        gates.extend(re.findall(r'-\s*["\']?([^"\'\n]+)', block.group(1)))
    return list(dict.fromkeys(gates))


def declared_none(text: str) -> bool:
    return normalize(text).lower() in {'none', '- none', '[none]'}


def main() -> int:
    parser = argparse.ArgumentParser(description='Check first-hop dispatch fidelity payloads.')
    parser.add_argument('--latest-user-message', required=True, help='Raw latest user message or @path/to/file')
    parser.add_argument('--dispatch-payload', required=True, help='Dispatch payload text or @path/to/file')
    parser.add_argument('--triggered-gate', action='append', default=[], help='Additional triggered gate values')
    parser.add_argument('--pass-through-threshold', type=float, default=0.92)
    parser.add_argument('--warn-threshold', type=float, default=0.75)
    parser.add_argument('--json-only', action='store_true')
    args = parser.parse_args()

    def load(value: str) -> str:
        if value.startswith('@'):
            return Path(value[1:]).read_text(encoding='utf-8')
        return value

    latest = load(args.latest_user_message)
    payload = load(args.dispatch_payload)
    blocks = parse_payload(payload)
    gates = parse_gates(payload, args.triggered_gate)
    mode = 'pass_through' if any(g in PASS_THROUGH_GATES for g in gates) or 'mode:pass_through' in gates else 'normal'

    missing = [name for name, block in blocks.items() if block is None]
    user_raw = blocks['USER_RAW'].body if blocks['USER_RAW'] else ''
    dispatcher_note = blocks['DISPATCHER_NOTE'].body if blocks['DISPATCHER_NOTE'] else ''
    dropped = blocks['DROPPED_CONSTRAINTS_LIST'].body if blocks['DROPPED_CONSTRAINTS_LIST'] else ''

    diff_ratio = SequenceMatcher(None, normalize(latest), normalize(user_raw)).ratio() if latest or user_raw else 0.0
    dropped_declared = bool(dropped and not declared_none(dropped))
    note_to_raw_ratio = round(len(dispatcher_note) / max(len(user_raw), 1), 3) if dispatcher_note else 0.0

    violations: List[str] = []
    warnings: List[str] = []

    if missing:
        violations.append('missing_required_blocks')
    if mode == 'pass_through' and diff_ratio < args.pass_through_threshold:
        violations.append('user_raw_mismatch_under_pass_through')
    elif diff_ratio < args.warn_threshold:
        warnings.append('user_raw_similarity_low')
    if normalize(user_raw) != normalize(latest) and not dropped_declared:
        violations.append('dropped_constraints_undeclared')
    if mode == 'pass_through' and note_to_raw_ratio > 1.2:
        warnings.append('dispatcher_note_longer_than_user_raw_in_pass_through')
    if blocks['DISPATCHER_NOTE'] and blocks['DISPATCHER_NOTE'].raw_name == 'DISPATCHER_NOTE':
        warnings.append('legacy_dispatcher_note_alias_used')

    status = 'pass'
    if violations:
        status = 'fail'
    elif warnings:
        status = 'warn'

    result = {
        'status': status,
        'mode': mode,
        'triggered_gates': gates,
        'missing_fields': missing,
        'diff_ratio': round(diff_ratio, 4),
        'note_to_raw_ratio': note_to_raw_ratio,
        'dropped_constraints_declared': dropped_declared,
        'violations': violations,
        'warnings': warnings,
        'blocks': {
            k: ({'matched_as': v.raw_name, 'length': len(v.body)} if v else None) for k, v in blocks.items()
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=None if args.json_only else 2))
    return 1 if status == 'fail' else 0


if __name__ == '__main__':
    sys.exit(main())
