#!/usr/bin/env python3
import argparse
import json
import sys
import time
from pathlib import Path

from bridge_contract import ALLOWED_KINDS, build_request_envelope, read_json


def main() -> int:
    parser = argparse.ArgumentParser(description='Enqueue a SolidWorks bridge request.')
    parser.add_argument('kind', choices=ALLOWED_KINDS)
    parser.add_argument('--queue-root', default='/home/mertb/.openclaw/workspace/solidworks-copilot/queue')
    parser.add_argument('--request-id')
    parser.add_argument('--payload-file', help='Optional JSON object payload to include in the request envelope.')
    parser.add_argument('--wait', action='store_true')
    parser.add_argument('--timeout-seconds', type=int, default=60)
    args = parser.parse_args()

    queue_root = Path(args.queue_root)
    inbound = queue_root / 'inbound'
    outbound = queue_root / 'outbound'
    inbound.mkdir(parents=True, exist_ok=True)
    outbound.mkdir(parents=True, exist_ok=True)

    payload = {}
    if args.payload_file:
        payload = read_json(Path(args.payload_file))
        if not isinstance(payload, dict):
            raise ValueError('Request payload file must contain a JSON object')

    request = build_request_envelope(args.kind, args.request_id, payload=payload)
    request_id = request['requestId']
    request_path = inbound / f'{request_id}.json'
    result_path = outbound / f'{request_id}.result.json'

    with request_path.open('w', encoding='utf-8') as f:
        json.dump(request, f, indent=2)
        f.write('\n')

    response = {
        'requestId': request_id,
        'requestPath': str(request_path),
        'resultPath': str(result_path),
        'waited': False,
        'result': None,
    }

    if args.wait:
        deadline = time.time() + args.timeout_seconds
        while time.time() < deadline:
            if result_path.exists():
                with result_path.open('r', encoding='utf-8') as f:
                    response['result'] = json.load(f)
                response['waited'] = True
                print(json.dumps(response, indent=2))
                return 0
            time.sleep(1)

        response['waited'] = True
        response['error'] = {
            'message': f'Timed out waiting for result file: {result_path}',
            'type': 'TimeoutError',
        }
        print(json.dumps(response, indent=2))
        return 2

    print(json.dumps(response, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
