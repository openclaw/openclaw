import json, traceback, sys
try:
    with open('config/openclaw_config.json', encoding='utf-8') as f:
        data = f.read()
    print(f'File length: {len(data)}')
    print(f'First 200 chars: {repr(data[:200])}')
    json.loads(data)
    print('JSON OK')
except Exception:
    traceback.print_exc()
    sys.exit(1)
