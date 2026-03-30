---
name: abb-robot-real-control
description: Real ABB controller skill for abb_robot_real.
---

# ABB Robot Real Control

Use tool abb_robot_real.

## Scope

- Physical ABB controllers
- ABB RobotStudio virtual controllers (same PC SDK path)

## Standard flow

1. scan_controllers
2. connect (host)
3. get_status
4. movj or execute_rapid
5. get_joints and get_event_log if needed

## Notes

- Keep first movement speed conservative.
- Report controller errors verbatim.
- If rapidRunning is true, stop_program before starting a new sequence.
