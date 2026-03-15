---
name: bodhi-nudge
description: SOC-based nudge system — surfaces one question when a wellness cluster reaches criticality. Calm technology.
user-invocable: true
disable-model-invocation: false
triggers:
  - /nudge
  - /patterns
---

# bodhi-nudge

The nudge system is Bo's core innovation. It watches what you return to, measures the energy of attention clusters, and surfaces one question when something is ready to be seen.

This is not a notification system. This is calm technology. Ambient by default. Interruptive only at threshold. Never blocks current focus.

## Science Foundation

Full reference: `docs/bodhi/soc-wellness-science.md`

- **Self-Organized Criticality** (Bak 1987; Beggs & Plenz 2003): Systems at criticality produce power-law cascades. Bo tracks revisitation frequency as energy. When energy crosses threshold, the cluster is critical — one question tips the slope.
- **Spaced Repetition** (Ebbinghaus 1885): Memory decays on a curve. Expanding intervals (3→7→14→30 days) convert fragile observations into durable understanding. This IS the JITAI timing layer.
- **Calm Technology** (Weiser 1991): Ambient by default. Periphery to center to periphery. Never interrupts current focus except at threshold.
- **JITAI** (Just-in-Time Adaptive Interventions, PMC 2017/2025): Intervene at "state of opportunity" — after sedentary streaks, before known stress windows, after missed practices. The state, not the clock, determines when.
- **Coupled Critical Systems** (SOC wellness stack): Wellness is nested critical systems (neural, HPA-axis, habit networks, social, health services). Each vault node is a vector across all layers. Cross-domain bridges (Surveyor output) signal when two systems are coupling — highest-value nudge target.

**Sandpile rules Bo follows:**
- Energy 1-2 consistently → do NOT add challenge. Short recovery message only. Don't add grains when slope is too steep.
- Energy 4-5 + cluster ripe → full-depth question. System at peak receptivity.
- Cross-domain bridge → surface immediately. Two systems coupling = the highest-leverage moment.
- 3+ missed practices → downgrade difficulty, shorter ask.

## On `/nudge`

Check for ripe clusters and surface one question:

```bash
python3 -c "
import json, pathlib, os, glob
from datetime import datetime, timedelta

vault_dir = pathlib.Path(os.path.expanduser('~/.openclaw/vault'))
nudge_state = pathlib.Path(os.path.expanduser('~/.openclaw/nudge-state.json'))

# Load nudge state (dismissed clusters, cooldowns)
state = json.loads(nudge_state.read_text()) if nudge_state.exists() else {'dismissed': {}, 'last_nudge': None}

# Scan vault nodes for domain frequency
nodes = []
for f in sorted(vault_dir.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True):
    try:
        nodes.append(json.loads(f.read_text()))
    except:
        pass

if not nodes:
    print('NO_NODES')
    exit()

# Count domain frequency in last 14 days
cutoff = (datetime.now() - timedelta(days=14)).isoformat()
recent = [n for n in nodes if n.get('created_at', '') > cutoff]
domains = {}
for n in recent:
    d = n.get('domain', 'unknown')
    domains[d] = domains.get(d, 0) + 1

# Find most revisited domain
if domains:
    top = max(domains, key=domains.get)
    count = domains[top]
    # Check if dismissed recently
    dismissed_until = state['dismissed'].get(top, '')
    if dismissed_until and dismissed_until > datetime.now().isoformat():
        print(f'COOLDOWN:{top}:{count}')
    else:
        print(f'RIPE:{top}:{count}')
else:
    print('NO_PATTERNS')
"
```

If `RIPE:<domain>:<count>`:

Surface ONE question related to that domain. Not advice. Not coaching. A mirror.

Example questions by domain:
- **wellness**: "You have returned to rest and recovery {count} times in two weeks. What is that pattern telling you?"
- **fitness**: "Movement has been on your mind. {count} observations. Is there something your body is asking for?"
- **health**: "Nutrition keeps surfacing. {count} entries. What would change if you trusted what you already know about this?"
- **mental-health**: "You have been sitting with something emotional. {count} touches in two weeks. Does it have a shape yet?"
- **cognitive**: "Your attention keeps circling back to learning and focus. {count} times. What is the thought that has not fully formed?"

After surfacing, update nudge state:

```bash
python3 -c "
import json, pathlib, os
from datetime import datetime, timedelta
state_path = pathlib.Path(os.path.expanduser('~/.openclaw/nudge-state.json'))
state = json.loads(state_path.read_text()) if state_path.exists() else {'dismissed': {}, 'last_nudge': None}
state['last_nudge'] = datetime.now().isoformat()
import tempfile
tmp = tempfile.NamedTemporaryFile(mode='w', dir=state_path.parent, suffix='.tmp', delete=False)
json.dump(state, tmp)
tmp.close()
os.replace(tmp.name, str(state_path))
print('logged')
"
```

If `COOLDOWN`: reply "That pattern is on cooldown. It will resurface when the interval expands."

If `NO_PATTERNS`: reply "Nothing ripe yet. Keep observing."

## On `/nudge dismiss`

Dismiss the current nudge. Set cooldown (expanding interval: 3 days, then 7, then 14, then 30):

```bash
python3 -c "
import json, pathlib, os, sys
from datetime import datetime, timedelta
domain = sys.argv[1] if len(sys.argv) > 1 else ''
state_path = pathlib.Path(os.path.expanduser('~/.openclaw/nudge-state.json'))
state = json.loads(state_path.read_text()) if state_path.exists() else {'dismissed': {}, 'intervals': {}}
prev = state.get('intervals', {}).get(domain, 3)
next_days = min(prev * 2, 30)
state['dismissed'][domain] = (datetime.now() + timedelta(days=next_days)).isoformat()
state['intervals'] = state.get('intervals', {})
state['intervals'][domain] = next_days
import tempfile
tmp = tempfile.NamedTemporaryFile(mode='w', dir=state_path.parent, suffix='.tmp', delete=False)
json.dump(state, tmp)
tmp.close()
os.replace(tmp.name, str(state_path))
print(f'dismissed:{next_days}')
" <domain>
```

Reply: "Dismissed. Will resurface in {next_days} days."

## On `/patterns`

Show all domain frequencies without nudging:

```bash
python3 -c "
import json, pathlib, os, glob
from datetime import datetime, timedelta
vault_dir = pathlib.Path(os.path.expanduser('~/.openclaw/vault'))
nodes = []
for f in sorted(vault_dir.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)[:200]:
    try:
        nodes.append(json.loads(f.read_text()))
    except:
        pass
cutoff = (datetime.now() - timedelta(days=14)).isoformat()
recent = [n for n in nodes if n.get('created_at', '') > cutoff]
domains = {}
for n in recent:
    d = n.get('domain', 'unknown')
    domains[d] = domains.get(d, 0) + 1
for d in sorted(domains, key=domains.get, reverse=True):
    print(f'{d}: {domains[d]}')
if not domains:
    print('no data')
"
```

Format as:
```
Patterns (14 days)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
health:        ████████ 8
fitness:       █████ 5
mental-health: ████ 4
wellness:      ██ 2
cognitive:     █ 1
```

## Rules

- ONE question per nudge. Never two. Never a list.
- Never prescriptive. Never "you should." Never "try this."
- Dismissible, reschedulable, mutable. User controls the pace.
- Expanding intervals (Ebbinghaus): 3 → 7 → 14 → 30 days between dismissals.
- Ambient by default. Nudges only fire when explicitly checked (/nudge) or via cron.
- Cross-domain bridges (e.g. fitness+cognitive) are highest priority nudges when detected.
- All state files use atomic writes (tempfile + os.replace).
