#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from bridge_contract import (
    build_request_envelope,
    read_json,
    validate_contract_payload,
    validate_probe_output,
    validate_request_envelope,
    validate_result_envelope,
    write_json,
)
from solidworks_probe import build_result


def main() -> int:
    parser = argparse.ArgumentParser(description='Validate SolidWorks bridge examples and generated seeded outputs.')
    parser.add_argument(
        '--workspace-root',
        default='/home/mertb/.openclaw/workspace/solidworks-copilot',
        help='Workspace root that contains contracts/ and artifacts/.',
    )
    args = parser.parse_args()

    root = Path(args.workspace_root)
    contracts_dir = root / 'contracts'
    artifacts_dir = root / 'artifacts'

    example_contract = read_json(contracts_dir / 'example-poc-context.json')
    validate_contract_payload(example_contract)

    example_probe = read_json(artifacts_dir / 'local-extract-poc-context.json')
    validate_probe_output('extract-poc-context', example_probe)

    host_not_running = read_json(artifacts_dir / 'get-active-document-live-host-not-running.result.json')
    validate_result_envelope(host_not_running)

    no_active_document = read_json(artifacts_dir / 'get-active-document-live-no-active-document.result.json')
    validate_result_envelope(no_active_document)

    generated_request = build_request_envelope('extract-poc-context', request_id='verify-extract-poc-context')
    validate_request_envelope(generated_request)
    write_json(artifacts_dir / 'verification-request-envelope.json', generated_request)

    generated_probe = build_result('extract-poc-context')
    validate_probe_output('extract-poc-context', generated_probe)
    write_json(artifacts_dir / 'verification-probe-output.json', generated_probe)

    generated_result = {
        'schemaVersion': 'solidworks-bridge-result-envelope-v1',
        'requestId': generated_request['requestId'],
        'kind': generated_request['kind'],
        'status': 'succeeded',
        'startedAtUtc': generated_probe['generatedAtUtc'],
        'finishedAtUtc': generated_probe['generatedAtUtc'],
        'host': 'local-verifier',
        'handler': 'verify-contract-examples',
        'output': generated_probe,
        'error': None,
    }
    validate_result_envelope(generated_result)
    write_json(artifacts_dir / 'verification-result-envelope.json', generated_result)

    print('Validated request envelope, probe output, result envelope, and example contract payload.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
