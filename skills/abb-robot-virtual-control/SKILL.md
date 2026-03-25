---
name: abb-robot-virtual-control
description: >
  ABB虚拟视图操作技能。仅适用于通过ws-bridge的3D运动学视图仿真工作流。
  不支持物理机器人操作。如需控制RobotStudio或真实机器人，请使用abb-robot-real-control技能。
  支持操作：connect、disconnect、get_status、get_joints、set_joints、movj、go_home、list_robots、get_version。
---

# ABB虚拟控制技能

仅使用工具 `abb_robot_virtual`。

## 重要说明：RobotStudio vs 虚拟视图

本技能适用于**OpenClaw 3D运动学视图**（ws-bridge），**不适用于RobotStudio**。

| 目标 | 使用插件 |
|------|----------|
| 物理ABB机器人 | `abb_robot_real` |
| ABB RobotStudio | `abb_robot_real`（相同PC SDK接口） |
| OpenClaw 3D视图（ws-bridge） | `abb_robot_virtual`（本技能） |

## 所需环境

- ws-bridge运行于 `127.0.0.1:9877`
- 已打开并连接 `robot_kinematic_viewer.html`
- 视图中已加载机器人模型

## 标准流程

1. 连接
`abb_robot_virtual action:connect host:127.0.0.1 port:9877 robot_id:abb-crb-15000`

2. 检查状态
`abb_robot_virtual action:get_status`

3. 运动
`abb_robot_virtual action:movj joints:[10,-10,20,0,10,0] speed:40`

4. 回原点
`abb_robot_virtual action:go_home`

5. 断开连接
`abb_robot_virtual action:disconnect`

## 注意事项

- 本技能仅用于3D视图仿真，不执行物理机器人操作。
- 如运动不可见，首先检查ws-bridge连接和模型加载状态。
- 如需控制RobotStudio，请使用 `abb_robot_real`——RobotStudio通过ABB PC SDK连接，与真实机器人使用相同插件。
