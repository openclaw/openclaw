#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone

PRIORITY_ORDER = ['immediate', 'high', 'medium', 'low', 'none']
PRIORITY_LEVEL = {
    'immediate': 4,
    'high': 3,
    'medium': 2,
    'low': 1,
    'none': 0,
}
PRIORITY_WEIGHTS = {
    'immediate': 100,
    'high': 75,
    'medium': 50,
    'low': 25,
    'none': 0,
}
BUCKET_LABELS = {
    'auth': 'Auth failure',
    'runtime_submit': 'Runtime submit issue',
    'runtime_poll': 'Runtime poll issue',
    'control_plane': 'Control-plane issue',
    'executor_gate': 'Executor gate stop',
    'config_mapping': 'Config mapping issue',
    'none': 'No issue',
    'unknown': 'Unknown issue',
}
BUCKET_SHORT_LABELS = {
    'auth': 'Auth failure',
    'runtime_submit': 'Runtime submit',
    'runtime_poll': 'Runtime poll',
    'control_plane': 'Control-plane',
    'executor_gate': 'Executor gate',
    'config_mapping': 'Config mapping',
    'none': 'No issue',
    'unknown': 'Unknown',
}
BUCKET_DIGEST_LABELS = {
    'auth': 'Auth failures',
    'runtime_submit': 'Runtime submit issues',
    'runtime_poll': 'Runtime poll issues',
    'control_plane': 'Control-plane issues',
    'executor_gate': 'Executor gate stops',
    'config_mapping': 'Config mapping issues',
    'none': 'No issues',
    'unknown': 'Unknown issues',
}
PATH_LABELS = {
    'NO_HANDOFF>FULL_EVAL>FAILED': 'full-eval path',
    'NO_HANDOFF>FULL_EVAL>EXECUTOR': 'full-eval executor path',
    'HANDOFF>TRIAGE_HINT>FULL_EVAL>EXECUTOR': 'full-eval executor path',
    'HANDOFF>TRIAGE_USE>SHORTCUT>BRIDGE>EXECUTOR': 'shortcut bridge path',
}
PATH_SHORT_LABELS = {
    'NO_HANDOFF>FULL_EVAL>FAILED': 'full-eval',
    'NO_HANDOFF>FULL_EVAL>EXECUTOR': 'full-eval',
    'HANDOFF>TRIAGE_HINT>FULL_EVAL>EXECUTOR': 'full-eval',
    'HANDOFF>TRIAGE_USE>SHORTCUT>BRIDGE>EXECUTOR': 'shortcut',
}


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


def derive_path_signature(route_signature: str) -> str:
    if ' | ' in route_signature:
        return route_signature.split(' | ', 1)[0].strip()
    return route_signature.strip()


def derive_recovery_bucket_from_route_signature(route_signature: str) -> str:
    if ' | ' not in route_signature:
        return 'unknown'
    recovery_signature = route_signature.split(' | ', 1)[1].strip()
    if not recovery_signature:
        return 'unknown'
    return recovery_signature.split(':', 1)[0].strip() or 'unknown'


def derive_notification_title(route_signature: str, bucket: str) -> str:
    path_signature = derive_path_signature(route_signature)
    bucket_label = BUCKET_LABELS.get(bucket, bucket or 'unknown')
    path_label = PATH_LABELS.get(path_signature, path_signature)
    return f'{bucket_label} on {path_label}'


def derive_notification_title_short(route_signature: str, bucket: str) -> str:
    path_signature = derive_path_signature(route_signature)
    bucket_label = BUCKET_SHORT_LABELS.get(bucket, bucket or 'unknown')
    path_label = PATH_SHORT_LABELS.get(path_signature, PATH_LABELS.get(path_signature, path_signature))
    return f'{bucket_label} / {path_label}'


def derive_digest_title(bucket: str, band: str) -> str:
    bucket_label = BUCKET_DIGEST_LABELS.get(bucket, bucket or 'unknown')
    normalized_band = band if band in PRIORITY_LEVEL else 'none'
    return f'{bucket_label} ({normalized_band})'


def derive_digest_sort_key(
    max_recovery_rank: object,
    latest_timestamp: object,
    count: object,
    notification_group_key: object,
) -> str:
    rank = int(max_recovery_rank) if isinstance(max_recovery_rank, int) else 0
    parsed_dt, original_value = parse_timestamp(latest_timestamp)
    if parsed_dt is not None:
        timestamp_key = parsed_dt.strftime('%Y%m%dT%H%M%SZ')
    elif isinstance(original_value, str) and original_value.strip():
        timestamp_key = original_value.strip().replace(':', '').replace('-', '')
    else:
        timestamp_key = '00000000T000000Z'
    normalized_count = int(count) if isinstance(count, int) else 0
    normalized_group_key = (
        str(notification_group_key).strip() if isinstance(notification_group_key, str) else 'unknown'
    )
    return f'{rank:03d}:{timestamp_key}:{normalized_count:06d}:{normalized_group_key}'


def derive_path_group(route_signature: str) -> str:
    path_signature = derive_path_signature(route_signature)
    return PATH_SHORT_LABELS.get(path_signature, 'other')


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
    owner_bucket_priority_summary: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(
            lambda: {'immediate': 0, 'high': 0, 'medium': 0, 'low': 0, 'none': 0}
        )
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
                '_strongest_priority_level': 0,
                'strongest_priority_band': 'none',
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
        priority = record.get('recovery_priority')
        priority_key = priority if isinstance(priority, str) and priority in PRIORITY_LEVEL else 'none'
        owner_bucket_priority_summary[owner_key][bucket_key][priority_key] += 1
        priority_level = PRIORITY_LEVEL[priority_key]
        if priority_level > aggregate['_strongest_priority_level']:
            aggregate['_strongest_priority_level'] = priority_level
            aggregate['strongest_priority_band'] = priority_key
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
                'strongest_priority_band': aggregate['strongest_priority_band'],
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
    priority_summary_output: dict[str, dict[str, dict[str, int]]] = {}
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

        priority_row = owner_bucket_priority_summary.get(owner_key, {})
        ordered_priority_row = {
            bucket_name: {
                'immediate': int(priority_row.get(bucket_name, {}).get('immediate', 0)),
                'high': int(priority_row.get(bucket_name, {}).get('high', 0)),
                'medium': int(priority_row.get(bucket_name, {}).get('medium', 0)),
                'low': int(priority_row.get(bucket_name, {}).get('low', 0)),
                'none': int(priority_row.get(bucket_name, {}).get('none', 0)),
            }
            for bucket_name in ordered_buckets
        }
        extra_priority_buckets = sorted(
            bucket for bucket in priority_row.keys() if bucket not in ordered_priority_row
        )
        for bucket_name in extra_priority_buckets:
            bucket_summary = priority_row.get(bucket_name, {})
            ordered_priority_row[bucket_name] = {
                'immediate': int(bucket_summary.get('immediate', 0)),
                'high': int(bucket_summary.get('high', 0)),
                'medium': int(bucket_summary.get('medium', 0)),
                'low': int(bucket_summary.get('low', 0)),
                'none': int(bucket_summary.get('none', 0)),
            }
        priority_summary_output[owner_key] = ordered_priority_row

    priority_heatmap: list[dict[str, object]] = []
    for owner_key in sorted(priority_summary_output.keys()):
        row = priority_summary_output[owner_key]
        for bucket_name, counts in row.items():
            score = sum(int(counts.get(name, 0)) * PRIORITY_WEIGHTS[name] for name in PRIORITY_ORDER)
            band = 'none'
            for name in PRIORITY_ORDER:
                if int(counts.get(name, 0)) > 0:
                    band = name
                    break
            priority_heatmap.append(
                {
                    'owner': owner_key,
                    'bucket': bucket_name,
                    'score': score,
                    'band': band,
                    'counts': {name: int(counts.get(name, 0)) for name in PRIORITY_ORDER},
                }
            )
    priority_heatmap.sort(
        key=lambda item: (
            -int(item.get('score', 0)),
            str(item.get('owner') or ''),
            str(item.get('bucket') or ''),
        )
    )
    priority_heatmap_compact = [
        item for item in priority_heatmap if int(item.get('score', 0)) > 0
    ]
    route_severity_compact = [
        {
            'route_signature': item['route_signature'],
            'notification_signature': (
                f"{derive_recovery_bucket_from_route_signature(str(item.get('route_signature') or ''))}."
                f"{item.get('strongest_priority_band', 'none')}."
                f"{derive_path_signature(str(item.get('route_signature') or ''))}"
            ),
            'notification_group_key': (
                f"{derive_recovery_bucket_from_route_signature(str(item.get('route_signature') or ''))}."
                f"{item.get('strongest_priority_band', 'none')}."
                f"{derive_path_group(str(item.get('route_signature') or ''))}"
            ),
            'notification_title': derive_notification_title(
                str(item.get('route_signature') or ''),
                derive_recovery_bucket_from_route_signature(str(item.get('route_signature') or '')),
            ),
            'notification_title_short': derive_notification_title_short(
                str(item.get('route_signature') or ''),
                derive_recovery_bucket_from_route_signature(str(item.get('route_signature') or '')),
            ),
            'count': item['count'],
            'score': item['max_recovery_rank'],
            'band': item.get('strongest_priority_band', 'none'),
            'actionable_count': item['actionable_count'],
            'max_recovery_rank': item['max_recovery_rank'],
            'sample_error_code': item['sample_error_code'],
            'latest_timestamp': item['latest_timestamp'],
        }
        for item in aggregated_routes
        if int(item.get('max_recovery_rank', 0)) > 0
    ]
    route_severity_compact.sort(
        key=lambda item: (
            -int(item.get('score', 0)),
            -int(item.get('count', 0)),
            str(item.get('route_signature') or ''),
        )
    )
    notification_digest_grouped: dict[str, dict[str, object]] = {}
    for item in route_severity_compact:
        group_key = str(item.get('notification_group_key') or '')
        if not group_key:
            continue
        aggregate = notification_digest_grouped.setdefault(
            group_key,
            {
                'notification_group_key': group_key,
                'notification_title': item.get('notification_title'),
                'notification_title_short': item.get('notification_title_short'),
                'count': 0,
                'latest_timestamp': item.get('latest_timestamp'),
                'max_recovery_rank': 0,
                'band': item.get('band', 'none'),
                'sample_error_code': item.get('sample_error_code'),
                '_band_level': PRIORITY_LEVEL.get(str(item.get('band') or 'none'), 0),
                '_latest_dt': None,
            },
        )
        aggregate['count'] = int(aggregate.get('count', 0)) + int(item.get('count', 0))
        score = int(item.get('max_recovery_rank', 0))
        if score > int(aggregate.get('max_recovery_rank', 0)):
            aggregate['max_recovery_rank'] = score
        band = str(item.get('band') or 'none')
        band_level = PRIORITY_LEVEL.get(band, 0)
        if band_level > int(aggregate.get('_band_level', 0)):
            aggregate['_band_level'] = band_level
            aggregate['band'] = band
        error_code = item.get('sample_error_code')
        if aggregate.get('sample_error_code') is None and isinstance(error_code, str) and error_code.strip():
            aggregate['sample_error_code'] = error_code
        parsed_dt, original_value = parse_timestamp(item.get('latest_timestamp'))
        current_latest = aggregate.get('_latest_dt')
        if parsed_dt is not None:
            if current_latest is None or parsed_dt >= current_latest:
                aggregate['_latest_dt'] = parsed_dt
                aggregate['latest_timestamp'] = parsed_dt.isoformat().replace('+00:00', 'Z')
        elif aggregate.get('latest_timestamp') is None and original_value is not None:
            aggregate['latest_timestamp'] = original_value

    notification_digest_summary: list[dict[str, object]] = []
    for aggregate in notification_digest_grouped.values():
        notification_digest_summary.append(
            {
                'notification_group_key': aggregate['notification_group_key'],
                'digest_title': derive_digest_title(
                    str(aggregate['notification_group_key']).split('.', 1)[0],
                    str(aggregate['band'] or 'none'),
                ),
                'digest_sort_key': derive_digest_sort_key(
                    aggregate['max_recovery_rank'],
                    aggregate['latest_timestamp'],
                    aggregate['count'],
                    aggregate['notification_group_key'],
                ),
                'notification_title': aggregate['notification_title'],
                'notification_title_short': aggregate['notification_title_short'],
                'count': aggregate['count'],
                'latest_timestamp': aggregate['latest_timestamp'],
                'max_recovery_rank': aggregate['max_recovery_rank'],
                'band': aggregate['band'],
                'sample_error_code': aggregate['sample_error_code'],
            }
        )
    notification_digest_summary.sort(
        key=lambda item: (
            -int(item.get('max_recovery_rank', 0)),
            -int(item.get('count', 0)),
            str(item.get('notification_group_key') or ''),
        )
    )

    output = {
        'total_records': len(filtered_records),
        'aggregated_routes': aggregated_routes,
        'owner_bucket_crosstab': crosstab_output,
        'owner_bucket_actionable_summary': actionable_summary_output,
        'owner_bucket_priority_summary': priority_summary_output,
        'priority_heatmap': priority_heatmap,
        'priority_heatmap_compact': priority_heatmap_compact,
        'route_severity_compact': route_severity_compact,
        'notification_digest_summary': notification_digest_summary,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
