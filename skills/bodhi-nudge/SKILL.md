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

Check for ripe clusters and surface one question. Uses the nudge_scheduler engine.

```bash
cd ~/openbodhi && python3 -c "
import sys
sys.path.insert(0, 'packages/bodhi_vault/src')
from pathlib import Path
from bodhi_vault.nudge_scheduler import generate_nudges, nudge_status

vault = Path.home() / 'openbodhi/vault'
nudges = generate_nudges(vault_path=vault)
if nudges:
    n = nudges[0]
    domains = '+'.join(n['domains']) if n['domains'] else 'unknown'
    print(f'RIPE:{n[\"cluster_id\"]}:{n[\"node_count\"]}:{domains}:{n[\"question\"]}')
else:
    status = nudge_status(vault_path=vault)
    print(f'NONE:{status}')
"
```

If `RIPE:<id>:<count>:<domains>:<question>`:

Surface the question exactly as returned. Do not rephrase it. Do not add context.
Then wait. One question. That's the whole nudge.

If `NONE:<status>`: relay the status string as-is. "Nothing ripe yet." or cooldown info.

## On `/nudge dismiss [cluster_id]`

Dismiss and start the expanding cooldown for that cluster.

```bash
cd ~/openbodhi && python3 -c "
import sys
sys.path.insert(0, 'packages/bodhi_vault/src')
from pathlib import Path
from bodhi_vault.nudge_scheduler import dismiss_nudge

cluster_id = sys.argv[1] if len(sys.argv) > 1 else ''
if cluster_id:
    dismiss_nudge(cluster_id)
    print(f'dismissed:{cluster_id}')
else:
    print('no cluster id given')
" \$1
```

Reply: "Dismissed. Will resurface when the interval expands."

## On `/patterns`

Show cluster energy ranked by domain — without generating a nudge.

```bash
cd ~/openbodhi && python3 -c "
import sys
sys.path.insert(0, 'packages/bodhi_vault/src')
from pathlib import Path
from collections import Counter
from bodhi_vault.energy_model import compute_cluster_energies

vault = Path.home() / 'openbodhi/vault'
clusters = compute_cluster_energies(vault_path=vault)

if not clusters:
    print('no data')
else:
    domain_energy = Counter()
    domain_nodes = Counter()
    for c in clusters:
        for d in c.domains:
            domain_energy[d] += c.energy
            domain_nodes[d] += c.node_count
    for d, e in domain_energy.most_common():
        print(f'{d}:{round(e, 2)}:{domain_nodes[d]}')
"
```

Format the output as:
```
Patterns (energy-weighted)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
health:        ████████ 8 nodes · 3.4 energy
fitness:       █████ 5 nodes · 1.8 energy
mental-health: ████ 4 nodes · 1.2 energy
wellness:      ██ 2 nodes · 0.6 energy
cognitive:     █ 1 node  · 0.2 energy
```

Bar width = proportional to energy, not node count. Energy is what matters here.

## Rules

- ONE question per nudge. Never two. Never a list.
- Never prescriptive. Never "you should." Never "try this."
- Dismissible, reschedulable, mutable. User controls the pace.
- Expanding intervals (Ebbinghaus): 3 → 7 → 14 → 30 days between dismissals.
- Ambient by default. Nudges only fire when explicitly checked (/nudge) or via cron.
- Cross-domain bridges (e.g. fitness+cognitive) are highest priority nudges when detected.
- All state files use atomic writes (tempfile + os.replace).
