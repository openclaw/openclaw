#!/usr/bin/env python3
import argparse
import csv
import json
import random
import subprocess
import time
from pathlib import Path


def digits(s: str) -> str:
    return ''.join(ch for ch in (s or '') if ch.isdigit())


def norm_phone(s: str) -> str:
    d = digits(s)
    return d[-10:] if len(d) >= 10 else d


def load_queue_from_csv(csv_path: Path, message_template: str, limit: int | None = None):
    seen = set()
    queue = []
    with csv_path.open(newline='') as f:
        for row in csv.DictReader(f):
            phone_raw = (row.get('Phone') or '').strip()
            phone_digits = norm_phone(phone_raw)
            first = (row.get('First Name') or '').strip()
            if not phone_digits or not first:
                continue
            if phone_digits in seen:
                continue
            seen.add(phone_digits)
            queue.append({
                'phoneDigits': phone_digits,
                'phoneRaw': phone_raw,
                'firstName': first,
                'messageText': message_template.replace('[FIRSTNAME]', first),
            })
            if limit is not None and len(queue) >= limit:
                break
    return queue


def append_ledger(ledger_path: Path, rec: dict):
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    with ledger_path.open('a') as f:
        f.write(json.dumps(rec) + '\n')


def already_sent(ledger_path: Path, campaign_id: str):
    sent = set()
    if not ledger_path.exists():
        return sent
    for line in ledger_path.read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if rec.get('campaignId') == campaign_id and rec.get('status') == 'sent':
            sent.add(rec['phoneDigits'])
    return sent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input-csv', required=True)
    ap.add_argument('--queue-jsonl', required=True)
    ap.add_argument('--ledger-jsonl', required=True)
    ap.add_argument('--campaign-id', required=True)
    ap.add_argument('--message-template', required=True)
    ap.add_argument('--script', required=True)
    ap.add_argument('--delay-min-sec', type=float, default=20)
    ap.add_argument('--delay-max-sec', type=float, default=50)
    ap.add_argument('--service', default='sms')
    ap.add_argument('--limit', type=int, default=None)
    args = ap.parse_args()

    queue_path = Path(args.queue_jsonl)
    ledger_path = Path(args.ledger_jsonl)
    queue = load_queue_from_csv(Path(args.input_csv), args.message_template, args.limit)
    queue_path.write_text(''.join(json.dumps(x) + '\n' for x in queue))

    sent_set = already_sent(ledger_path, args.campaign_id)

    for item in queue:
        base = {
            'ts': time.time(),
            'campaignId': args.campaign_id,
            'phoneDigits': item['phoneDigits'],
            'phoneRaw': item['phoneRaw'],
            'firstName': item['firstName'],
        }
        if item['phoneDigits'] in sent_set:
            append_ledger(ledger_path, {**base, 'status': 'skipped-already-sent'})
            continue

        append_ledger(ledger_path, {**base, 'status': 'queued'})
        p = subprocess.run([
            'osascript', args.script, item['phoneRaw'], item['messageText'], args.service
        ], capture_output=True, text=True)

        status = 'sent' if p.returncode == 0 else 'failed'
        append_ledger(ledger_path, {
            **base,
            'status': status,
            'stderr': (p.stderr or '')[:200],
            'stdout': (p.stdout or '')[:200],
        })
        if status == 'sent':
            sent_set.add(item['phoneDigits'])

        time.sleep(random.uniform(args.delay_min_sec, args.delay_max_sec))


if __name__ == '__main__':
    main()
