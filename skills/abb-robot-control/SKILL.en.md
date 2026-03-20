---
name: abb-robot-control
description: >
  Unified ABB robot control skill for OpenClaw. Use for virtual viewer motion,
  ABB RobotStudio virtual controller testing, and real ABB controller operations.
  Enforces explicit mode selection and safety confirmation before physical motion.
  Available actions: connect, disconnect, scan_controllers, get_status, get_system_info,
  get_service_info, get_version, get_joints, set_joints, get_world_position, get_speed,
  set_speed, movj, movj_rapid, go_home, set_preset, run_sequence, list_robots,
  list_presets, list_sequences, execute_rapid, load_rapid, start_program, stop_program,
  reset_program_pointer, list_tasks, backup_module, get_event_log, motors_on, motors_off,
  identify_robot, dance_two_points, dance_template, get_motion_memory, reset_motion_memory,
  get_event_log_categories, get_rapid_variable, get_io_signals, list_rapid_modules.
metadata:
  openclaw:
    emoji: "\U0001F916"
    requires:
      bins: []
---

# ABB Robot Control Skill

This skill is the execution contract for the `abb_robot` MCP tool.

## RobotStudio & Real Controller Note

**Using the real robot plugin (`abb_robot_real`) to control ABB RobotStudio is fully supported.**
ABB RobotStudio simulates a real controller at the PC SDK level — it exposes the same
`ABB.Robotics.Controllers` API as physical hardware. When a user wants to control RobotStudio,
they should use the real robot plugin directly (not the virtual viewer):

```
abb_robot_real action:scan_controllers          # discovers RobotStudio virtual controllers on LAN
abb_robot_real action:connect host:<rs-ip>      # connects to RobotStudio controller
abb_robot_real action:get_status               # verifies mode and motor state
```

No special mode or flag is required — RobotStudio and physical robots use the same plugin.

## Operating Rules

- For physical robots and RobotStudio, always use `mode:real` explicitly.
- For 3D viewer simulation (ws-bridge), always use `mode:virtual` explicitly.
- Do not rely on `mode:auto` for safety-critical tasks.
- Before any physical motion command, include `safety_confirmed:true`.
- Never execute `execute_rapid` on real hardware unless user explicitly asks and confirms risk.

## Minimum Safe Command Patterns

### Real Robot or RobotStudio

1. Connect
`abb_robot action:connect mode:real host:<controller-ip>`

2. Check status
`abb_robot action:get_status mode:real`

3. Controlled move
`abb_robot action:movj mode:real safety_confirmed:true joints:[0,-20,20,0,20,0] speed:10`

### Virtual Viewer (ws-bridge only)

1. Connect bridge session
`abb_robot action:connect mode:virtual host:127.0.0.1 port:9877`

2. Motion
`abb_robot action:movj mode:virtual joints:[30,-20,55,15,25,10] speed:40`

## Troubleshooting Decision Tree

1. If user says "real robot did not move":
Check whether mode was `real` and not virtual fallback.

2. If connect failed in real mode:
Report exact NetScan/discovery error and discovered controllers.

3. If motion blocked in real mode:
Check missing `safety_confirmed:true` first.

4. If virtual movement not visible:
Check ws-bridge connection and viewer model loading.

5. If user wants to control RobotStudio:
Use `abb_robot_real` — RobotStudio exposes same PC SDK interface as real hardware.

## Action Reference

### Connection
- Connect: `connect`
- Disconnect: `disconnect`
- Scan: `scan_controllers`

### Status & Info
- Status: `get_status`
- System info: `get_system_info`
- Service info: `get_service_info`
- Version: `get_version`

### Position & Motion
- Current joints: `get_joints`
- World pose: `get_world_position`
- MoveJ (interpolated): `movj`
- MoveJ (RAPID): `movj_rapid`
- Home: `go_home`
- Set preset: `set_preset`
- Run sequence: `run_sequence`

### Speed & Motors
- Get speed: `get_speed`
- Set speed: `set_speed speed:50`
- Motors on/off: `motors_on`, `motors_off`

### RAPID
- Load: `load_rapid`
- Execute end-to-end: `execute_rapid`
- Start/Stop: `start_program`, `stop_program`
- Reset pointer: `reset_program_pointer`

### Tasks & Modules
- List tasks: `list_tasks`
- Backup module: `backup_module`
- List RAPID modules: `list_rapid_modules task_name:T_ROB1`
- Read RAPID variable: `get_rapid_variable task_name:T_ROB1 var_name:reg1`

### IO & Event Log
- Event log: `get_event_log category_id:0 limit:20`
- Event log categories: `get_event_log_categories`
- IO signals: `get_io_signals`
- IO signals (filtered): `get_io_signals name_filter:EXAO limit:20`

### Profiles & Creative Motion
- List robots: `list_robots`
- List presets: `list_presets robot_id:abb-crb-15000`
- Dance: `dance_two_points`, `dance_template`
- Motion memory: `get_motion_memory`, `reset_motion_memory`
