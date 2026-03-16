---
name: robot-kinematic
description: >
  Control robot arms in the 3D kinematic viewer (robot_kinematic_viewer.html) via
  natural-language chat. Use when the user wants to move a robot, apply a pose,
  run a motion sequence, wave, dance, inspect, pick, or any other arm motion.
  Also use when the user asks to switch between robots, list available robots or
  presets, or configure the WebSocket viewer connection.
metadata:
  openclaw:
    emoji: "🦾"
    requires:
      bins: []
---

# Robot Kinematic Viewer Skill

Control any configured robot arm in the 3D viewer via chat.

## Quick Reference

| What the user says | Action to use |
|---|---|
| "wave", "say hello" | `set_preset` → `wave` |
| "go home", "reset" | `go_home` |
| "dance" | `run_sequence` → `dance_sequence` |
| "nod yes" | `run_sequence` → `nod_sequence` |
| "inspect pose" | `set_preset` → `inspect` |
| "stretch up" | `set_preset` → `stretch_up` |
| "set joint 1 to 45°" | `set_joints` with array |
| "movj 到目标位，速度 40" | `movj` with `joints` + `speed` |
| "which robots?" | `list_robots` |
| "switch to robot X" | `switch_robot` |
| "what presets exist?" | `list_presets` |
| "run wave sequence" | `run_sequence` → `wave_sequence` |

## Prerequisites

1. Start the WebSocket bridge (runs once, keep running):
   ```bash
   # with Bun (preferred):
   bun models/Plugin/src/ws-bridge.ts
   # or with Node + tsx:
   node --import tsx models/Plugin/src/ws-bridge.ts
   ```
2. Open `models/robot_kinematic_viewer.html` in a browser.
3. In the viewer sidebar, set IP = `127.0.0.1`, port = `9877`, click **Connect**.
4. Drop / load `models/ABB Robot/ABB-CRB-15000.glb` into the viewer.

## Tool Usage

All actions go through a single `robot_control` tool.

### Move to a preset

```
robot_control action:set_preset preset:ready
```

Available presets for ABB CRB 15000:
`home`, `ready`, `inspect`, `pick_low`, `stretch_up`, `stretch_fwd`,
`tuck`, `wave`, `salute`, `dance_a`, `dance_b`

### Set explicit joint angles

```
robot_control action:set_joints joints:[45, -30, 60, 0, 30, 0]
```

### MoveJ continuous motion (with speed)

```
robot_control action:movj joints:[30, -20, 55, 15, 25, 10] speed:40
```

Notes:
- `movj` is continuous from current pose to target pose (or from `start_joints` when provided).
- `speed` range is `1-100` (recommended `30-60` for visible smooth motion).
- Optional `max_joint_step` controls interpolation density (smaller = smoother).

Joints are always validated against the robot config. Out-of-range values are
automatically clamped and the user is informed.

**ABB CRB 15000 joint limits:**
| Joint | Label | Min | Max | Speed |
|---|---|---|---|---|
| J1 | Base Rotation | −180° | 180° | 250 °/s |
| J2 | Shoulder | −180° | 180° | 250 °/s |
| J3 | Elbow | −180° | 180° | 250 °/s |
| J4 | Forearm Roll | −225° | 85° | 320 °/s |
| J5 | Wrist Pitch | −180° | 180° | 320 °/s |
| J6 | Flange Roll | −180° | 180° | 420 °/s |

### Run a motion sequence

```
robot_control action:run_sequence sequence:wave_sequence
```

Built-in sequences: `wave_sequence`, `dance_sequence`, `nod_sequence`, `inspect_sequence`

Sequences play all steps with the configured timing then return home automatically.

### Query current state

```
robot_control action:get_state
```

### Switch robots

```
robot_control action:list_robots
robot_control action:switch_robot robot_id:abb-crb-15000
```

To add a new robot:
1. Place its GLB in `models/ABB Robot/` (or any subdirectory).
2. Create `models/Plugin/robots/<robot-id>.json` following the schema
   in `models/Plugin/robots/robot-config.schema.json`.
3. Use `switch_robot` to activate it — no code changes needed.

### Configure viewer connection

```
robot_control action:set_viewer ws_host:192.168.1.10 ws_port:9877
```

## Robot Config Format

Each robot is defined in `models/Plugin/robots/<id>.json`:

```json
{
  "id": "my-robot",
  "manufacturer": "Vendor",
  "model": "Model Name",
  "dof": 6,
  "joints": [
    { "index": 0, "id": "joint0", "type": "revolute",
      "min": -180, "max": 180, "home": 0, "axis": [0,0,1] }
  ],
  "presets": { "home": [0,0,0,0,0,0] },
  "sequences": {
    "wave_sequence": {
      "steps": [
        { "joints": [45,0,0,0,0,0], "durationMs": 500 }
      ]
    }
  }
}
```

The plugin reads configs at runtime — add a file and call `switch_robot` immediately.

## Architecture

```
OpenClaw chat
     │
     ▼
 robot_control tool  (models/Plugin/src/robot-kinematic-tool.ts)
     │  validates joints against robot config JSON
     │
     ▼
 WebSocket bridge  ws://127.0.0.1:9877  (models/Plugin/src/ws-bridge.ts)
     │
     ▼
 robot_kinematic_viewer.html  (browser, Three.js 3D viewer)
```

All joint values are validated server-side before reaching the viewer.
Invalid targets are clamped to the configured [min, max] range.

