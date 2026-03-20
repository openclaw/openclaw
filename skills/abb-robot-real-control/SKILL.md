---
name: abb-robot-real-control
description: >
  Real ABB controller operation skill. Use for physical robot OR ABB RobotStudio
  virtual controller — both use the same PC SDK interface and this same plugin.
  Enforces explicit host targeting, status verification, and safety-confirmed motion.
  Available actions: scan_controllers, connect, disconnect, get_status, get_system_info,
  get_service_info, get_speed, set_speed, get_joints, get_world_position, movj, movj_rapid,
  load_rapid, start_program, stop_program, reset_program_pointer, execute_rapid,
  get_event_log, get_event_log_categories, get_io_signals, get_rapid_variable,
  list_rapid_modules, list_tasks, backup_module, motors_on, motors_off.
---

# ABB Real Control Skill

Use tool `abb_robot_real` only.

## RobotStudio Support

**Controlling ABB RobotStudio with this plugin is fully supported.**
RobotStudio simulates a real ABB controller using the same PC SDK (`ABB.Robotics.Controllers`)
as physical hardware. No special configuration is needed — just connect to the RobotStudio
controller IP the same way you would connect to a real robot.

Example:
```
abb_robot_real action:scan_controllers           # finds RobotStudio controllers on network
abb_robot_real action:connect host:127.0.0.1     # or LAN IP of RobotStudio machine
abb_robot_real action:get_status
```

## Execution Sequence (Strict)

1. Discover controllers
`abb_robot_real action:scan_controllers`

2. Connect to explicit host
`abb_robot_real action:connect host:<controller-ip>`

3. Verify state before motion
`abb_robot_real action:get_status`

4. Run low-speed validation move
`abb_robot_real action:movj joints:[0,-20,20,0,20,0] speed:10 zone:fine`

## Core Operations

- System info: `get_system_info`
- Service info: `get_service_info`
- Read speed: `get_speed`
- Set speed: `set_speed speed:30`
- Read joints: `get_joints`
- World pose: `get_world_position`
- Event log: `get_event_log category_id:0 limit:20`
- Event log categories: `get_event_log_categories`
- Backup module: `backup_module module_name:<name> output_dir:<path>`
- Reset pointer: `reset_program_pointer task_name:T_ROB1`
- List tasks: `list_tasks`

## IO & RAPID Variables

- List IO signals: `get_io_signals`
- Filter IO signals: `get_io_signals name_filter:EXAO limit:20`
- Read RAPID variable: `get_rapid_variable task_name:T_ROB1 var_name:reg1`
- Read from module: `get_rapid_variable task_name:T_ROB1 module_name:MainModule var_name:myVar`
- List RAPID modules: `list_rapid_modules task_name:T_ROB1`

## RAPID Operations

- Load: `load_rapid rapid_code:"..." module_name:MainModule`
- Execute end-to-end: `execute_rapid rapid_code:"..."`
- Start: `start_program`
- Stop: `stop_program`

## Safety Rules

- Require explicit host for all connect operations.
- Use `speed:10` or lower for first move of session.
- Report exact controller and task errors verbatim; do not mask them.
- For physical robots, verify `operationMode:Auto` and `motorState:MotorsOn` before motion.
