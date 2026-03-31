---
name: bodhi-viz
description: >
  Vault visualization — renders the knowledge graph (3D force-physics) and
  attention-flow Sankey diagram from vault nodes. Serves via HTTP on port 8085.
  Access via Tailscale URL from any device.
triggers:
  - /viz
  - /graph
  - /sankey
  - /viz graph
  - /viz sankey
  - /viz serve
  - /viz stop
  - /viz refresh
version: "1.0.0"
---

# bodhi-viz

Generates two visualizations from the vault:

1. **Knowledge Graph** (`/viz graph`) — 3D force-physics network. Nodes are vault entries, colored by wellness domain. Links from shared people, clusters, and tag affinity. Timeline scrubber, search, click-to-read.

2. **Attention Flow** (`/viz sankey`) — Sankey flow diagram. Shows where attention goes: Domain → Thought Type → Energy Tier. Reveals patterns in how you think.

## Commands

### `/viz graph`
Export vault data and open the 3D knowledge graph.

Steps:
1. Run: `python -m bodhi_viz.export`
2. If server not running: `python -m bodhi_viz.serve --export-first &`
3. Report URL to user

### `/viz sankey`
Export vault data and open the attention flow diagram.

Same as above — both visualizations share the same data export.

### `/viz refresh`
Re-export data with latest vault nodes. Server keeps running.
Run: `python -m bodhi_viz.export`

### `/viz serve`
Start the HTTP server without re-exporting.
Run: `python -m bodhi_viz.serve`

### `/viz stop`
Stop the viz server.
Run: `pkill -f "bodhi_viz.serve"`

### `/viz status`
Check if server is running on port 8085.
```bash
VIZ_IP=$(tailscale ip -4 2>/dev/null | head -1)
curl -s -o /dev/null -w "%{http_code}" "http://${VIZ_IP}:8085/ping"
```

## Implementation

### Check if server is running
```bash
VIZ_IP=$(tailscale ip -4 2>/dev/null | head -1)
curl -s -o /dev/null -w "%{http_code}" "http://${VIZ_IP}:8085/ping"
# 200 = running, curl error = not running
```

### Export data
```bash
cd ~/openbodhi
python -m bodhi_viz.export
```

### Start server (background)
```bash
cd ~/openbodhi
nohup python -m bodhi_viz.serve > ~/.openclaw/viz/serve.log 2>&1 &
echo $! > ~/.openclaw/viz/serve.pid
```

### Get the Tailscale URL
```bash
tailscale ip -4 2>/dev/null | head -1
```

## Response format

After successful export + server start, reply:

```
📊 {N} nodes · {L} links exported.

Open in browser:
• 3D Graph  → http://{TAILSCALE_IP}:8085/graph.html
• Flow Map  → http://{TAILSCALE_IP}:8085/sankey.html

Tap a link from any device on your Tailscale network.
```

If Tailscale IP unavailable, use local IP instead:
```bash
hostname -I | awk '{print $1}'
```

## Can these appear in Telegram directly?

**Short answer:** The interactive versions can't. But a preview image can.

The 3D graph uses WebGL and the Sankey uses D3 SVG — both require a browser. They can't be embedded as Telegram messages.

**What DOES work in Telegram:**
- A **link** to `http://{TAILSCALE_IP}:8085/graph.html` — user taps, opens in phone browser, full 3D graph loads
- The graph looks excellent on mobile (3d-force-graph is touch-capable)
- If you want a quick PNG preview in the chat, use `/viz image` (requires matplotlib + networkx)

**`/viz image` (optional, requires deps)**
```bash
pip install matplotlib networkx
python -c "
import json, networkx as nx, matplotlib.pyplot as plt
from pathlib import Path

data = json.loads(Path('~/.openclaw/viz/graph.json').expanduser().read_text())
COLORS = {'wellness':'#4ade80','fitness':'#60a5fa','health':'#f97316',
          'mental-health':'#c084fc','cognitive':'#facc15'}

G = nx.Graph()
for n in data['nodes']: G.add_node(n['id'], **n)
for l in data['links']: G.add_edge(l['source'], l['target'])

pos = nx.spring_layout(G, k=2, seed=42)
colors = [COLORS.get(G.nodes[n].get('group','unknown'), '#94a3b8') for n in G.nodes]
sizes = [G.nodes[n].get('val', 4) * 60 for n in G.nodes]

fig, ax = plt.subplots(figsize=(12, 8))
fig.patch.set_facecolor('#060b18')
ax.set_facecolor('#060b18')
nx.draw_networkx(G, pos, node_color=colors, node_size=sizes, with_labels=False,
                 edge_color='#1e2d45', width=0.5, alpha=0.9, ax=ax)
plt.tight_layout()
plt.savefig('/tmp/bodhi-graph.png', dpi=150, bbox_inches='tight',
            facecolor='#060b18', edgecolor='none')
print('/tmp/bodhi-graph.png')
"
```
Then send `/tmp/bodhi-graph.png` as a Telegram photo.

## Dependencies

All standard library except for visualization CDN (loaded in browser). No pip install required for core export/serve.

For the `/viz image` PNG mode: `pip install matplotlib networkx`

## Notes

- Server runs on port 8085. Make sure UFW allows it from Tailscale:
  `sudo ufw allow in on tailscale0 to any port 8085`
- The viz dir is `~/.openclaw/viz/` — gitignored
- Data refreshes by running export again; page auto-reloads if you refresh the browser
- Timeline scrubber in graph.html filters by `created_at` so you can watch your vault grow over time
