---
name: abb-robot-virtual-control
description: >
  Virtual ABB viewer operation skill. Use ONLY for the 3D kinematic viewer via
  ws-bridge simulation. For RobotStudio or physical robot control, use
  abb-robot-real-control instead — RobotStudio uses the real PC SDK plugin.
---

# ABB Virtual Control Skill

Use tool `abb_robot_virtual` only.

## Important: RobotStudio vs Virtual Viewer

This skill is for the **OpenClaw 3D kinematic viewer** (ws-bridge), NOT for RobotStudio.

| Target | Plugin to use |
|--------|---------------|
| Physical ABB robot | `abb_robot_real` |
| ABB RobotStudio | `abb_robot_real` (same PC SDK interface) |
| OpenClaw 3D viewer (ws-bridge) | `abb_robot_virtual` (this skill) |

## Required Environment

- ws-bridge running on `127.0.0.1:9877`
- `robot_kinematic_viewer.html` opened and connected
- Robot model loaded in viewer

## Standard Flow

1. Connect
`abb_robot_virtual action:connect host:127.0.0.1 port:9877 robot_id:abb-crb-15000`

2. Check
`abb_robot_virtual action:get_status`

3. Motion
`abb_robot_virtual action:movj joints:[10,-10,20,0,10,0] speed:40`

4. Return home
`abb_robot_virtual action:go_home`

5. Disconnect
`abb_robot_virtual action:disconnect`

## Notes

- This skill is for the 3D viewer simulation only — no physical robot operations.
- If movement is not visible, verify ws-bridge connection and model loading first.
- For RobotStudio, use `abb_robot_real` — it connects via ABB PC SDK just like a real robot.
