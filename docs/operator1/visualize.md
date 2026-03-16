---
title: "Visualize"
summary: "Real-time Matrix-themed pixel art canvas showing all agents, their activity states, zone assignments, and live session logs."
---

# Visualize

Visualize is a live pixel art view of all agents in the system. You can see which ones are active, what they're working on, and how work flows.

Go to **Visualize** in the sidebar.

## The canvas

The canvas is a 32×32 tile grid rendered as a top-down pixel art world. Each tile is 32 px at 100% zoom. Agents appear as animated pixel characters standing inside their assigned zone.

The background continuously runs a Matrix-style green rain effect that reflects the connection state of the gateway.

### Agent activity states

Each agent character on the canvas reflects the agent's current activity:

| State         | Visual indicator | Meaning                                    |
| ------------- | ---------------- | ------------------------------------------ |
| **Idle**      | Still, dim       | No active session                          |
| **Thinking**  | Animated glow    | Claude is reasoning (tool calls, planning) |
| **Answering** | Typing animation | Claude is streaming a reply                |

The canvas polls `sessions.list` and `teamruns.list` every 5 seconds to detect state changes. Activity indicators clear automatically once a session ends.

## Zones

The world is divided into five named zones. Each zone houses a specific tier or group of agents and has a distinct color theme.

### The Matrix Core

Color: red. Spans the top of the map (rows 2–9, full width).

A decorative frontier zone representing the digital layer above the hierarchy. Agents not explicitly mapped to another zone default here.

### Zion

Color: blue. Left middle section.

Home of the **Tier 2 C-suite managers**:

| Agent    | Role |
| -------- | ---- |
| Neo      | CTO  |
| Morpheus | CMO  |
| Trinity  | CFO  |

### The Broadcast

Color: white. Center middle section.

Reserved for **Operator1** (the COO / Tier 1 coordinator). This is the hub that receives tasks from the human operator and dispatches them to department heads.

### Machine City

Color: green. Right middle section.

Houses the **Tier 3 engineering and cross-department workers** that do the actual execution work:

Tank, Dozer, Mouse, Niobe, Switch, Rex, Oracle, Seraph, Zee.

Any agent not found in the zone map defaults to Machine City.

### The Construct

Color: purple. Bottom strip spanning full width.

A staging and loading zone. Used for agents in setup or transition states.

## Controls

The control panel sits bottom-right of the canvas.

| Button     | Keyboard   | Action                                      |
| ---------- | ---------- | ------------------------------------------- |
| Zoom In    | `+` or `=` | Increase zoom (max 300%)                    |
| Zoom Out   | `-`        | Decrease zoom (min 25%)                     |
| Lock       | —          | Freeze pan/zoom; disables all zoom controls |
| Fit        | `0`        | Reset zoom to 100%                          |
| Fullscreen | —          | Toggle browser fullscreen mode              |

The lock button is useful during presentations or when you want to prevent accidental zoom changes while watching agents.

## Keyboard shortcuts

When focus is not on an input field:

| Key       | Action                                      |
| --------- | ------------------------------------------- |
| `+` / `=` | Zoom in                                     |
| `-`       | Zoom out                                    |
| `0`       | Fit to view (reset to 100%)                 |
| `Esc`     | Close log terminal panel, or deselect agent |

## Clicking an agent

Click any agent character on the canvas to open the **Agent Detail Panel** — a slide-in sheet on the right showing:

- Agent name and role
- Current session status
- A **View Logs** button that closes the detail panel and opens the log terminal filtered to that agent's messages

Press `Esc` or click outside to dismiss the panel.

## Log terminal panel

The log terminal is a live-scrolling terminal view of gateway log events. It opens when you click **View Logs** from the agent detail panel, and can also be triggered by clicking terminal tiles on the canvas.

The panel is pre-filtered by the agent's name, so only messages related to that agent appear. The accent color matches the agent's zone color.

Close it with the `×` button or by pressing `Esc`.

## Team overlay

When a multi-agent team run is active, a **Team Overlay** badge appears on the canvas showing the team name and which agents are participating. This is driven by `teamruns.list` polling.

## Status bar

The status bar runs along the bottom edge of the canvas and shows three live metrics:

| Metric     | Description                                                                           |
| ---------- | ------------------------------------------------------------------------------------- |
| **Agents** | Number of agents with an active session right now                                     |
| **Tokens** | Cumulative token count across all sessions (formatted as `k` or `M` for large values) |
| **Zoom**   | Current zoom level as a percentage                                                    |

The connection status indicator (`connected` / `error` / `disconnected`) also appears in the status bar. The canvas does not poll or animate when the gateway is disconnected.

## How agents are placed

Agent placement is deterministic and based on the `ZONE_AGENT_MAP` in the pixel engine. Each agent has a fixed zone, palette index, and hue shift. Their tile position within the zone is computed from the palette index so agents never overlap.

Agents that are not found in the zone map (for example, dynamically registered agents from the marketplace) are placed in Machine City with a hash-derived palette so they always appear in a consistent position relative to their name.
