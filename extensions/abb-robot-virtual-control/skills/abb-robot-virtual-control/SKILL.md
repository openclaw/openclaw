---
name: abb-robot-virtual-control
description: Virtual ABB viewer control skill for abb_robot_virtual.
---

# ABB Robot Virtual Control

Use tool abb_robot_virtual.

## Scope

- OpenClaw 3D viewer workflows over ws-bridge
- Not for RobotStudio or physical controller motion

## Standard flow

1. connect (host/port/robot_id)
2. get_status
3. movj or set_joints
4. go_home
5. disconnect

## Notes

- Default ws-bridge endpoint is 127.0.0.1:9877.
- If movement is not visible, verify viewer registration and ws connection.
