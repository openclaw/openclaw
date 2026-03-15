---
name: qenjin-n8n
description: n8n workflow orchestration — status, trigger, logs, design.
user-invocable: true
disable-model-invocation: false
triggers:
  - /n8n
  - /workflow
  - /automate
---

# qenjin-n8n

n8n workflow management via REST API.

Base URL: `https://n8n.huda20.fun`
Auth: API key from env var `N8N_API_KEY`.

## On `/n8n status`

List running workflows and recent executions.

```bash
python3 -c "
import json, subprocess, os

TOKEN = os.environ.get('N8N_API_KEY', '')
BASE = 'https://n8n.huda20.fun'

# Get all workflows
r = subprocess.run([
    'curl', '-s',
    '-H', f'X-N8N-API-KEY: {TOKEN}',
    f'{BASE}/api/v1/workflows?limit=50'
], capture_output=True, text=True)

try:
    data = json.loads(r.stdout)
    workflows = data.get('data', [])
    active = [w for w in workflows if w.get('active')]
    inactive = [w for w in workflows if not w.get('active')]
    print(f'Workflows: {len(workflows)} total, {len(active)} active, {len(inactive)} inactive')
    print()
    for w in active:
        print(f'  [ON]  {w.get(\"name\", \"unnamed\")} (id: {w.get(\"id\", \"?\")})')
    for w in inactive[:5]:
        print(f'  [OFF] {w.get(\"name\", \"unnamed\")} (id: {w.get(\"id\", \"?\")})')
except Exception as e:
    print(f'API error — check N8N_API_KEY. ({e})')
"
```

```bash
python3 -c "
import json, subprocess, os

TOKEN = os.environ.get('N8N_API_KEY', '')
BASE = 'https://n8n.huda20.fun'

# Get recent executions
r = subprocess.run([
    'curl', '-s',
    '-H', f'X-N8N-API-KEY: {TOKEN}',
    f'{BASE}/api/v1/executions?limit=10'
], capture_output=True, text=True)

try:
    data = json.loads(r.stdout)
    executions = data.get('data', [])
    print(f'Recent executions: {len(executions)}')
    for ex in executions:
        status = ex.get('status', '?')
        wf = ex.get('workflowData', {}).get('name', 'unnamed')
        finished = (ex.get('stoppedAt') or '?')[:19]
        print(f'  {status} | {wf} | {finished}')
except Exception as e:
    print(f'API error. ({e})')
"
```

Reply: workflow counts, then active list, then last 10 executions.

## On `/n8n trigger [name]`

Manually trigger a workflow by name.

```bash
python3 -c "
import json, subprocess, os, sys

TOKEN = os.environ.get('N8N_API_KEY', '')
BASE = 'https://n8n.huda20.fun'
name = ' '.join(sys.argv[1:])
if not name:
    print('Usage: /n8n trigger <workflow-name>')
    exit()

# Find workflow by name
r = subprocess.run([
    'curl', '-s',
    '-H', f'X-N8N-API-KEY: {TOKEN}',
    f'{BASE}/api/v1/workflows?limit=100'
], capture_output=True, text=True)

try:
    data = json.loads(r.stdout)
    workflows = data.get('data', [])
    match = None
    for w in workflows:
        if name.lower() in w.get('name', '').lower():
            match = w
            break
    if not match:
        print(f'No workflow matching \"{name}\".')
        exit()

    wf_id = match['id']
    # Activate if needed, then trigger via webhook or execution
    r2 = subprocess.run([
        'curl', '-s', '-X', 'POST',
        '-H', f'X-N8N-API-KEY: {TOKEN}',
        '-H', 'Content-Type: application/json',
        '-d', '{}',
        f'{BASE}/api/v1/workflows/{wf_id}/activate'
    ], capture_output=True, text=True)

    print(f'Triggered: {match[\"name\"]} (id: {wf_id})')
except Exception as e:
    print(f'API error. ({e})')
" <name>
```

Reply: `Triggered: <workflow-name> (id: <id>)` or `No workflow matching "<name>".`

## On `/n8n logs [name]`

Last 10 executions + errors for a specific workflow.

```bash
python3 -c "
import json, subprocess, os, sys

TOKEN = os.environ.get('N8N_API_KEY', '')
BASE = 'https://n8n.huda20.fun'
name = ' '.join(sys.argv[1:])
if not name:
    print('Usage: /n8n logs <workflow-name>')
    exit()

# Find workflow ID
r = subprocess.run([
    'curl', '-s',
    '-H', f'X-N8N-API-KEY: {TOKEN}',
    f'{BASE}/api/v1/workflows?limit=100'
], capture_output=True, text=True)

try:
    data = json.loads(r.stdout)
    workflows = data.get('data', [])
    match = None
    for w in workflows:
        if name.lower() in w.get('name', '').lower():
            match = w
            break
    if not match:
        print(f'No workflow matching \"{name}\".')
        exit()

    wf_id = match['id']

    # Get executions for this workflow
    r2 = subprocess.run([
        'curl', '-s',
        '-H', f'X-N8N-API-KEY: {TOKEN}',
        f'{BASE}/api/v1/executions?workflowId={wf_id}&limit=10'
    ], capture_output=True, text=True)

    execs = json.loads(r2.stdout).get('data', [])
    print(f'{match[\"name\"]} — last {len(execs)} executions:')
    for ex in execs:
        status = ex.get('status', '?')
        finished = (ex.get('stoppedAt') or '?')[:19]
        error = ''
        if status == 'error':
            error = f' — {ex.get(\"stoppedAt\", \"unknown error\")}'
        print(f'  {status} | {finished}{error}')
except Exception as e:
    print(f'API error. ({e})')
" <name>
```

Reply: workflow name, then execution list with status and timestamps.

## On `/n8n create [description]`

Design a new workflow. Output an n8n-compatible JSON structure.

Do not call any API. Generate the workflow JSON based on the description.

Include:
- Trigger node (webhook, cron, or manual)
- Processing nodes as described
- Output node (webhook response, HTTP request, or Set)
- Connections array

Reply: the JSON, ready to import via n8n UI.

## Rules

- Numbers first. Status counts before lists.
- Never expose API keys in replies.
- API errors: `API error — check N8N_API_KEY and server.`
- Workflow matching is case-insensitive partial match.
- "Done." is a complete response when appropriate.
