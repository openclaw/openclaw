---
name: abb-robot-control
description: >
  Control actual ABB robots via PC SDK. Use when the user wants to connect to
  an ABB robot controller, move a real robot, execute RAPID programs, apply
  presets, run motion sequences, or query robot status. Supports automatic
  robot identification based on DH parameters and joint limits. Use for any
  task involving real ABB robot hardware control.
metadata:
  openclaw:
    emoji: "🤖"
    requires:
      bins: []
---

# ABB Robot Control Skill

Control actual ABB robots via PC SDK through natural language commands.

## Quick Reference

| User Request | Action |
|---|---|
| "Connect to robot at 192.168.1.10" | `abb_robot` action:`connect` host:`192.168.1.10` |
| "Disconnect from robot" | `abb_robot` action:`disconnect` |
| "Move robot to home" | `abb_robot` action:`go_home` |
| "Set joint 1 to 45 degrees" | `abb_robot` action:`set_joints` joints:`[45,0,0,0,0,0]` |
| "Smooth move to target" | `abb_robot` action:`movj` joints:`[30,-20,55,15,25,10]` speed:`40` |
| "Apply ready preset" | `abb_robot` action:`set_preset` preset:`ready` |
| "Execute wave sequence" | `abb_robot` action:`run_sequence` sequence:`wave_sequence` |
| "Get current position" | `abb_robot` action:`get_joints` |
| "Check robot status" | `abb_robot` action:`get_status` |
| "Turn motors on" | `abb_robot` action:`motors_on` |
| "Turn motors off" | `abb_robot` action:`motors_off` |
| "List available robots" | `abb_robot` action:`list_robots` |
| "List presets" | `abb_robot` action:`list_presets` |
| "List sequences" | `abb_robot` action:`list_sequences` |
| "Identify connected robot" | `abb_robot` action:`identify_robot` |
| "Load RAPID program" | `abb_robot` action:`load_rapid` rapid_code:`...` |
| "Start RAPID program" | `abb_robot` action:`start_program` |
| "Stop RAPID program" | `abb_robot` action:`stop_program` |
| "Execute RAPID code" | `abb_robot` action:`execute_rapid` rapid_code:`...` |
| "Make the robot dance" | `abb_robot` action:`dance_template` template:`wave` |
| "Dance between two poses" | `abb_robot` action:`dance_two_points` point_a:`[...]` point_b:`[...]` |
| "Show motion history" | `abb_robot` action:`get_motion_memory` |
| "Clear motion history" | `abb_robot` action:`reset_motion_memory` |
| "Check plugin version" | `abb_robot` action:`get_version` |

## Prerequisites

1. **ABB PC SDK 2025** installed on Windows
2. **ABB robot controller** accessible on network
3. **Robot configuration file** in `extensions/abb-robot-control/robots/`
4. **Network connectivity** to robot controller (default port 7000)

## Connection

Before controlling the robot, establish connection:

```
User: Connect to the ABB robot at 192.168.125.1
Tool: abb_robot action:connect host:192.168.125.1
```

The plugin will:
- Connect to the controller via PC SDK
- Auto-identify the robot model based on joint limits and DH parameters
- Load the matching robot configuration
- Report connection status and robot model

## Robot Configuration

Each robot requires a configuration file in `robots/<robot-id>.json`:

```json
{
  "id": "abb-crb-15000",
  "manufacturer": "ABB",
  "model": "CRB 15000",
  "dof": 6,
  "joints": [
    {
      "index": 0,
      "id": "joint0",
      "label": "J1 - Base Rotation",
      "type": "revolute",
      "min": -180.0,
      "max": 180.0,
      "speed": 250.0,
      "home": 0.0
    }
  ],
  "presets": {
    "home": [0, 0, 0, 0, 0, 0],
    "ready": [0, -30, 60, 0, 30, 0]
  },
  "sequences": {
    "wave_sequence": {
      "steps": [
        { "joints": [45, -30, 60, 0, 30, 0], "durationMs": 800, "speed": 100 }
      ]
    }
  }
}
```

## Available Actions

### connect
Connect to ABB robot controller.

**Parameters:**
- `host` (required): Controller IP address or hostname
- `port` (optional): Controller port (default: 7000)
- `robot_id` (optional): Robot config ID (auto-detected if omitted)

**Example:**
```
abb_robot action:connect host:192.168.125.1 port:7000
```

### disconnect
Disconnect from controller.

### get_status
Get controller and robot status (operation mode, motor state, RAPID running).

### get_version
Get the plugin version string for debugging.

### get_joints
Get current joint positions in degrees.

### set_joints
Move robot to specified joint positions.

**Parameters:**
- `joints` (required): Array of joint angles in degrees
- `speed` (optional): Movement speed 1-100% (default: 100)

**Example:**
```
abb_robot action:set_joints joints:[0,-30,60,0,30,0] speed:50
```

Joint values are automatically clamped to configured limits.

### movj
Continuous joint motion from current (or specified start) position to target, with smooth interpolation.

**Parameters:**
- `joints` (required): Target joint angles in degrees
- `start_joints` (optional): Starting joint angles (uses current position if omitted)
- `speed` (optional): Movement speed 1-100% (default: 45)
- `max_joint_step` (optional): Max interpolation step per joint in degrees (default: 6)
- `min_samples` (optional): Minimum interpolation samples per segment (default: 2)
- `interpolation` (optional): Interpolation profile — `linear`, `smoothstep`, or `cosine` (default: `cosine`)
- `module_name` (optional): RAPID module name (default: `MoveJSegment`)

**Example:**
```
abb_robot action:movj joints:[30,-20,55,15,25,10] speed:40
abb_robot action:movj joints:[90,0,0,0,0,0] start_joints:[0,0,0,0,0,0] speed:60 interpolation:smoothstep
```

### set_preset
Apply a named preset position.

**Parameters:**
- `preset` (required): Preset name (e.g. "home", "ready")
- `speed` (optional): Movement speed 1-100%

**Example:**
```
abb_robot action:set_preset preset:ready speed:75
```

### run_sequence
Execute a named motion sequence.

**Parameters:**
- `sequence` (required): Sequence name (e.g. "wave_sequence")

**Example:**
```
abb_robot action:run_sequence sequence:wave_sequence
```

Sequences are converted to RAPID programs and executed on the controller.

### go_home
Return all joints to home position (typically all zeros).

### identify_robot
Identify the connected robot model by matching controller joint limits and DH parameters against known robot configurations.

**Example:**
```
abb_robot action:identify_robot
```

### execute_rapid
Load and immediately run RAPID code on the controller in one step.

**Parameters:**
- `rapid_code` (required): RAPID program code
- `module_name` (optional): Module name (default: "MainModule")

**Example:**
```
abb_robot action:execute_rapid rapid_code:"MODULE MainModule\n  PROC main()\n    MoveJ [[0,0,0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]], v100, fine, tool0;\n  ENDPROC\nENDMODULE"
```

### load_rapid
Stage a RAPID program on the controller without executing it. Use `start_program` afterwards to begin execution.

**Parameters:**
- `rapid_code` (required): RAPID program code
- `module_name` (optional): Module name (default: "MainModule")

**Example:**
```
abb_robot action:load_rapid rapid_code:"MODULE MyModule\n  PROC main()\n    ...\n  ENDPROC\nENDMODULE"
```

### start_program
Start execution of the currently loaded RAPID program on the controller.

### stop_program
Stop the currently running RAPID program on the controller.

### motors_on / motors_off
Turn robot motors on or off.

### list_robots
List all available robot configurations.

### list_presets
List presets for current or specified robot.

**Parameters:**
- `robot_id` (optional): Robot config ID

### list_sequences
List motion sequences for current or specified robot.

### dance_two_points
Execute a continuous dance motion oscillating between two joint positions.

**Parameters:**
- `point_a` (required): First joint position (array of angles in degrees)
- `point_b` (required): Second joint position (array of angles in degrees)
- `repeat` (optional): Number of A-B oscillations (default: 2)
- `speed` (optional): Movement speed 1-100% (default: 45)
- `max_joint_step` (optional): Max interpolation step (default: 6)
- `min_samples` (optional): Minimum interpolation samples (default: 2)
- `interpolation` (optional): `linear`, `smoothstep`, or `cosine` (default: `cosine`)
- `auto_connect` (optional): Auto-connect from last position to point A (default: true)
- `return_to_a` (optional): Return to point A at end (default: false)
- `module_name` (optional): RAPID module name (default: `DanceSegment`)

**Example:**
```
abb_robot action:dance_two_points point_a:[0,-30,60,0,30,0] point_b:[90,-30,60,45,30,0] repeat:4 speed:50
```

### dance_template
Execute a built-in dance template motion pattern.

**Parameters:**
- `template` (required): Template name — `wave`, `bounce`, `sway`, or `twist`
- `amplitude` (optional): Amplitude scale 0.1-2.0 (default: 1.0)
- `beats` (optional): Number of beats mapped to repeat count (default: 8)
- `speed` (optional): Movement speed 1-100% (default: 45)
- `max_joint_step` (optional): Max interpolation step (default: 6)
- `interpolation` (optional): `linear`, `smoothstep`, or `cosine` (default: `cosine`)
- `module_name` (optional): RAPID module name

**Example:**
```
abb_robot action:dance_template template:wave beats:8 speed:50
abb_robot action:dance_template template:bounce amplitude:1.5
```

### get_motion_memory
View motion history including last target position and recent history entries.

### reset_motion_memory
Clear all motion history and last target position.

## Multi-Robot Support

The plugin supports multiple robot configurations. Each robot is identified by:

1. **Joint limits** - Min/max angles for each joint
2. **DH parameters** - Denavit-Hartenberg kinematic parameters
3. **DOF** - Number of degrees of freedom

When connecting, the plugin automatically identifies the robot model by comparing
controller data with available configurations.

To add a new robot:

1. Create `robots/<robot-id>.json` with robot specifications
2. Connect to controller - auto-identification will match the config
3. Or specify `robot_id` parameter explicitly

## Safety Notes

- Always verify joint limits before moving
- Start with low speeds (20-50%) for testing
- Ensure workspace is clear before executing motions
- Use emergency stop if unexpected behavior occurs
- Test sequences in simulation before running on real hardware

## RAPID Program Generation

The plugin automatically generates RAPID code for:

- Single joint movements (`set_joints`)
- Continuous interpolated motions (`movj`)
- Motion sequences (`run_sequence`)
- Dance patterns (`dance_two_points`, `dance_template`)

Generated programs use:
- `MoveAbsJ` for joint movements
- Speed values: `v1` to `v100` (percentage)
- Zone values: `fine` (precise) or `z10` (blended)

## Troubleshooting

**Connection fails:**
- Verify controller IP address and network connectivity
- Check firewall settings (port 7000)
- Ensure PC SDK is installed correctly
- Verify controller is in AUTO mode

**Robot doesn't move:**
- Check motor state with `get_status`
- Turn motors on with `motors_on`
- Verify operation mode is AUTO
- Check for active RAPID programs

**Joint limits exceeded:**
- Plugin automatically clamps values to configured limits
- Check robot configuration file for correct min/max values
- Violations are reported in tool response

**Robot not identified:**
- Use `identify_robot` action to re-identify
- Manually specify `robot_id` parameter
- Verify robot configuration file exists
- Check joint limits and DH parameters match actual robot

## Example Workflows

### Basic Movement
```
User: Connect to robot at 192.168.125.1
AI: abb_robot action:connect host:192.168.125.1

User: Move to ready position
AI: abb_robot action:set_preset preset:ready

User: Now move joint 1 to 90 degrees
AI: abb_robot action:set_joints joints:[90,0,0,0,0,0]
```

### Smooth Continuous Motion
```
User: Smoothly move to target position at speed 40
AI: abb_robot action:movj joints:[30,-20,55,15,25,10] speed:40

User: Use linear interpolation for the next move
AI: abb_robot action:movj joints:[0,0,0,0,0,0] speed:60 interpolation:linear
```

### Execute Sequence
```
User: Make the robot wave
AI: abb_robot action:run_sequence sequence:wave_sequence

User: What other sequences are available?
AI: abb_robot action:list_sequences
```

### Dance Patterns
```
User: Make the robot dance
AI: abb_robot action:dance_template template:wave beats:8 speed:50

User: Dance between two custom poses
AI: abb_robot action:dance_two_points point_a:[0,-30,60,0,30,0] point_b:[90,-30,60,45,30,0] repeat:4
```

### RAPID Program Management
```
User: Load a custom RAPID program
AI: abb_robot action:load_rapid rapid_code:"MODULE PickPlace\n  PROC main()\n    MoveJ pPick, v100, fine, tool0;\n  ENDPROC\nENDMODULE"

User: Start the loaded program
AI: abb_robot action:start_program

User: Stop the program
AI: abb_robot action:stop_program
```

## Configuration

Plugin configuration in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "abb-robot-control": {
        "enabled": true,
        "config": {
          "controllerHost": "192.168.125.1",
          "controllerPort": 7000,
          "defaultRobot": "abb-crb-15000",
          "autoConnect": false,
          "rapidProgramPath": "/hd0a/programs/"
        }
      }
    }
  }
}
```

## Architecture

```
OpenClaw Chat
     │
     ▼
abb_robot MCP Tool
     │
     ▼
ABB Controller (abb-controller.ts)
     │
     ▼
ABB PC SDK (C# Bridge)
     │
     ▼
Robot Controller (IRC5)
     │
     ▼
Physical Robot
```

The plugin uses a C# bridge process to interface with ABB's PC SDK, which
communicates with the robot controller over TCP/IP.
