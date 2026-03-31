---
name: bodhi-tasks
description: Life task management — quick capture, today view, done marking. Not project management. Real life.
user-invocable: true
disable-model-invocation: false
triggers:
  - /task
  - /tasks
  - /todo
---

# bodhi-tasks

The life task layer. Not sprints. Not epics. The things that actually run your life: call the doctor, fix the dryer, pay the bill, pick up the prescription, send the invoice.

bodhi-pm handles project and work tasks. bodhi-tasks handles everything else.

Fast capture. Clean view. Easy done. That's the whole job.

State file: `~/.openclaw/tasks-life.json`

Schema:
```json
{
  "tasks": [
    {
      "id": "abc123",
      "text": "task description",
      "status": "open",
      "priority": "normal",
      "due": "2026-03-16",
      "created_at": "2026-03-15T09:00:00",
      "completed_at": null,
      "tags": []
    }
  ]
}
```

---

## On `/task add [text]` or `/todo [text]`

Quick capture. Minimal friction.

```bash
python3 -c "
import json, pathlib, os, tempfile, uuid, sys
from datetime import datetime

text = ' '.join(sys.argv[1:])
if not text:
    print('Usage: /task add <description>')
    exit()

tasks_path = pathlib.Path(os.path.expanduser('~/.openclaw/tasks-life.json'))
data = json.loads(tasks_path.read_text()) if tasks_path.exists() else {'tasks': []}

task = {
    'id': str(uuid.uuid4())[:8],
    'text': text[:500],
    'status': 'open',
    'priority': 'normal',
    'due': None,
    'created_at': datetime.now().isoformat(),
    'completed_at': None,
    'tags': []
}
data['tasks'].append(task)

tmp = tempfile.NamedTemporaryFile(mode='w', dir=tasks_path.parent, suffix='.tmp', delete=False)
json.dump(data, tmp)
tmp.close()
os.replace(tmp.name, str(tasks_path))
print(f'added:{task[\"id\"]}:{task[\"text\"]}')
" <text>
```

Reply: `Added: [task text]` — nothing more. Speed is the feature.

### Smart parsing from natural language:

If text contains due date signals, extract them before writing:
- "by Friday" → set due to next Friday
- "tomorrow" → set due to tomorrow's date
- "today" → set due to today
- "this week" → set due to Sunday

```bash
python3 -c "
import sys, re
from datetime import date, timedelta

text = ' '.join(sys.argv[1:])
today = date.today()

due = None
patterns = [
    (r'\btoday\b', today),
    (r'\btomorrow\b', today + timedelta(days=1)),
    (r'\bthis week\b', today + timedelta(days=(6 - today.weekday()))),
    (r'\bnext week\b', today + timedelta(weeks=1)),
    (r'\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b',
     None),  # handled below
]

days = {'monday':0,'tuesday':1,'wednesday':2,'thursday':3,'friday':4,'saturday':5,'sunday':6}
m = re.search(r'\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b', text.lower())
if m:
    target = days[m.group(1)]
    current = today.weekday()
    days_ahead = (target - current) % 7 or 7
    due = today + timedelta(days=days_ahead)
else:
    for pattern, d in patterns[:4]:
        if re.search(pattern, text.lower()):
            due = d
            break

print(due.isoformat() if due else 'NONE')
" <text>
```

---

## On `/tasks` or `/task list`

Show open tasks. Group by overdue/today/upcoming:

```bash
python3 -c "
import json, pathlib, os
from datetime import date

tasks_path = pathlib.Path(os.path.expanduser('~/.openclaw/tasks-life.json'))
data = json.loads(tasks_path.read_text()) if tasks_path.exists() else {'tasks': []}

today = date.today().isoformat()
open_tasks = [t for t in data.get('tasks', []) if t.get('status') == 'open']

overdue = [t for t in open_tasks if t.get('due') and t['due'] < today]
due_today = [t for t in open_tasks if t.get('due') == today]
upcoming = [t for t in open_tasks if t.get('due') and t['due'] > today]
no_due = [t for t in open_tasks if not t.get('due')]

print(f'OVERDUE:{len(overdue)}')
print(f'TODAY:{len(due_today)}')
print(f'UPCOMING:{len(upcoming)}')
print(f'NODUEDATE:{len(no_due)}')

for t in overdue:
    print(f'O:{t[\"id\"]}:{t[\"due\"]}:{t[\"text\"]}')
for t in due_today:
    print(f'T:{t[\"id\"]}:{t[\"text\"]}')
for t in upcoming[:3]:
    print(f'U:{t[\"id\"]}:{t[\"due\"]}:{t[\"text\"]}')
for t in no_due[:5]:
    print(f'N:{t[\"id\"]}:{t[\"text\"]}')
"
```

Format as:

```
Tasks
━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠ Overdue (N)
  [id] task text (was due YYYY-MM-DD)

Today (N)
  [id] task text

Upcoming (N)
  [id] task text · due YYYY-MM-DD

No date (N)
  [id] task text
```

Only show `[id]` prefix if there are items to act on (so user can use /task done [id]).

---

## On `/task done [id]`

Mark a task complete:

```bash
python3 -c "
import json, pathlib, os, tempfile, sys
from datetime import datetime

import re
task_id = sys.argv[1] if len(sys.argv) > 1 else ''
if not task_id or not re.match(r'^[a-f0-9]{8}$', task_id):
    print('Usage: /task done <id>')
    exit()

tasks_path = pathlib.Path(os.path.expanduser('~/.openclaw/tasks-life.json'))
data = json.loads(tasks_path.read_text()) if tasks_path.exists() else {'tasks': []}

found = False
for t in data['tasks']:
    if t['id'] == task_id:
        t['status'] = 'done'
        t['completed_at'] = datetime.now().isoformat()
        found = True
        print(f'done:{t[\"text\"]}')
        break

if not found:
    print(f'not_found:{task_id}')
    exit()

tmp = tempfile.NamedTemporaryFile(mode='w', dir=tasks_path.parent, suffix='.tmp', delete=False)
json.dump(data, tmp)
tmp.close()
os.replace(tmp.name, str(tasks_path))
" <id>
```

Reply: `Done: [task text]`

---

## On `/task snooze [id]` or `/task snooze [id] [date]`

Push to tomorrow (or a specified date):

```bash
python3 -c "
import json, pathlib, os, tempfile, sys, re
from datetime import datetime, date, timedelta

import re
args = sys.argv[1:]
if not args:
    print('Usage: /task snooze <id> [date]')
    exit()

task_id = args[0]
if not re.match(r'^[a-f0-9]{8}$', task_id):
    print('Invalid task ID')
    exit()
# Parse optional date
new_due = None
if len(args) > 1:
    date_str = args[1]
    if re.match(r'\d{4}-\d{2}-\d{2}', date_str):
        new_due = date_str
    elif date_str == 'tomorrow':
        new_due = (date.today() + timedelta(days=1)).isoformat()
    elif date_str == 'next-week':
        new_due = (date.today() + timedelta(weeks=1)).isoformat()

if not new_due:
    new_due = (date.today() + timedelta(days=1)).isoformat()

tasks_path = pathlib.Path(os.path.expanduser('~/.openclaw/tasks-life.json'))
data = json.loads(tasks_path.read_text()) if tasks_path.exists() else {'tasks': []}

found = False
for t in data['tasks']:
    if t['id'] == task_id:
        t['due'] = new_due
        found = True
        print(f'snoozed:{t[\"text\"]}:{new_due}')
        break

if not found:
    print(f'not_found:{task_id}')
    exit()

tmp = tempfile.NamedTemporaryFile(mode='w', dir=tasks_path.parent, suffix='.tmp', delete=False)
json.dump(data, tmp)
tmp.close()
os.replace(tmp.name, str(tasks_path))
" <id> [date]
```

Reply: `Snoozed to [date]: [task text]`

---

## On `/task clear` or `/task clean`

Remove all completed tasks (archive):

```bash
python3 -c "
import json, pathlib, os, tempfile
from datetime import datetime

tasks_path = pathlib.Path(os.path.expanduser('~/.openclaw/tasks-life.json'))
data = json.loads(tasks_path.read_text()) if tasks_path.exists() else {'tasks': []}

done = [t for t in data['tasks'] if t['status'] == 'done']
open_tasks = [t for t in data['tasks'] if t['status'] == 'open']

# Archive done tasks
archive_path = tasks_path.parent / 'tasks-life-archive.json'
archive = json.loads(archive_path.read_text()) if archive_path.exists() else {'tasks': []}
archive['tasks'].extend(done)

tmp = tempfile.NamedTemporaryFile(mode='w', dir=archive_path.parent, suffix='.tmp', delete=False)
json.dump(archive, tmp)
tmp.close()
os.replace(tmp.name, str(archive_path))

data['tasks'] = open_tasks
tmp2 = tempfile.NamedTemporaryFile(mode='w', dir=tasks_path.parent, suffix='.tmp', delete=False)
json.dump(data, tmp2)
tmp2.close()
os.replace(tmp2.name, str(tasks_path))

print(f'cleared:{len(done)}')
"
```

Reply: `Cleared [N] completed tasks.`

---

## On `/task priority [id] [high|normal|low]`

Change priority:

```bash
python3 -c "
import json, pathlib, os, tempfile, sys

import re
args = sys.argv[1:]
if len(args) < 2:
    print('Usage: /task priority <id> <high|normal|low>')
    exit()

task_id, priority = args[0], args[1]
if not re.match(r'^[a-f0-9]{8}$', task_id):
    print('Invalid task ID')
    exit()
if priority not in ('high', 'normal', 'low'):
    print('Priority must be high, normal, or low')
    exit()

tasks_path = pathlib.Path(os.path.expanduser('~/.openclaw/tasks-life.json'))
data = json.loads(tasks_path.read_text()) if tasks_path.exists() else {'tasks': []}

for t in data['tasks']:
    if t['id'] == task_id:
        t['priority'] = priority
        print(f'updated:{t[\"text\"]}:{priority}')
        break

tmp = tempfile.NamedTemporaryFile(mode='w', dir=tasks_path.parent, suffix='.tmp', delete=False)
json.dump(data, tmp)
tmp.close()
os.replace(tmp.name, str(tasks_path))
" <id> <priority>
```

---

## Rules

- `/todo [text]` is identical to `/task add [text]`. Both work.
- IDs are 8-char UUID prefixes. Short enough to type, unique enough to not collide.
- No project tags, no sprint labels, no story points. That is bodhi-pm territory.
- Done tasks are never deleted — archived to `tasks-life-archive.json`.
- bodhi-pm (`~/.openclaw/tasks.md`) is separate. Never read or write that file from this skill.
- Natural language date parsing is best-effort. When uncertain, omit due date and let user add it with `/task snooze`.
- All state files use atomic writes (tempfile + os.replace).
- No emojis in task text unless the user included them.
- "Done." is a complete response when appropriate.
