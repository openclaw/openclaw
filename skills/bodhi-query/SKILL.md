---
name: bodhi-query
description: Query the vault by keyword, domain, tag, person, or bridge type. Read-only. Fast.
user-invocable: true
disable-model-invocation: false
triggers:
  - /search
  - /people
  - /bridges
  - /stats
  - /find
---

# bodhi-query

The vault query layer. All commands are read-only. They use `read.py` functions to query the filesystem vault. No embedding, no clustering, no writing.

---

## On `/search [query]`

Full-text search across all vault nodes (content + tags).

```bash
python3 -c "
import sys, json, pathlib, os
sys.path.insert(0, os.path.expanduser('~/openbodhi/packages/bodhi_vault/src'))
from bodhi_vault.read import query_nodes
from pathlib import Path

query = ' '.join(sys.argv[1:]).lower() if len(sys.argv) > 1 else ''
if not query:
    print('USAGE: /search <term>')
    sys.exit()

vault = Path.home() / 'openbodhi/vault'
nodes = query_nodes(vault)

hits = []
for n in nodes:
    content = (n.get('content') or '').lower()
    enriched = (n.get('content_enriched') or '').lower()
    tags = ' '.join(n.get('tags', [])).lower()
    if query in content or query in tags or query in enriched:
        hits.append(n)

hits.sort(key=lambda x: x.get('created_at',''), reverse=True)
for h in hits[:8]:
    ts = h.get('created_at','')[:10]
    domain = h.get('domain','?')
    type_ = h.get('type','Idea')
    preview = h.get('content','')[:80].replace('\n',' ')
    print(f'{ts}|{type_}|{domain}|{preview}')

if not hits:
    print('NONE')
" <query>
```

Format results as:

```
Found N matches for "[query]"
━━━━━━━━━━━━━━━━━━━━━━━━━━━
[date] [Type · domain]
[content preview...]

[date] [Type · domain]
[content preview...]
```

Cap at 8 results. Most recent first.

---

## On `/people [name]` or `/people`

Show all nodes mentioning a specific person (or list all unique people if no name given).

```bash
python3 -c "
import sys, json, pathlib, os
sys.path.insert(0, os.path.expanduser('~/openbodhi/packages/bodhi_vault/src'))
from bodhi_vault.read import query_nodes
from pathlib import Path
from collections import Counter

name_query = ' '.join(sys.argv[1:]).lower() if len(sys.argv) > 1 else ''

vault = Path.home() / 'openbodhi/vault'
nodes = query_nodes(vault)

if not name_query:
    # List all unique people
    people = Counter()
    for n in nodes:
        for p in n.get('people', []):
            people[p] += 1
    if not people:
        print('NONE')
    else:
        for person, count in people.most_common(20):
            print(f'{person}|{count}')
else:
    # Find nodes mentioning this person
    hits = []
    for n in nodes:
        for p in n.get('people', []):
            if name_query in p.lower():
                hits.append(n)
                break
    hits.sort(key=lambda x: x.get('created_at',''), reverse=True)
    for h in hits[:10]:
        ts = h.get('created_at','')[:10]
        domain = h.get('domain','?')
        preview = h.get('content','')[:80].replace('\n',' ')
        print(f'{ts}|{domain}|{preview}')
    if not hits:
        print('NONE')
" <name>
```

**Format (no name — list all):**

```
People in vault (N unique)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Dr. Martinez — 8 mentions
coach — 5 mentions
partner — 12 mentions
```

**Format (with name — show nodes):**

```
Nodes mentioning [name] (N)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
2026-03-10 · fitness
"Talked to coach after gym, he said my form on..."

2026-03-08 · mental-health
"Had a hard conversation with partner about..."
```

---

## On `/bridges`

Show cross-domain bridge nodes from the most recent Surveyor run.

```bash
python3 -c "
import sys, json, pathlib, os
sys.path.insert(0, os.path.expanduser('~/openbodhi/packages/bodhi_vault/src'))
from bodhi_vault.read import query_nodes
from pathlib import Path

vault = Path.home() / 'openbodhi/vault'
# Synthesis nodes created by the Surveyor are the bridges
nodes = query_nodes(vault, node_type='Synthesis')
nodes.sort(key=lambda x: x.get('created_at',''), reverse=True)

for n in nodes[:8]:
    ts = n.get('created_at','')[:10]
    tags = ','.join(n.get('tags',[]))
    preview = n.get('content','')[:100].replace('\n',' ')
    print(f'{ts}|{tags}|{preview}')

if not nodes:
    print('NONE')
"
```

Format as:

```
Bridge nodes (N Synthesis)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
2026-03-14 · fitness+cognitive
"Your morning training pattern connects to your..."

2026-03-07 · health+mental-health
"Nutrition timing observations bridge with..."
```

If `NONE`: "No bridge nodes yet. The Surveyor runs Saturdays and writes Synthesis nodes when it finds connections."

---

## On `/stats`

Vault statistics — node counts by domain, type, and energy distribution.

```bash
python3 -c "
import sys, json, pathlib, os
sys.path.insert(0, os.path.expanduser('~/openbodhi/packages/bodhi_vault/src'))
from bodhi_vault.read import query_nodes
from pathlib import Path
from collections import Counter

vault = Path.home() / 'openbodhi/vault'
nodes = query_nodes(vault)

total = len(nodes)
by_domain = Counter(n.get('domain','unknown') for n in nodes)
by_type = Counter(n.get('type','Idea') for n in nodes)
by_energy = Counter(n.get('energy_level', 3) for n in nodes)

dates = sorted(n.get('created_at','')[:10] for n in nodes if n.get('created_at'))
oldest = dates[0] if dates else 'none'
newest = dates[-1] if dates else 'none'

print(f'TOTAL:{total}')
print(f'OLDEST:{oldest}')
print(f'NEWEST:{newest}')
for domain, count in by_domain.most_common():
    print(f'DOMAIN:{domain}:{count}')
for type_, count in by_type.most_common():
    print(f'TYPE:{type_}:{count}')
for energy in sorted(by_energy.keys()):
    print(f'ENERGY:{energy}:{by_energy[energy]}')
"
```

Format as:

```
Vault stats
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total nodes: N
Since: YYYY-MM-DD

By domain:
  fitness:      ████████ 42
  wellness:     ██████ 31
  cognitive:    ████ 20
  health:       ███ 18
  mental-health: ██ 11

By type:
  Idea: 78  Pattern: 22  Practice: 15
  Decision: 7  Synthesis: 3  Integration: 1

Energy distribution:
  1: 4  2: 9  3: 62  4: 28  5: 19
```

---

## Rules

- All commands are read-only. No vault writes.
- Cap all list outputs at 8-10 items to keep Telegram messages readable.
- Never expose full file paths or node IDs in replies (internal details).
- If vault is empty or doesn't exist, reply: "Vault is empty. Send a thought to Bo to start."
- Model is only invoked for formatting and synthesis — never for data modification.
