---
name: abb-robot-real-control
description: >
  Real ABB controller operation skill. Use for physical robot OR ABB RobotStudio
  virtual controller — both use the same PC SDK interface and this same plugin.
  Available actions: scan_controllers, connect, disconnect, get_status, get_system_info,
  get_service_info, get_speed, set_speed, get_joints, get_world_position, movj, movj_rapid,
  movl, movc, set_joints, set_preset, run_sequence, load_rapid, start_program, stop_program,
  reset_program_pointer, execute_rapid, list_tasks,
  get_rapid_variable, set_rapid_variable, get_io_signals, get_event_log,
  get_event_log_categories, list_rapid_variables, identify_robot, list_robots,
  list_presets, list_sequences.
---

# ABB Real Control Skill

Use tool `abb_robot_real` only.

## Default Assumptions (Do Not Ask Repeatedly)

When receiving a motion command, **execute directly without asking the user** about the following defaults:

- **host**: default `127.0.0.1` (local RobotStudio or real controller)
- **mode**: this plugin is always real mode, no selection needed
- **robot model**: execute directly; `get_joints` returning 6 values confirms 6-axis
- **port**: this plugin connects via ABB PC SDK, no port number needed

Only ask about host if connection fails or no controller is found.
**Do not send "pre-flight checklists" or request confirmation of known information.**

## Non-existent Parameters (Do Not Fabricate)

The following parameters **do not exist** in this plugin — do not use or suggest them:

- `allowVirtualController` — does not exist; RobotStudio and real robots connect directly without any flag
- `safety_confirmed` — does not exist; this plugin has no safety confirmation flow
- `mode:virtual` / `mode:real` — does not exist; this plugin does not distinguish modes
- Port numbers (e.g. `:7000`) — not used; ABB PC SDK connects via controller ID
- `allowRealExecution` — internal C# parameter only; MCP tool calls do not need it

If already connected to a RobotStudio controller on 127.0.0.1, execute motion commands directly without reporting any "virtual controller detection" errors.

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
Step 1 │ Write program   →  Compose RAPID code (use templates below)
Step 2 │ Check status    →  get_status (verify Auto mode + MotorsOn)
Step 3 │ Run program     →  execute_rapid (atomic: load + reset pointer + start + wait)
Step 4 │ Read status     →  get_joints / get_status
Step 5 │ Handle result   →  Error: get_event_log category_id:4 → fix → Step 1
        │                 →  OK: notify user, report current joint positions
```

### Step Details

**Step 2 — Check Status**
```
abb_robot_real action:get_status
```
Verify: `operationMode:Auto`, `motorState:MotorsOn`, `rapidRunning:false`

**Step 3 — Run Program**
```
abb_robot_real action:execute_rapid rapid_code:"<RAPID_CODE>" module_name:MainModule
```

**Step 5 — Error Handling**
```
abb_robot_real action:get_event_log category_id:4 limit:10
```
Read RAPID program errors → fix code → restart from Step 1

## RAPID Templates

### Template A — Single / Multi Joint Move

All `CONST`/`VAR jointtarget` must be declared at MODULE level (outside PROC) — RAPID syntax requirement.

```rapid
MODULE MainModule
  ! Robot: 1JiaX_ABB_6_08  Current home: [0.90, 7.17, -4.01, 0.00, 81.71, 4.11]
  CONST jointtarget home := [[0.90, 7.17, -4.01, 0.00, 81.71, 4.11],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST jointtarget wp1  := [[20.0, 7.17, -4.01, 0.00, 81.71, 4.11],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST jointtarget wp2  := [[-20.0, 7.17, -4.01, 0.00, 81.71, 4.11],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST jointtarget wp3  := [[0.0, -10.0, 15.0, 0.00, 50.0, 4.11],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  PROC main()
    ConfJ \Off;
    ConfL \Off;
    MoveAbsJ home, v50, fine, tool0;
    MoveAbsJ wp1,  v50, fine, tool0;
    MoveAbsJ wp2,  v50, fine, tool0;
    MoveAbsJ wp3,  v50, fine, tool0;
    MoveAbsJ home, v50, fine, tool0;
    Stop;
  ENDPROC
ENDMODULE
```

### Template B — Dance Choreography (Multi-point, 3 Loops)

```rapid
MODULE MainModule
  ! Dance: 4 beats per cycle, 3 repeats
  CONST jointtarget home := [[0.90, 7.17, -4.01, 0.00, 81.71, 4.11],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST jointtarget d1   := [[30.0, 7.17, -4.01, 0.00, 60.0, 4.11],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST jointtarget d2   := [[-30.0, 7.17, -4.01, 0.00, 60.0, 4.11],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST jointtarget d3   := [[0.0, -10.0, 15.0, 0.00, 50.0, 4.11],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  CONST jointtarget d4   := [[0.0, 7.17, -4.01, 0.00, 81.71, 60.0],
                              [9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];
  VAR num cycles := 3;
  PROC main()
    VAR num i;   ! VAR must be declared before all executable statements
    ConfJ \Off;
    ConfL \Off;
    MoveAbsJ home, v100, fine, tool0;
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

**RAPID syntax rules:**
- `CONST`/`VAR` joint target data → must be at MODULE level, before `PROC main()`
- Local loop counter (`VAR num i`) → must be declared at the **top of PROC**, before any executable instruction (e.g. `ConfJ \Off;`)
- Executable instructions (`MoveAbsJ`, `ConfJ`, `FOR`, etc.) → after all local declarations

## Common Operations

- System info: `get_system_info`
- Read speed: `get_speed` / Set speed: `set_speed speed:30`
- Read joints: `get_joints` / World position: `get_world_position`
- Joint motion: `movj joints:[0,-20,20,0,20,0] speed:20`
- Linear motion: `movl x:300 y:0 z:400 rx:0 ry:90 rz:0 speed:100 zone:fine`
- Circular motion: `movc circ_point:[350,100,400,0,90,0] to_point:[400,0,400,0,90,0] speed:80`
- Event log: `get_event_log category_id:0 limit:20` (category_id: 0=all 4=RAPID errors 5=motion)
- Event log categories: `get_event_log_categories`
- Reset pointer: `reset_program_pointer task_name:T_ROB1` (auto-falls back to first PROC if no main)
- Explicit: `reset_program_pointer task_name:T_ROB1 module_name:OpenClawMotionMod routine_name:AgentMoveProc`
- List tasks: `list_tasks`

## Motors / Variables & IO

<!-- @@DISABLED: The following actions are temporarily disabled — AI must NOT execute them -->
<!-- @@DISABLED_START: Motors / Variables & IO -->
<!--
### Motors (Disabled — not supported via PC SDK DefaultUser)
`motors_on` and `motors_off` always return an error in this implementation.
Toggle motor state from the FlexPendant or controller front panel instead.
```
# abb_robot_real action:motors_on   → error: not supported via DefaultUser
# abb_robot_real action:motors_off  → error: not supported via DefaultUser
```

### Variables & IO (Disabled)
The following actions are currently forbidden. For reference only:
- List IO signals: `get_io_signals`
- Filter IO signals: `get_io_signals name_filter:EXAO limit:20`
- Read RAPID variable: `get_rapid_variable task_name:T_ROB1 var_name:reg1`
- With module: `get_rapid_variable task_name:T_ROB1 module_name:MainModule var_name:myVar`
- Write RAPID variable: `set_rapid_variable task_name:T_ROB1 module_name:MainModule var_name:reg1 value:42`
- List RAPID variables: `list_rapid_variables task_name:T_ROB1`
- With module filter: `list_rapid_variables task_name:T_ROB1 module_name:MainModule limit:50`
-->
<!-- @@DISABLED_END: Motors / Variables & IO -->

## Joint Axis Count

This system connects to **6-axis robots** (e.g. IRB 120, IRB 1200).
`get_joints` always returns 6 values; `movj`/`execute_rapid` always use 6 joint angles.
**Do not add a 7th axis value; do not ask the user for 7 parameters.**

RAPID `jointtarget` format: `[[j1,j2,j3,j4,j5,j6],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]]`
The second group `[9E+09...]` is the external axis placeholder — always keep these values as-is.

## Safety Rules

- Always specify `host` explicitly when connecting.
- Use `speed:10` or lower for the first move of a session on real hardware.
- Report exact controller and task errors verbatim; do not mask them.
- If `rapidRunning:true` when starting → run `stop_program` first.
