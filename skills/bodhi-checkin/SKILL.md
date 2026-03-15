---
name: bodhi-checkin
description: Morning and evening ritual — grounds the day, surfaces intentions, reviews energy. Calm daily anchor.
user-invocable: true
disable-model-invocation: false
triggers:
  - /checkin
  - /morning
  - /evening
---

# bodhi-checkin

The daily ritual layer. Two anchors per day: morning sets intention, evening closes the loop. Neither is journaling. Neither is therapy. Both are a minute of honest looking — at what you're bringing into the day and what you're carrying out of it.

This is calm technology at its most basic. Ask little. Receive honestly. Write to vault. Get out of the way.

## On `/morning` or `/checkin morning`

Read today's task list and any calendar events first:

```bash
python3 -c "
import json, pathlib, os
from datetime import datetime, date

tasks_path = pathlib.Path(os.path.expanduser('~/.openclaw/tasks-life.json'))
tasks = json.loads(tasks_path.read_text()) if tasks_path.exists() else {'tasks': []}

today = date.today().isoformat()
due_today = [t for t in tasks.get('tasks', []) if t.get('status') == 'open' and t.get('due', '') <= today]
overdue = [t for t in tasks.get('tasks', []) if t.get('status') == 'open' and t.get('due', '') < today]
all_open = [t for t in tasks.get('tasks', []) if t.get('status') == 'open']

print(f'DUE_TODAY:{len(due_today)}')
print(f'OVERDUE:{len(overdue)}')
print(f'OPEN:{len(all_open)}')
for t in due_today[:3]:
    print(f'TASK:{t[\"id\"]}:{t[\"text\"]}')
"
```

Then reply with the morning ritual message. Format:

```
Good morning.

Energy: [1-5, where 1 = depleted, 5 = charged]?

What's one thing you want to carry forward today?
```

If there are due tasks or overdue items, add at the end:
```
[N tasks due today. [N overdue.]]
```

Do not list all tasks. Just the count. The intention question is the center.

### After they respond:

1. Parse energy level (number or descriptive language → infer 1-5 scale)
2. Write vault node:

```bash
python3 -c "
import json, pathlib, os, uuid, hashlib, tempfile
from datetime import datetime

vault_dir = pathlib.Path(os.path.expanduser('~/.openclaw/vault'))
vault_dir.mkdir(parents=True, exist_ok=True)
schema_path = pathlib.Path(os.path.expanduser('~/.openclaw/vault')).parent / 'schema' / 'nodes.json'

content = os.environ.get('CHECKIN_CONTENT', '')
energy = int(os.environ.get('CHECKIN_ENERGY', '3'))
intention = os.environ.get('CHECKIN_INTENTION', '')

full_content = f'Morning check-in. Energy: {energy}. Intention: {intention}'
node = {
    'id': str(uuid.uuid4()),
    'content': full_content,
    'domain': 'wellness',
    'energy': energy,
    'tags': ['check-in', 'morning', 'intention'],
    'media_type': 'text',
    'created_at': datetime.now().isoformat(),
    'sha256': hashlib.sha256(full_content.encode()).hexdigest()
}
node_path = vault_dir / f\"{node['id']}.json\"
tmp = tempfile.NamedTemporaryFile(mode='w', dir=vault_dir, suffix='.tmp', delete=False)
json.dump(node, tmp)
tmp.close()
os.replace(tmp.name, str(node_path))
print(f'wrote:{node[\"id\"]}')
" 2>&1
```

3. Reply: acknowledge energy level, reflect back the intention in one short sentence, say nothing more.

**Examples by energy level:**
- Energy 1-2: "Noted. Rest is doing something. Let the intention sit lightly today."
- Energy 3: "A solid base. [Intention] is a clear thread — follow it when you can."
- Energy 4-5: "Good charge. [Intention] has traction today."

No coaching. No "have you tried." One sentence, then done.

### State file for check-in streak:

```bash
python3 -c "
import json, pathlib, os, tempfile
from datetime import datetime, date, timedelta

state_path = pathlib.Path(os.path.expanduser('~/.openclaw/checkin-state.json'))
state = json.loads(state_path.read_text()) if state_path.exists() else {
    'morning_streak': 0, 'evening_streak': 0,
    'last_morning': None, 'last_evening': None
}

today = date.today().isoformat()
yesterday = (date.today() - timedelta(days=1)).isoformat()

last = state.get('last_morning')
if last == yesterday:
    state['morning_streak'] = state.get('morning_streak', 0) + 1
elif last != today:
    state['morning_streak'] = 1

state['last_morning'] = today

tmp = tempfile.NamedTemporaryFile(mode='w', dir=state_path.parent, suffix='.tmp', delete=False)
json.dump(state, tmp)
tmp.close()
os.replace(tmp.name, str(state_path))
print(f'streak:{state[\"morning_streak\"]}')
"
```

If streak >= 7: add a quiet note. Not celebration. Just acknowledgment. "7 mornings in a row."

---

## On `/evening` or `/checkin evening`

Read today's completed and remaining tasks:

```bash
python3 -c "
import json, pathlib, os
from datetime import date

tasks_path = pathlib.Path(os.path.expanduser('~/.openclaw/tasks-life.json'))
tasks = json.loads(tasks_path.read_text()) if tasks_path.exists() else {'tasks': []}

today = date.today().isoformat()
done_today = [t for t in tasks.get('tasks', []) if t.get('status') == 'done' and t.get('completed_at', '').startswith(today)]
still_open = [t for t in tasks.get('tasks', []) if t.get('status') == 'open']

print(f'DONE_TODAY:{len(done_today)}')
print(f'STILL_OPEN:{len(still_open)}')
"
```

Reply with the evening ritual message:

```
Evening.

How did today land?

One word, a sentence, or a number — however it comes.
```

If tasks were completed today: add "You closed [N] things today." (no list, just count).
If things remain open: say nothing. Let them rest.

### After they respond:

1. Infer energy from language (do NOT ask them to rate it again)
2. Write vault node to domain `wellness`, tags `['check-in', 'evening', 'reflection']`
3. Check for accountability commitments due today (call accountability state):

```bash
python3 -c "
import json, pathlib, os
from datetime import date

acc_path = pathlib.Path(os.path.expanduser('~/.openclaw/accountability.json'))
state = json.loads(acc_path.read_text()) if acc_path.exists() else {'commitments': []}

today = date.today().isoformat()
due = [c for c in state.get('commitments', []) if c.get('next_check') == today and c.get('status') == 'active']

for c in due[:2]:
    print(f'COMMITMENT:{c[\"id\"]}:{c[\"text\"]}')
if not due:
    print('NONE')
"
```

If there are commitments due today: gently surface ONE. "You said you'd [commitment]. Did that happen?"
Do not ask about multiple commitments in one evening message. One at a time.

4. Update evening streak (same pattern as morning).

5. Reply: one reflective sentence based on what they said. Then done.

---

## On `/checkin status`

Show check-in streak and last entry:

```bash
python3 -c "
import json, pathlib, os
from datetime import datetime, date, timedelta

state_path = pathlib.Path(os.path.expanduser('~/.openclaw/checkin-state.json'))
state = json.loads(state_path.read_text()) if state_path.exists() else {}

morning_streak = state.get('morning_streak', 0)
evening_streak = state.get('evening_streak', 0)
last_morning = state.get('last_morning', 'never')
last_evening = state.get('last_evening', 'never')

print(f'Morning streak: {morning_streak} days (last: {last_morning})')
print(f'Evening streak: {evening_streak} days (last: {last_evening})')
"
```

---

## On `/checkin setup`

Create persistent morning and evening check-in reminders. Uses the framework's cron tool to schedule recurring jobs.

Call CronCreate twice:

**Morning (8:07 AM daily):**
- cron: `7 8 * * *`
- prompt: `Send the morning check-in ritual. Run /morning`
- recurring: true

**Evening (9:03 PM daily):**
- cron: `3 21 * * *`
- prompt: `Send the evening check-in ritual. Run /evening`
- recurring: true

After creating both jobs, confirm:
```
Morning check-in: daily at 8:07 AM
Evening check-in: daily at 9:03 PM

Both active. Use /checkin status to see streaks. /checkin setup again to reset.
```

Note: Recurring cron jobs auto-expire after 3 days. Run `/checkin setup` again to renew them.

---

## Rules

- NEVER ask more than one question per check-in message. One in. One out.
- Energy inference from language: words like "tired", "drained", "rough" → 2. "okay", "fine", "alright" → 3. "good", "solid", "clear" → 4. "great", "charged", "ready" → 5.
- Never use the word "journaling" or "reflection" in output.
- Morning = set direction. Evening = close loop. Not therapy. Not journaling.
- Streaks are private. Only shown when asked. Never volunteered unless >= 7.
- If they don't respond to the ritual message, it expires silently. No follow-up.
- All state files use atomic writes (tempfile + os.replace).
- Vault writes use `domain: wellness`, never change this.
