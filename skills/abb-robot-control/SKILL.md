---
name: abb-robot-control
description: >
  ABB机器人统一控制技能（OpenClaw）。适用于3D虚拟视图、RobotStudio虚拟控制器和真实ABB控制器。
  支持操作：connect、disconnect、scan_controllers、get_status、get_system_info、get_service_info、
  get_joints、get_world_position、get_speed、set_speed、movj、movj_rapid、go_home、execute_rapid、
  load_rapid、start_program、stop_program、reset_program_pointer、list_tasks、backup_module、
  get_event_log、get_event_log_categories、motors_on、motors_off、get_rapid_variable、
  get_io_signals、list_rapid_modules、dance_two_points、dance_template。
metadata:
  openclaw:
    emoji: "\U0001F916"
    requires:
      bins: []
---

# ABB机器人控制技能

本技能是 `abb_robot` MCP工具的执行规范。

## RobotStudio与真实控制器说明

**使用真实机器人插件控制ABB RobotStudio完全可行。**
ABB RobotStudio在PC SDK层面模拟真实控制器，与物理硬件使用完全相同的API接口。
用户需要控制RobotStudio时，直接使用真实机器人插件，无需任何特殊配置：

```
abb_robot_real action:scan_controllers       # 发现局域网内RobotStudio控制器
abb_robot_real action:connect host:127.0.0.1 # 连接本机RobotStudio
abb_robot_real action:get_status
```

## 操作规则

- 真实机器人和RobotStudio：始终明确使用 `mode:real`
- 3D视图仿真（ws-bridge）：始终明确使用 `mode:virtual`
- 安全关键任务不得依赖 `mode:auto`
- 物理运动指令前必须包含 `safety_confirmed:true`
- 未经用户明确确认，不得在真实硬件上执行 `execute_rapid`

## 最小安全操作模式

### 真实机器人 / RobotStudio

```
abb_robot action:connect mode:real host:<控制器IP>
abb_robot action:get_status mode:real
abb_robot action:movj mode:real safety_confirmed:true joints:[0,-20,20,0,20,0] speed:10
```

### 虚拟视图（ws-bridge）

```
abb_robot action:connect mode:virtual host:127.0.0.1 port:9877
abb_robot action:movj mode:virtual joints:[30,-20,55,15,25,10] speed:40
```

## 故障排查

1. 真实机器未动作 → 检查mode是否为real
2. 真实模式连接失败 → 报告NetScan错误和已发现控制器
3. 真实模式运动被阻止 → 检查是否缺少 `safety_confirmed:true`
4. 虚拟视图无运动 → 检查ws-bridge连接和模型加载
5. 控制RobotStudio → 使用 `abb_robot_real`

## 操作快速参考

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
```

### 关节与运动
```
abb_robot action:get_joints
abb_robot action:get_world_position
abb_robot action:movj joints:[0,-20,20,0,20,0] speed:20
abb_robot action:movj_rapid joints:[0,-20,20,0,20,0] speed:20 zone:fine
abb_robot action:go_home
```

### 速度与电机
```
abb_robot action:get_speed
abb_robot action:set_speed speed:50
abb_robot action:motors_on
abb_robot action:motors_off
```

### RAPID程序
```
abb_robot action:load_rapid rapid_code:"MODULE MainModule\n  PROC main()\n    Stop;\n  ENDPROC\nENDMODULE"
abb_robot action:execute_rapid rapid_code:"..."
abb_robot action:start_program
abb_robot action:stop_program
abb_robot action:reset_program_pointer task_name:T_ROB1
```

### 任务与模块
```
abb_robot action:list_tasks
abb_robot action:backup_module module_name:MainModule output_dir:C:/backup
abb_robot action:list_rapid_modules task_name:T_ROB1
abb_robot action:get_rapid_variable task_name:T_ROB1 var_name:reg1
```

### IO与事件日志
```
abb_robot action:get_event_log category_id:0 limit:20
abb_robot action:get_event_log_categories
abb_robot action:get_io_signals
abb_robot action:get_io_signals name_filter:EXAO limit:20
```

### 创意运动
```
abb_robot action:dance_two_points point_a:[0,0,0,0,0,0] point_b:[30,-20,20,0,20,0] repeat:4 speed:40
abb_robot action:dance_template template:wave amplitude:1.0 beats:8 speed:40
```
