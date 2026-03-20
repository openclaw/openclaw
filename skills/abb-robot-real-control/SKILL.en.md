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
RobotStudio simulates a real ABB controller with the same PC SDK (`ABB.Robotics.Controllers`)
interface as physical hardware. Use this same plugin to connect to RobotStudio directly.

```
abb_robot_real action:scan_controllers       # discovers RobotStudio controllers on LAN
abb_robot_real action:connect host:127.0.0.1 # local RobotStudio
abb_robot_real action:get_status
```

## Standard Operation Workflow

Follow this sequence strictly. If any step fails, restart from Step 1.

```
Step 1 │ Write program   →  Compose RAPID code (from template or generated)
Step 2 │ Check           →  get_status  (verify Auto mode + MotorsOn)
Step 3 │ Download        →  load_rapid rapid_code:"..." module_name:MainModule
Step 4 │ Run             →  execute_rapid  (load + reset pointer + start + wait)
Step 5 │ Read status     →  get_status / get_joints / get_event_log
Step 6 │ Error?          →  get_event_log category_id:4 limit:10  then goto Step 1
        │ OK?             →  Notify user: "✅ Program completed successfully"
```

### Detailed Steps

**Step 1 — Write Program**
- Use RAPID template (see below) or `generate_rapid_move` action.
- Fill in joint targets, speeds, and zone values.
- Always include `ConfJ \Off; ConfL \Off;` to avoid configuration errors.

**Step 2 — Check**
```
abb_robot_real action:get_status
```
Verify: `operationMode: Auto`, `motorState: MotorsOn`, `rapidRunning: false`.
If not Auto/MotorsOn → alert user to set mode on teach pendant.

**Step 3 — Download (Load)**
```
abb_robot_real action:load_rapid rapid_code:"<RAPID_CODE>" module_name:MainModule
```

**Step 4 — Run**
```
abb_robot_real action:execute_rapid rapid_code:"<RAPID_CODE>" module_name:MainModule
```
(execute_rapid is atomic: load + reset pointer + start + wait for completion)

**Step 5 — Read Status**
```
abb_robot_real action:get_joints
abb_robot_real action:get_status
```

**Step 6 — Handle Result**
- If error → `get_event_log category_id:4 limit:10` to read RAPID program errors → fix → goto Step 1
- If success → notify user: program completed, current joints reported

## RAPID Templates

### Template A — Single / Multi Joint Move

```rapid
MODULE MainModule
  PROC main()
    ConfJ \Off;
    ConfL \Off;
    ! --- Waypoint 1: approach position ---
    VAR jointtarget p1 := [[0.0, -20.0, 20.0, 0.0, 20.0, 0.0],
                            [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
    ! --- Waypoint 2: target position ---
    VAR jointtarget p2 := [[30.0, -30.0, 30.0, 0.0, 60.0, 0.0],
                            [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
    ! speed: v100 = 100mm/s, zone: fine = stop exactly
    MoveAbsJ p1, v100, fine, tool0;
    MoveAbsJ p2, v100, fine, tool0;
    Stop;
  ENDPROC
ENDMODULE
```

### Template B — Dance Sequence (Multi-point Choreography)

```rapid
MODULE DanceModule
  ! Number of repeat cycles
  VAR num cycles := 3;

  PROC main()
    ConfJ \Off;
    ConfL \Off;
    VAR num i := 0;
    ! Home position
    VAR jointtarget home := [[0,0,0,0,0,0],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
    ! Dance waypoints
    VAR jointtarget d1 := [[30,-20,20,0,40,0],
                            [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
    VAR jointtarget d2 := [[-30,-20,20,0,40,0],
                            [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
    VAR jointtarget d3 := [[0,-30,40,0,60,0],
                            [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
    VAR jointtarget d4 := [[0,0,-10,0,10,90],
                            [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];

    ! Go to home first
    MoveAbsJ home, v200, z10, tool0;

    FOR i FROM 1 TO cycles DO
      MoveAbsJ d1, v300, z10, tool0;
      MoveAbsJ d2, v300, z10, tool0;
      MoveAbsJ d3, v400, z10, tool0;
      MoveAbsJ d4, v300, z10, tool0;
      MoveAbsJ home, v200, z10, tool0;
    ENDFOR

    Stop;
  ENDPROC
ENDMODULE
```

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

## Safety Rules

- Always verify `operationMode:Auto` and `motorState:MotorsOn` before any motion.
- Use `speed:10` or lower for first move of session on real hardware.
- Report exact controller and task errors verbatim; do not mask them.
- If `rapidRunning:true` when starting — run `stop_program` first.
