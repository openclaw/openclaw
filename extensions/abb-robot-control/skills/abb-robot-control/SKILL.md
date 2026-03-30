---
name: abb-robot-control
description: Unified ABB robot control skill for the abb_robot tool.
---

# ABB Robot Control (Unified)

Use tool abb_robot.

## Mode selection

- Use mode: real for physical ABB controllers and RobotStudio virtual controllers.
- Use mode: virtual for OpenClaw 3D viewer with ws-bridge.
- Do not rely on mode: auto for safety-critical operations.

## Standard flow

1. connect
2. get_status
3. get_joints
4. movj or go_home
5. get_joints

## Common actions

- scan_controllers
- connect / disconnect
- get_status / get_system_info / get_service_info
- get_joints / set_joints / movj / go_home
- execute_rapid / load_rapid / start_program / stop_program
