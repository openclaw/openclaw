---
name: abb-robot-control
description: >
  Unified ABB robot control skill (OpenClaw). This is the shared entry point
  describing the two operating modes and common operations.
  Real mode (abb_robot_real): for physical robots and ABB RobotStudio.
  Virtual mode (abb_robot_virtual): for OpenClaw 3D kinematic viewer (ws-bridge).
  See mode-specific skill docs for detailed workflows.
metadata:
  openclaw:
    emoji: "\U0001F916"
    requires:
      bins: []
---

# ABB Robot Control Skill (Shared Entry Point)

This skill is the shared entry point for the `abb_robot` MCP tool,
describing the two operating modes and common methods.
For detailed workflows, RAPID templates, and safety rules, see the mode-specific skill docs.

## Mode Comparison

| Feature | Real Mode (`abb_robot_real`) | Virtual Mode (`abb_robot_virtual`) |
|---------|-----------------------------|------------------------------------|
| Targets | Physical ABB robots, ABB RobotStudio | OpenClaw 3D kinematic viewer |
| Connection | ABB PC SDK (controller IP) | WebSocket (ws-bridge) |
| Supported ops | All operations (motion, RAPID, IO, etc.) | Basic operations (connect, status, joint motion) |
| Safety | First move at speed:10, verify Auto mode | No special safety requirements |
| RobotStudio | ✅ Fully supported (same PC SDK interface) | ❌ Not applicable |

## Mode Selection Rules

- Physical robot → `abb_robot_real`
- ABB RobotStudio → `abb_robot_real` (RobotStudio simulates a real controller, same API)
- OpenClaw 3D viewer → `abb_robot_virtual`
- When using the unified tool `abb_robot`: use `mode:real` for real, `mode:virtual` for virtual
- **Do not** rely on `mode:auto` for safety-critical tasks

## Common Action Reference

The following actions are available in both modes (replace tool name with the appropriate plugin):

### Connection
```
abb_robot action:scan_controllers
abb_robot action:connect host:<ip>
abb_robot action:disconnect
```

### Status & Info
```
abb_robot action:get_status
abb_robot action:get_system_info
abb_robot action:get_service_info
abb_robot action:get_version
abb_robot action:identify_robot
```

### Joint Motion
```
abb_robot action:get_joints
abb_robot action:get_world_position
abb_robot action:set_joints joints:[0,-20,20,0,20,0] speed:20
abb_robot action:movj joints:[0,-20,20,0,20,0] speed:20
abb_robot action:go_home
```

### Speed
```
abb_robot action:get_speed
abb_robot action:set_speed speed:50
```

### Robot Configuration Query
```
abb_robot action:list_robots
abb_robot action:list_presets robot_id:abb-crb-15000
abb_robot action:list_sequences robot_id:abb-crb-15000
```

### Event Log
```
abb_robot action:get_event_log category_id:0 limit:20
# category_id: 0=all 1=operational 2=system 3=hardware 4=program(RAPID errors) 5=motion
abb_robot action:get_event_log_categories
```

### Motion Memory
```
abb_robot action:get_motion_memory
abb_robot action:reset_motion_memory
```

### Creative Motion
```
abb_robot action:dance_two_points point_a:[0,0,0,0,0,0] point_b:[30,-20,20,0,20,0] repeat:4 speed:40
abb_robot action:dance_template template:wave amplitude:1.0 beats:8 speed:40
# templates: wave, bounce, sway, twist
```

## Real-Mode-Only Operations

The following are only available in real mode (`abb_robot_real` / `mode:real`).
See the abb-robot-real-control skill doc for details:

- Cartesian motion: `movl`, `movc`, `movj_rapid`
- RAPID programs: `execute_rapid`, `load_rapid`, `start_program`, `stop_program`, `reset_program_pointer`
- Tasks & modules: `list_tasks`, `set_preset`, `run_sequence`

<!-- @@DISABLED: The following actions are temporarily disabled — AI must NOT execute them -->
<!-- @@DISABLED_START: Motors / Variables & IO -->
<!--
### Motors (Disabled — not supported via PC SDK DefaultUser)
Toggle motor state from the controller teach pendant:
```
# motors_on / motors_off — always return error via PC SDK DefaultUser credentials
# Use the FlexPendant or controller front panel instead
```

### Variables & IO (Disabled)
The following actions are currently forbidden. For reference only:
```
abb_robot action:get_rapid_variable task_name:T_ROB1 var_name:reg1
abb_robot action:get_rapid_variable task_name:T_ROB1 module_name:MainModule var_name:myVar
abb_robot action:set_rapid_variable task_name:T_ROB1 module_name:MainModule var_name:reg1 value:42
abb_robot action:get_io_signals
abb_robot action:get_io_signals name_filter:EXAO limit:20
abb_robot action:list_rapid_variables task_name:T_ROB1
abb_robot action:list_rapid_variables task_name:T_ROB1 module_name:MainModule limit:50
```
-->
<!-- @@DISABLED_END: Motors / Variables & IO -->

## Troubleshooting

1. Real robot did not move → check that mode was `real`
2. Connect failed in real mode → report exact NetScan error and discovered controllers
3. Motion blocked in real mode → check for missing `safety_confirmed:true`
4. Virtual movement not visible → check ws-bridge connection and viewer model loading
5. Controlling RobotStudio → use `abb_robot_real`
