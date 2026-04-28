#!/usr/bin/env python3
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ALLOWED_KINDS = [
    'ping',
    'capabilities',
    'get-active-document',
    'get-document-metadata',
    'get-selection-context',
    'get-assembly-summary',
    'extract-poc-context',
]

READ_ONLY_FEATURES = ['read-only', 'queue-transport', 'seeded-probe']


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def ensure_allowed_kind(kind: str) -> str:
    if kind not in ALLOWED_KINDS:
        raise ValueError(f'Unsupported kind: {kind}')
    return kind


def build_request_envelope(kind: str, request_id: str | None = None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    ensure_allowed_kind(kind)
    rid = request_id or f'{kind}-{uuid.uuid4().hex[:12]}'
    return {
        'schemaVersion': 'solidworks-bridge-request-envelope-v1',
        'requestId': rid,
        'kind': kind,
        'createdAtUtc': utc_now_iso(),
        'status': 'pending',
        'payload': payload or {},
    }


def build_probe_diagnostics(extra_warnings: list[str] | None = None) -> dict[str, Any]:
    warnings = [
        'SolidWorks live extraction not connected yet; returning seeded PoC data.',
        'This probe confirms the contract and transport shape, not live CAD access.',
    ]
    if extra_warnings:
        warnings.extend(extra_warnings)

    return {
        'warnings': warnings,
        'partialRead': False,
        'unsupportedFields': [],
        'confidenceHints': ['Top-level assembly summary only'],
    }


def build_result_envelope(
    request: dict[str, Any],
    *,
    host: str,
    handler: str,
    output: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    status = 'failed' if error else 'succeeded'
    return {
        'schemaVersion': 'solidworks-bridge-result-envelope-v1',
        'requestId': request['requestId'],
        'kind': request['kind'],
        'status': status,
        'startedAtUtc': utc_now_iso(),
        'finishedAtUtc': utc_now_iso(),
        'host': host,
        'handler': handler,
        'output': output,
        'error': error,
    }


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')


def require_keys(payload: dict[str, Any], required: list[str], *, label: str) -> None:
    missing = [key for key in required if key not in payload]
    if missing:
        raise ValueError(f'{label} missing required keys: {", ".join(missing)}')


def validate_request_envelope(payload: dict[str, Any]) -> None:
    require_keys(
        payload,
        ['schemaVersion', 'requestId', 'kind', 'createdAtUtc', 'status', 'payload'],
        label='request envelope',
    )
    if payload['schemaVersion'] != 'solidworks-bridge-request-envelope-v1':
        raise ValueError(f'Unsupported request schemaVersion: {payload["schemaVersion"]}')
    ensure_allowed_kind(payload['kind'])
    if payload['status'] != 'pending':
        raise ValueError(f'Unexpected request status: {payload["status"]}')
    if not isinstance(payload['payload'], dict):
        raise ValueError('Request payload must be an object')


def validate_contract_payload(payload: dict[str, Any]) -> None:
    require_keys(payload, ['document', 'selection', 'metadata', 'assembly', 'diagnostics'], label='contract payload')
    require_keys(payload['document'], ['name', 'path', 'type'], label='document')
    require_keys(payload['selection'], ['exists', 'count'], label='selection')
    require_keys(payload['metadata'], ['customProperties', 'missingRequired', 'emptyFields'], label='metadata')
    require_keys(payload['assembly'], ['isAssembly', 'topLevelComponentCount', 'topLevelComponents'], label='assembly')
    require_keys(payload['diagnostics'], ['warnings', 'partialRead'], label='diagnostics')


def validate_probe_output(kind: str, payload: dict[str, Any]) -> None:
    require_keys(payload, ['generatedAtUtc', 'mode', 'kind', 'data', 'diagnostics'], label='probe output')
    if kind == 'get-active-document':
        if payload['mode'] not in {'seeded-probe', 'live-extractor'}:
            raise ValueError(f'Unexpected get-active-document mode: {payload["mode"]}')
    elif payload['mode'] != 'seeded-probe':
        raise ValueError(f'Unexpected probe mode: {payload["mode"]}')
    if payload['kind'] != kind:
        raise ValueError(f'Probe output kind mismatch: expected {kind}, got {payload["kind"]}')
    require_keys(payload['diagnostics'], ['warnings', 'partialRead'], label='probe diagnostics')
    if kind == 'extract-poc-context':
        validate_contract_payload(payload['data'])
    elif kind == 'get-active-document':
        require_keys(payload['data'], ['name', 'path', 'type'], label='get-active-document payload')
    elif kind == 'capabilities':
        require_keys(payload['data'], ['supportedCommands', 'features'], label='capabilities payload')
    elif kind == 'ping':
        require_keys(payload['data'], ['message'], label='ping payload')


def validate_result_envelope(payload: dict[str, Any]) -> None:
    require_keys(
        payload,
        ['schemaVersion', 'requestId', 'kind', 'status', 'startedAtUtc', 'finishedAtUtc', 'host', 'handler', 'output', 'error'],
        label='result envelope',
    )
    if payload['schemaVersion'] != 'solidworks-bridge-result-envelope-v1':
        raise ValueError(f'Unsupported result schemaVersion: {payload["schemaVersion"]}')
    ensure_allowed_kind(payload['kind'])
    if payload['status'] not in {'succeeded', 'failed'}:
        raise ValueError(f'Unexpected result status: {payload["status"]}')
    if payload['status'] == 'succeeded':
        if payload['output'] is None:
            raise ValueError('Succeeded result envelope must include output')
        validate_probe_output(payload['kind'], payload['output'])
    if payload['status'] == 'failed' and payload['error'] is None:
        raise ValueError('Failed result envelope must include error')
