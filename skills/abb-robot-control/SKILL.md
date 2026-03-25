---
name: abb-robot-control
description: >
  ABB机器人统一控制技能（OpenClaw）。本技能为共用入口，介绍两种操作模式的区别及共用操作方法。
  真实模式（abb_robot_real）：适用于物理机器人和ABB RobotStudio虚拟控制器。
  虚拟模式（abb_robot_virtual）：适用于OpenClaw 3D运动学视图（ws-bridge）。
  详细操作流程请参考各模式专用技能文档。
metadata:
  openclaw:
    emoji: "\U0001F916"
    requires:
      bins: []
---

# ABB机器人控制技能（共用入口）

本技能是 `abb_robot` MCP 工具的共用入口，介绍两种操作模式的区别和共用方法。
详细操作流程、RAPID模板、安全规则等请参考各模式专用技能文档。

## 两种模式对比

| 特性 | 真实模式 (`abb_robot_real`) | 虚拟模式 (`abb_robot_virtual`) |
|------|---------------------------|-------------------------------|
| 适用对象 | 物理ABB机器人、ABB RobotStudio | OpenClaw 3D运动学视图 |
| 连接方式 | ABB PC SDK（控制器IP） | WebSocket（ws-bridge） |
| 支持操作 | 全部操作（运动、RAPID、IO等） | 基础操作（连接、状态、关节运动） |
| 安全要求 | 首次运动 speed:10，需检查Auto模式 | 无特殊安全要求 |
| RobotStudio | ✅ 直接支持（相同PC SDK接口） | ❌ 不适用 |

## 模式选择规则

- 物理机器人 → `abb_robot_real`
- ABB RobotStudio → `abb_robot_real`（RobotStudio 模拟真实控制器，使用相同API）
- OpenClaw 3D视图 → `abb_robot_virtual`
- 当使用统一工具 `abb_robot` 时：真实模式用 `mode:real`，虚拟模式用 `mode:virtual`
- 安全关键任务**不得**依赖 `mode:auto`

## 共用操作快速参考

以下操作在两种模式下通用（工具名替换为对应插件即可）：

### 连接管理
```
abb_robot action:scan_controllers
abb_robot action:connect host:<ip>
abb_robot action:disconnect
```

### 状态与信息
```
abb_robot action:get_status
abb_robot action:get_system_info
abb_robot action:get_service_info
abb_robot action:get_version
abb_robot action:identify_robot
```

### 关节运动
```
abb_robot action:get_joints
abb_robot action:get_world_position
abb_robot action:set_joints joints:[0,-20,20,0,20,0] speed:20
abb_robot action:movj joints:[0,-20,20,0,20,0] speed:20
abb_robot action:go_home
```

### 速度
```
abb_robot action:get_speed
abb_robot action:set_speed speed:50
```

### 机器人配置查询
```
abb_robot action:list_robots
abb_robot action:list_presets robot_id:abb-crb-15000
abb_robot action:list_sequences robot_id:abb-crb-15000
```

### 事件日志
```
abb_robot action:get_event_log category_id:0 limit:20
# category_id: 0=全部 1=操作 2=系统 3=硬件 4=程序(RAPID错误) 5=运动
abb_robot action:get_event_log_categories
```

### 运动记忆
```
abb_robot action:get_motion_memory
abb_robot action:reset_motion_memory
```

### 创意运动
```
abb_robot action:dance_two_points point_a:[0,0,0,0,0,0] point_b:[30,-20,20,0,20,0] repeat:4 speed:40
abb_robot action:dance_template template:wave amplitude:1.0 beats:8 speed:40
# 可用模板：wave、bounce、sway、twist
```

## 仅限真实模式的操作

以下操作仅在真实模式（`abb_robot_real` / `mode:real`）中可用，详见 abb-robot-real-control 技能文档：

- 笛卡尔运动：`movl`、`movc`、`movj_rapid`
- RAPID程序：`execute_rapid`、`load_rapid`、`start_program`、`stop_program`、`reset_program_pointer`
- 任务与模块：`list_tasks`、`set_preset`、`run_sequence`

<!-- @@DISABLED: 以下操作暂时禁用，AI不得执行这些操作 -->
<!-- @@DISABLED_START: 电机 / 变量与IO -->
<!--
### 电机控制（已禁用 — PC SDK DefaultUser权限不支持）
电机状态需通过示教器手动切换：
```
# motors_on / motors_off — PC SDK DefaultUser权限下始终返回错误
# 请使用FlexPendant示教器或控制器面板操作
```

### 变量与IO（已禁用）
以下操作当前被禁止执行，仅供参考：
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
<!-- @@DISABLED_END: 电机 / 变量与IO -->

## 故障排查

1. 真实机器未动作 → 检查mode是否为real
2. 真实模式连接失败 → 报告NetScan错误和已发现控制器
3. 真实模式运动被阻止 → 检查是否缺少 `safety_confirmed:true`
4. 虚拟视图无运动 → 检查ws-bridge连接和模型加载
5. 控制RobotStudio → 使用 `abb_robot_real`
