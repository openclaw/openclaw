---
name: bodhi-accountability
description: Commitment tracking and gentle follow-up — you said you'd do it. Bo remembers. No judgment. Just the mirror.
user-invocable: true
disable-model-invocation: false
triggers:
  - /commit
  - /accountability
  - /streak
  - /commitments
---

# bodhi-accountability

The commitment layer. Not nagging. Not coaching. Not a to-do list.

When you say "I want to do this," Bo holds it. When the moment comes, Bo asks. That's all. You decide what it means. Bo just makes sure you don't drift past it unaware.

The difference between a task and a commitment: a task is something you want done. A commitment is a direction you're pointing your life.

State file: `~/.openclaw/accountability.json`

Schema:
```json
{
  "commitments": [
    {
      "id": "abc123",
      "text": "30 minutes of walking every morning",
      "type": "habit",
      "frequency": "daily",
      "status": "active",
      "streak": 0,
      "best_streak": 0,
      "created_at": "2026-03-15T09:00:00",
      "last_checked": null,
      "next_check": "2026-03-16",
      "check_history": [],
      "domain": "fitness"
    }
  ]
}
```

Commitment types:
- `habit` — recurring (daily, weekly, M/W/F etc.)
- `one-time` — do it once by a date
- `project` — ongoing direction, no specific date

---

## On `/commit [text]`

Record a commitment. Parse frequency from natural language:

```bash
python3 -c "
import json, pathlib, os, tempfile, uuid, sys, re
from datetime import datetime, date, timedelta

text = ' '.join(sys.argv[1:])
if not text:
    print('Usage: /commit <description>')
    exit()

text = text[:300]

# Infer frequency
freq = 'daily'
commitment_type = 'habit'
days_ahead = 1

lower = text.lower()
if any(w in lower for w in ['every day', 'daily', 'each morning', 'each evening', 'every morning', 'every evening']):
    freq = 'daily'
    commitment_type = 'habit'
elif re.search(r'every (monday|tuesday|wednesday|thursday|friday|saturday|sunday)', lower):
    freq = 'weekly'
    commitment_type = 'habit'
    days_ahead = 7
elif any(w in lower for w in ['weekly', 'each week', 'every week']):
    freq = 'weekly'
    commitment_type = 'habit'
    days_ahead = 7
elif any(w in lower for w in ['once', 'by ', 'this week', 'this month', 'one time']):
    freq = 'once'
    commitment_type = 'one-time'
    days_ahead = 1
else:
    # Default: treat as habit
    freq = 'daily'
    commitment_type = 'habit'

# Infer domain from text
domain = 'wellness'
fitness_words = ['walk', 'run', 'gym', 'workout', 'exercise', 'training', 'lift', 'swim', 'bike', 'yoga']
health_words = ['eat', 'nutrition', 'diet', 'sleep', 'drink water', 'meds', 'medication', 'doctor', 'supplement']
cognitive_words = ['read', 'study', 'learn', 'practice', 'skill', 'write', 'code', 'book']
mental_words = ['meditate', 'meditation', 'journal', 'therapy', 'breathe', 'mindful']

if any(w in lower for w in fitness_words): domain = 'fitness'
elif any(w in lower for w in health_words): domain = 'health'
elif any(w in lower for w in cognitive_words): domain = 'cognitive'
elif any(w in lower for w in mental_words): domain = 'mental-health'

next_check = (date.today() + timedelta(days=days_ahead)).isoformat()

acc_path = pathlib.Path(os.path.expanduser('~/.openclaw/accountability.json'))
data = json.loads(acc_path.read_text()) if acc_path.exists() else {'commitments': []}

commitment = {
    'id': str(uuid.uuid4())[:8],
    'text': text,
    'type': commitment_type,
    'frequency': freq,
    'status': 'active',
    'streak': 0,
    'best_streak': 0,
    'created_at': datetime.now().isoformat(),
    'last_checked': None,
    'next_check': next_check,
    'check_history': [],
    'domain': domain
}
data['commitments'].append(commitment)

tmp = tempfile.NamedTemporaryFile(mode='w', dir=acc_path.parent, suffix='.tmp', delete=False)
json.dump(data, tmp)
tmp.close()
os.replace(tmp.name, str(acc_path))
print(f'committed:{commitment[\"id\"]}:{commitment_type}:{freq}:{domain}')
print(f'next_check:{next_check}')
" <text>
```

Reply: Acknowledge the commitment without hype. One sentence. Domain + frequency noted.

**Examples:**
- Daily fitness habit: "Held. I'll check back tomorrow."
- Weekly: "Held. I'll ask about this next week."
- One-time: "Held. I'll ask when the time comes."

Never say "great commitment" or "awesome." Just hold it.

---

## On `/commitments` or `/accountability`

Show all active commitments:

```bash
python3 -c "
import json, pathlib, os
from datetime import date

acc_path = pathlib.Path(os.path.expanduser('~/.openclaw/accountability.json'))
data = json.loads(acc_path.read_text()) if acc_path.exists() else {'commitments': []}

active = [c for c in data.get('commitments', []) if c.get('status') == 'active']
today = date.today().isoformat()

for c in active:
    streak = c.get('streak', 0)
    best = c.get('best_streak', 0)
    next_check = c.get('next_check', '')
    overdue = next_check < today if next_check else False
    print(f'{c[\"id\"]}|{c[\"text\"][:60]}|{streak}|{best}|{c[\"frequency\"]}|{\"OVERDUE\" if overdue else next_check}')

if not active:
    print('EMPTY')
"
```

Format as:

```
Active commitments (N)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
[id] [text] · [freq] · streak: N days
     (best: N) [⚠ overdue if applicable]
```

---

## On `/streak [text or id]`

Show streak for a specific commitment:

```bash
python3 -c "
import json, pathlib, os, sys

query = ' '.join(sys.argv[1:]).lower() if len(sys.argv) > 1 else ''
acc_path = pathlib.Path(os.path.expanduser('~/.openclaw/accountability.json'))
data = json.loads(acc_path.read_text()) if acc_path.exists() else {'commitments': []}

found = None
for c in data.get('commitments', []):
    if c['id'] == query or query in c['text'].lower():
        found = c
        break

if found:
    print(f'FOUND:{found[\"id\"]}:{found[\"text\"]}:{found[\"streak\"]}:{found[\"best_streak\"]}:{found[\"status\"]}')
else:
    print('NOT_FOUND')
" <query>
```

Format: `[Commitment text]: [N]-day streak (best: [N])`

---

## On `/commit check [id]` — marking a commitment done for today

```bash
python3 -c "
import json, pathlib, os, tempfile, sys
from datetime import datetime, date, timedelta

task_id = sys.argv[1] if len(sys.argv) > 1 else ''
if not task_id:
    print('Usage: /commit check <id>')
    exit()

acc_path = pathlib.Path(os.path.expanduser('~/.openclaw/accountability.json'))
data = json.loads(acc_path.read_text()) if acc_path.exists() else {'commitments': []}

today = date.today().isoformat()
found = None
for c in data['commitments']:
    if c['id'] == task_id:
        found = c
        break

if not found:
    print(f'NOT_FOUND:{task_id}')
    exit()

# Update streak
last = found.get('last_checked')
yesterday = (date.today() - timedelta(days=1)).isoformat()

if last == yesterday or last is None:
    found['streak'] = found.get('streak', 0) + 1
elif last == today:
    print(f'ALREADY_CHECKED:{found[\"text\"]}')
    exit()
else:
    # Gap — reset streak
    found['streak'] = 1

found['best_streak'] = max(found.get('best_streak', 0), found['streak'])
found['last_checked'] = today

# Set next check based on frequency
freq = found.get('frequency', 'daily')
days_ahead = 1 if freq == 'daily' else 7
if freq == 'once':
    found['status'] = 'completed'
    found['next_check'] = None
else:
    found['next_check'] = (date.today() + timedelta(days=days_ahead)).isoformat()

found['check_history'].append({'date': today, 'kept': True})
if len(found['check_history']) > 90:
    found['check_history'] = found['check_history'][-90:]

tmp = tempfile.NamedTemporaryFile(mode='w', dir=acc_path.parent, suffix='.tmp', delete=False)
json.dump(data, tmp)
tmp.close()
os.replace(tmp.name, str(acc_path))
print(f'CHECKED:{found[\"text\"]}:{found[\"streak\"]}:{found[\"best_streak\"]}')
" <id>
```

Reply by streak milestone:
- Streak 1: `[Commitment]. Logged.`
- Streak 3: `3 days. The thread is forming.`
- Streak 7: `7 days. That's a week.`
- Streak 14: `14 days. Pattern territory.`
- Streak 30: `30 days. This is now part of you.`
- Other: `[N] days in a row.`

Never say "great job" or "awesome streak." Just the count and one quiet observation.

---

## On `/commit miss [id]`

Acknowledge a missed day without shaming:

```bash
python3 -c "
import json, pathlib, os, tempfile, sys
from datetime import datetime, date, timedelta

task_id = sys.argv[1] if len(sys.argv) > 1 else ''
acc_path = pathlib.Path(os.path.expanduser('~/.openclaw/accountability.json'))
data = json.loads(acc_path.read_text()) if acc_path.exists() else {'commitments': []}

today = date.today().isoformat()
for c in data['commitments']:
    if c['id'] == task_id:
        prev_streak = c.get('streak', 0)
        c['streak'] = 0
        c['check_history'].append({'date': today, 'kept': False})
        if len(c['check_history']) > 90:
            c['check_history'] = c['check_history'][-90:]
        freq = c.get('frequency', 'daily')
        days_ahead = 1 if freq == 'daily' else 7
        c['next_check'] = (date.today() + timedelta(days=days_ahead)).isoformat()
        print(f'MISSED:{c[\"text\"]}:was_{prev_streak}')
        break

tmp = tempfile.NamedTemporaryFile(mode='w', dir=acc_path.parent, suffix='.tmp', delete=False)
json.dump(data, tmp)
tmp.close()
os.replace(tmp.name, str(acc_path))
" <id>
```

Reply: `Noted. Tomorrow is a clean start.` — nothing more.
Never say "it's okay" or "don't worry." Just acknowledge and reset.

---

## On `/commit pause [id]`

Pause a commitment without ending it:

Sets `status: "paused"` and clears `next_check`. Will not appear in evening check-ins.
Reply: `Paused. When you're ready: /commit resume [id]`

---

## On `/commit drop [id]`

End a commitment:

Sets `status: "dropped"`. Archives check history. Removes from active view.
Reply: `Dropped. [Commitment text] — [streak] days tracked.`

---

## Integration with bodhi-checkin evening

When `/evening` runs, it calls this check:

```bash
python3 -c "
import json, pathlib, os
from datetime import date

acc_path = pathlib.Path(os.path.expanduser('~/.openclaw/accountability.json'))
data = json.loads(acc_path.read_text()) if acc_path.exists() else {'commitments': []}

today = date.today().isoformat()
due = [c for c in data.get('commitments', [])
       if c.get('status') == 'active' and c.get('next_check') == today]

for c in due[:1]:  # ONE at a time
    print(f'DUE:{c[\"id\"]}:{c[\"text\"]}:{c[\"streak\"]}')
if not due:
    print('NONE')
"
```

Surface ONE commitment in the evening message. Phrased as a quiet question:
- `You said you'd [commitment]. Did that happen?`

User responds yes/no → call `/commit check [id]` or `/commit miss [id]` accordingly.

---

## Vault Integration

After 7 consecutive days on any habit commitment, write a vault node:

```bash
cd ~/openbodhi && python3 -m bodhi_vault.write_cli \
  "7-day streak on commitment: ${COMMITMENT_TEXT}. Streak: ${COMMITMENT_STREAK} days." \
  --type Pattern \
  --energy 4 \
  --source telegram \
  --tags "accountability,streak,habit,streak-${COMMITMENT_STREAK}" \
  --domain "${COMMITMENT_DOMAIN}" \
  --vault ~/openbodhi/vault \
  --schema ~/openbodhi/vault/schema/nodes.json 2>&1
```

This makes sustained habits visible to Bo's nudge system — the pattern becomes part of the criticality graph.

---

## Rules

- ONE commitment surfaced per evening check-in. Never two.
- Never says "you should" or "you need to." Hold the mirror, don't coach.
- Streak reset is honest. A miss is a miss. No "partial credit."
- Pausing is not failing. Let them pause without judgment.
- Vault writes happen at 7-day milestones and when a commitment is completed.
- check_history capped at 90 entries per commitment to keep state file manageable.
- All state files use atomic writes (tempfile + os.replace).
- "Done." is a complete response when appropriate.
