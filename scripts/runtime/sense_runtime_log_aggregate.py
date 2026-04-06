#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Aggregate runtime entry observability records by route signature.'
    )
    parser.add_argument('--records-json')
    parser.add_argument('--actionable-only', action='store_true')
    parser.add_argument('--recovery-owner')
    parser.add_argument('--top-n', type=int)
    return parser


def parse_timestamp(raw_value: object) -> tuple[datetime | None, str | None]:
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None, None
    normalized = raw_value.strip()
    iso_value = normalized[:-1] + '+00:00' if normalized.endswith('Z') else normalized
    try:
        parsed = datetime.fromisoformat(iso_value)
    except ValueError:
        return None, normalized
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc), normalized


def derive_route_signature(record: dict) -> str | None:
    route_signature = record.get('route_signature')
    if isinstance(route_signature, str) and route_signature.strip():
        return route_signature.strip()

    path_signature = record.get('path_signature')
    recovery_signature = record.get('recovery_signature')
    if (
        isinstance(path_signature, str)
        and path_signature.strip()
        and isinstance(recovery_signature, str)
        and recovery_signature.strip()
    ):
        return f'{path_signature.strip()} | {recovery_signature.strip()}'
    return None


def load_records(raw_input: str) -> list[dict]:
    stripped = raw_input.strip()
    if not stripped:
        return []

    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, dict)]
    if isinstance(parsed, dict):
        return [parsed]

    records: list[dict] = []
    for line in raw_input.splitlines():
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        if isinstance(item, dict):
            records.append(item)
    return records


def main() -> int:
    args = build_parser().parse_args()
    raw_input = args.records_json if isinstance(args.records_json, str) else sys.stdin.read()
    records = load_records(raw_input)

    filtered_records: list[dict] = []
    for record in records:
        route_signature = derive_route_signature(record)
        if not route_signature:
            continue
        if args.actionable_only and record.get('recovery_actionable') is not True:
            continue
        if args.recovery_owner:
            owner = record.get('recovery_owner')
            if not isinstance(owner, str) or owner != args.recovery_owner:
                continue
        normalized = dict(record)
        normalized['route_signature'] = route_signature
        filtered_records.append(normalized)

    grouped: dict[str, dict] = {}
    owner_bucket_crosstab: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    owner_bucket_actionable_summary: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(lambda: {'total': 0, 'actionable': 0, 'non_actionable': 0})
    )
    for record in filtered_records:
        route_signature = record['route_signature']
        aggregate = grouped.setdefault(
            route_signature,
            {
                'route_signature': route_signature,
                'count': 0,
                'latest_timestamp': None,
                '_latest_dt': None,
                'recovery_owner_counts': defaultdict(int),
                'actionable_count': 0,
                'max_recovery_rank': 0,
                'sample_error_code': None,
            },
        )
        aggregate['count'] += 1
        owner = record.get('recovery_owner')
        if isinstance(owner, str) and owner.strip():
            aggregate['recovery_owner_counts'][owner] += 1
            owner_key = owner
        else:
            owner_key = 'unknown'
        bucket = record.get('recovery_bucket')
        bucket_key = bucket if isinstance(bucket, str) and bucket.strip() else 'unknown'
        owner_bucket_crosstab[owner_key][bucket_key] += 1
        actionable = record.get('recovery_actionable') is True
        cell = owner_bucket_actionable_summary[owner_key][bucket_key]
        cell['total'] += 1
        if actionable:
            cell['actionable'] += 1
            aggregate['actionable_count'] += 1
        else:
            cell['non_actionable'] += 1
        rank = record.get('recovery_rank')
        if isinstance(rank, int) and rank > aggregate['max_recovery_rank']:
            aggregate['max_recovery_rank'] = rank
        error_code = record.get('error_code')
        if aggregate['sample_error_code'] is None and isinstance(error_code, str) and error_code.strip():
            aggregate['sample_error_code'] = error_code

        timestamp_candidate = (
            record.get('timestamp')
            or record.get('observed_at')
            or record.get('created_at')
        )
        parsed_dt, original_value = parse_timestamp(timestamp_candidate)
        current_latest = aggregate['_latest_dt']
        if parsed_dt is not None:
            if current_latest is None or parsed_dt >= current_latest:
                aggregate['_latest_dt'] = parsed_dt
                aggregate['latest_timestamp'] = parsed_dt.isoformat().replace('+00:00', 'Z')
        elif aggregate['latest_timestamp'] is None and original_value is not None:
            aggregate['latest_timestamp'] = original_value

    aggregated_routes: list[dict] = []
    for aggregate in grouped.values():
        aggregated_routes.append(
            {
                'route_signature': aggregate['route_signature'],
                'count': aggregate['count'],
                'latest_timestamp': aggregate['latest_timestamp'],
                'recovery_owner_counts': dict(sorted(aggregate['recovery_owner_counts'].items())),
                'actionable_count': aggregate['actionable_count'],
                'max_recovery_rank': aggregate['max_recovery_rank'],
                'sample_error_code': aggregate['sample_error_code'],
            }
        )

    aggregated_routes.sort(
        key=lambda item: (
            -int(item.get('count', 0)),
            -(int(item.get('max_recovery_rank', 0))),
            str(item.get('route_signature') or ''),
        )
    )
    if isinstance(args.top_n, int) and args.top_n > 0:
        aggregated_routes = aggregated_routes[: args.top_n]

    ordered_buckets = [
        'auth',
        'runtime_submit',
        'runtime_poll',
        'control_plane',
        'config_mapping',
        'executor_gate',
        'none',
        'unknown',
    ]
    crosstab_output: dict[str, dict[str, int]] = {}
    actionable_summary_output: dict[str, dict[str, dict[str, int]]] = {}
    for owner_key in sorted(owner_bucket_crosstab.keys()):
        row = owner_bucket_crosstab[owner_key]
        ordered_row = {bucket_name: int(row.get(bucket_name, 0)) for bucket_name in ordered_buckets}
        extra_buckets = sorted(bucket for bucket in row.keys() if bucket not in ordered_row)
        for bucket_name in extra_buckets:
            ordered_row[bucket_name] = int(row.get(bucket_name, 0))
        crosstab_output[owner_key] = ordered_row

        actionable_row = owner_bucket_actionable_summary.get(owner_key, {})
        ordered_actionable_row = {
            bucket_name: {
                'total': int(actionable_row.get(bucket_name, {}).get('total', 0)),
                'actionable': int(actionable_row.get(bucket_name, {}).get('actionable', 0)),
                'non_actionable': int(actionable_row.get(bucket_name, {}).get('non_actionable', 0)),
            }
            for bucket_name in ordered_buckets
        }
        extra_actionable_buckets = sorted(
            bucket for bucket in actionable_row.keys() if bucket not in ordered_actionable_row
        )
        for bucket_name in extra_actionable_buckets:
            bucket_summary = actionable_row.get(bucket_name, {})
            ordered_actionable_row[bucket_name] = {
                'total': int(bucket_summary.get('total', 0)),
                'actionable': int(bucket_summary.get('actionable', 0)),
                'non_actionable': int(bucket_summary.get('non_actionable', 0)),
            }
        actionable_summary_output[owner_key] = ordered_actionable_row

    output = {
        'total_records': len(filtered_records),
        'aggregated_routes': aggregated_routes,
        'owner_bucket_crosstab': crosstab_output,
        'owner_bucket_actionable_summary': actionable_summary_output,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
