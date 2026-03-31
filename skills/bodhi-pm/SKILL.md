---
name: bodhi-pm
description: Project manager mode — model control, thinking effort, task tracking, memory. Mirrors Claude Code UX through Telegram.
user-invocable: true
disable-model-invocation: false
triggers:
  - /pm
  - /project
  - /code
---

# bodhi-pm

Project Manager mode for OpenBodhi. Gives you model selection, thinking effort control, task tracking, and persistent memory — all from Telegram.

## On `/pm` or `/pm on`

Read current model and budget, then reply:

```bash
python3 -c "
import json, pathlib, os
cfg = pathlib.Path(os.path.expanduser('~/.openclaw/openclaw.json'))
d = json.loads(cfg.read_text())
model = d.get('agents', {}).get('defaults', {}).get('model', 'unknown')
thinking = d.get('agents', {}).get('defaults', {}).get('thinkingDefault', 'low')
print(json.dumps({'model': model, 'thinking': thinking}))
"
```

```bash
python3 -c "
import json, pathlib, os
state = pathlib.Path(os.path.expanduser('~/.openclaw/budget-state.json'))
cfg = pathlib.Path(os.path.expanduser('~/.openclaw/openclaw.json'))
if state.exists() and cfg.exists():
    s = json.loads(state.read_text())
    c = json.loads(cfg.read_text()).get('budget', {})
    day = s.get('daySpend', 0)
    limit = c.get('dailyDollars', 2.0)
    print(f'\${day:.2f} / \${limit:.2f} today')
else:
    print('no data')
"
```

Format the activation reply as:

```
🧠 Project Manager — ACTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Model:    <model-name>
Effort:   <thinking-level> thinking
Budget:   <spend today>
━━━━━━━━━━━━━━━━━━━━━━━━━━━
/model sonnet|opus|haiku
/effort low|medium|high
/task add|list|done <n>
/memory show|save <key> <val>
/usage · /pm off
```

## On `/model <name>`

Switch the active model. Accepted names: `sonnet`, `opus`, `haiku`.

Map:
- `sonnet` → `anthropic/claude-sonnet-4-6`
- `opus`   → `anthropic/claude-opus-4-6`
- `haiku`  → `anthropic/claude-haiku-4-5`

```bash
BODHI_MODEL='<name>' python3 -c "
import json, os, pathlib
name = os.environ.get('BODHI_MODEL', 'sonnet').lower()
MAP = {
    'sonnet': 'anthropic/claude-sonnet-4-6',
    'opus': 'anthropic/claude-opus-4-6',
    'haiku': 'anthropic/claude-haiku-4-5',
}
model = MAP.get(name)
if not model:
    print('UNKNOWN')
    exit()
cfg = pathlib.Path(os.path.expanduser('~/.openclaw/openclaw.json'))
d = json.loads(cfg.read_text())
d['agents']['defaults']['model'] = model
tmp = cfg.with_suffix('.tmp')
tmp.write_text(json.dumps(d, indent=2))
tmp.replace(cfg)
print(model)
"
```

- For `opus`: warn before switching — `⚠️ Opus is 5× more expensive ($15/$75 per MTok vs $3/$15). Today remaining: $X.XX. Confirm? Reply /model opus confirm`
- Only switch on `/model opus confirm`
- Reply on success: `Model → <full-model-id> 🟢`
- Reply on unknown name: `Unknown model. Use: sonnet, opus, haiku`

## On `/effort <level>`

Switch thinking depth. Accepted: `low`, `medium`, `high`.

```bash
BODHI_EFFORT='<level>' python3 -c "
import json, os, pathlib
level = os.environ.get('BODHI_EFFORT', 'low').lower()
if level not in ('low', 'medium', 'high'):
    print('UNKNOWN')
    exit()
cfg = pathlib.Path(os.path.expanduser('~/.openclaw/openclaw.json'))
d = json.loads(cfg.read_text())
d['agents']['defaults']['thinkingDefault'] = level
tmp = cfg.with_suffix('.tmp')
tmp.write_text(json.dumps(d, indent=2))
tmp.replace(cfg)
print(level)
"
```

Cost context:
- `low`    → ~1K thinking tokens (~$0.02/msg)
- `medium` → ~4K thinking tokens (~$0.08/msg)
- `high`   → ~16K thinking tokens (~$0.30/msg)

For `high`: include cost warning in reply before confirming.

Reply: `Effort → <level> 🟢`

## On `/task add <description>`

Append task to `~/.openclaw/tasks.md`:

```bash
BODHI_DESC='<description>' python3 -c "
import pathlib, os
desc = os.environ.get('BODHI_DESC', '').strip()
if not desc:
    print('INVALID_ARG')
    exit()
f = pathlib.Path(os.path.expanduser('~/.openclaw/tasks.md'))
lines = f.read_text().splitlines() if f.exists() else []
open_tasks = [l for l in lines if l.startswith('☐')]
n = len(open_tasks) + 1
tmp = f.with_suffix('.tmp')
tmp.write_text('\n'.join(lines + [f'☐ {n}. {desc}']) + '\n')
tmp.replace(f)
print(f'added #{n}')
"
```

Reply: `Task added: ☐ <n>. <description>`

## On `/task list`

```bash
python3 -c "
import pathlib, os
f = pathlib.Path(os.path.expanduser('~/.openclaw/tasks.md'))
if not f.exists():
    print('NO_TASKS')
else:
    print(f.read_text())
"
```

Format reply as the raw task list (preserve ☐/☑ markers). If empty: `No open tasks.`

## On `/task done <n>`

Mark task n complete:

```bash
BODHI_TASK_N='<n>' python3 -c "
import pathlib, os
n_str = os.environ.get('BODHI_TASK_N', '').strip()
if not n_str.isdigit():
    print('INVALID_ARG')
    exit()
n = int(n_str)
f = pathlib.Path(os.path.expanduser('~/.openclaw/tasks.md'))
if not f.exists():
    print('NO_FILE')
    exit()
lines = f.read_text().splitlines()
updated = []
found = False
for l in lines:
    if l.startswith(f'☐ {n}.'):
        updated.append(l.replace('☐', '☑', 1))
        found = True
    else:
        updated.append(l)
tmp = f.with_suffix('.tmp')
tmp.write_text('\n'.join(updated) + '\n')
tmp.replace(f)
print('done' if found else 'NOT_FOUND')
"
```

Reply: `Task <n> marked done. ☑`

## On `/memory show`

```bash
python3 -c "
import pathlib, os
f = pathlib.Path(os.path.expanduser('~/.openclaw/pm-memory.md'))
if not f.exists():
    print('NO_MEMORY')
else:
    lines = f.read_text().splitlines()
    print('\n'.join(lines[-50:]))
"
```

Reply: last 50 lines of `pm-memory.md`. If empty: `No memory saved yet.`

## On `/memory save <key> <value>`

```bash
BODHI_KEY='<key>' BODHI_VAL='<value>' python3 -c "
import pathlib, os
key = os.environ.get('BODHI_KEY', '').strip()
val = os.environ.get('BODHI_VAL', '').strip()
if not key or not val:
    print('INVALID_ARG')
    exit()
f = pathlib.Path(os.path.expanduser('~/.openclaw/pm-memory.md'))
existing = f.read_text() if f.exists() else ''
entry = f'**{key}**: {val}'
tmp = f.with_suffix('.tmp')
tmp.write_text(existing.rstrip() + '\n' + entry + '\n')
tmp.replace(f)
print('saved')
"
```

Reply: `Memory saved: **<key>**: <value>`

## On `/pm off`

Reply:

```
Project Manager — OFF. Back to wellness curator mode.
```

No file changes needed.

## On `/usage`

Delegate to bodhi-budget skill: read `~/.openclaw/budget-state.json` and format the usage bar chart. Same output as `/usage` in that skill.

## Rules

- Run bash commands, then reply with the result. Nothing else.
- Never expose file paths or tokens in replies.
- If command outputs `INVALID_ARG`: reply with the correct usage (e.g. `/task done <number>` or `/memory save <key> <value>`).
- If any other command fails: `Command failed — check server logs.`
- `/model opus` always requires confirmation before switching.
- `/effort high` always shows cost warning in the reply.
- Config changes hot-reload within ~3 seconds — no restart needed.
