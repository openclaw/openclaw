#!/usr/bin/env python3
import argparse
from pathlib import Path

from bridge_contract import (
    ALLOWED_KINDS,
    READ_ONLY_FEATURES,
    build_probe_diagnostics,
    ensure_allowed_kind,
    utc_now_iso,
    validate_probe_output,
    write_json,
)


def build_stub_document() -> dict:
    return {
        'name': 'MainAssembly.SLDASM',
        'path': 'C:/Projects/MainAssembly.SLDASM',
        'type': 'assembly',
        'configuration': 'Default',
        'units': 'mm',
        'isDirty': False,
    }


def build_stub_metadata() -> dict:
    return {
        'customProperties': {
            'PartNumber': 'ASM-001',
            'Project': 'PilotProject',
            'Material': 'Mixed',
        },
        'missingRequired': ['Description'],
        'emptyFields': [],
        'namingObservations': [],
    }


def build_stub_selection() -> dict:
    return {
        'exists': True,
        'count': 1,
        'entityType': 'component',
        'name': 'Bracket_A',
        'properties': {
            'ComponentType': 'Bracket'
        }
    }


def build_stub_assembly() -> dict:
    return {
        'isAssembly': True,
        'topLevelComponentCount': 3,
        'topLevelComponents': [
            {'name': 'Bracket_A', 'count': 2, 'state': 'resolved'},
            {'name': 'Housing_1', 'count': 1, 'state': 'resolved'},
            {'name': 'FastenerPack', 'count': 8, 'state': 'lightweight'},
        ],
    }


def build_result(kind: str, extra_warnings: list[str] | None = None) -> dict:
    ensure_allowed_kind(kind)
    diagnostics = build_probe_diagnostics(extra_warnings=extra_warnings)
    base = {
        'generatedAtUtc': utc_now_iso(),
        'mode': 'seeded-probe',
        'kind': kind,
        'document': build_stub_document(),
        'selection': build_stub_selection(),
        'metadata': build_stub_metadata(),
        'assembly': build_stub_assembly(),
        'diagnostics': diagnostics,
    }
    if kind == 'get-active-document':
        return {'generatedAtUtc': base['generatedAtUtc'], 'mode': base['mode'], 'kind': kind, 'data': base['document'], 'diagnostics': base['diagnostics']}
    if kind == 'get-document-metadata':
        return {'generatedAtUtc': base['generatedAtUtc'], 'mode': base['mode'], 'kind': kind, 'data': base['metadata'], 'diagnostics': base['diagnostics']}
    if kind == 'get-selection-context':
        return {'generatedAtUtc': base['generatedAtUtc'], 'mode': base['mode'], 'kind': kind, 'data': base['selection'], 'diagnostics': base['diagnostics']}
    if kind == 'get-assembly-summary':
        return {'generatedAtUtc': base['generatedAtUtc'], 'mode': base['mode'], 'kind': kind, 'data': base['assembly'], 'diagnostics': base['diagnostics']}
    if kind == 'extract-poc-context':
        return {
            'generatedAtUtc': base['generatedAtUtc'],
            'mode': base['mode'],
            'kind': kind,
            'data': {
                'document': base['document'],
                'selection': base['selection'],
                'metadata': base['metadata'],
                'assembly': base['assembly'],
                'diagnostics': base['diagnostics'],
            },
            'diagnostics': base['diagnostics']
        }
    if kind == 'capabilities':
        return {
            'generatedAtUtc': base['generatedAtUtc'],
            'mode': base['mode'],
            'kind': kind,
            'data': {
                'supportedCommands': [
                    'ping', 'capabilities', 'get-active-document', 'get-document-metadata',
                    'get-selection-context', 'get-assembly-summary', 'extract-poc-context'
                ],
                'features': READ_ONLY_FEATURES
            },
            'diagnostics': base['diagnostics']
        }
    if kind == 'ping':
        return {
            'generatedAtUtc': base['generatedAtUtc'],
            'mode': base['mode'],
            'kind': kind,
            'data': {'message': 'pong'},
            'diagnostics': base['diagnostics']
        }
def main() -> int:
    parser = argparse.ArgumentParser(description='Generate seeded SolidWorks PoC probe output.')
    parser.add_argument('kind', choices=ALLOWED_KINDS)
    parser.add_argument('--output-path', required=True)
    parser.add_argument('--warning', action='append', default=[])
    args = parser.parse_args()

    output_path = Path(args.output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_result(args.kind, extra_warnings=args.warning)
    validate_probe_output(args.kind, payload)
    write_json(output_path, payload)
    print(str(output_path))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
