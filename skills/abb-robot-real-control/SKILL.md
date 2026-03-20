---
name: abb-robot-real-control
description: >
  ABB真实控制器操作技能。适用于物理机器人或ABB RobotStudio虚拟控制器——两者使用相同PC SDK接口和同一插件。
  支持操作：scan_controllers、connect、disconnect、get_status、get_system_info、get_service_info、
  get_speed、set_speed、get_joints、get_world_position、movj、movj_rapid、load_rapid、execute_rapid、
  start_program、stop_program、reset_program_pointer、get_event_log、get_event_log_categories、
  get_io_signals、get_rapid_variable、list_rapid_modules、list_tasks、backup_module、motors_on、motors_off。
---

# ABB真实控制技能

仅使用工具 `abb_robot_real`。

## RobotStudio支持

**使用本插件控制ABB RobotStudio完全可行。**
RobotStudio通过相同的PC SDK模拟真实ABB控制器，接口完全一致，无需特殊配置。

```
abb_robot_real action:scan_controllers       # 发现RobotStudio控制器
abb_robot_real action:connect host:127.0.0.1 # 连接本机RobotStudio
abb_robot_real action:get_status
```

## 标准操作流程

严格按顺序执行，任一步骤失败则从第1步重新开始。

```
第1步 编写程序  →  准备RAPID代码（使用下方模板）
第2步 检查状态  →  get_status（验证Auto模式 + 电机已上电）
第3步 下载程序  →  load_rapid rapid_code:"..."
第4步 运行程序  →  execute_rapid（原子：加载+重置+启动+等待完成）
第5步 读取状态  →  get_joints / get_status
第6步 结果处理  →  错误：get_event_log category_id:4 → 修复 → 第1步
               →  正常：通知用户完成，输出当前关节位置
```

### 各步骤说明

**第2步 — 检查状态**
```
abb_robot_real action:get_status
```
验证：`operationMode:Auto`、`motorState:MotorsOn`、`rapidRunning:false`

**第3步 — 下载程序**
```
abb_robot_real action:load_rapid rapid_code:"<RAPID代码>" module_name:MainModule
```

**第4步 — 运行程序**
```
abb_robot_real action:execute_rapid rapid_code:"<RAPID代码>" module_name:MainModule
```

**第6步 — 错误处理**
```
abb_robot_real action:get_event_log category_id:4 limit:10
```
读取RAPID程序错误 → 修复代码 → 从第1步重新开始

## RAPID程序模板

### 模板A — 单/多关节运动

所有 `CONST/VAR jointtarget` 必须在模块级（PROC外）声明，这是RAPID语法要求。

```
MODULE MainModule
  ! 机器人：1JiaX_ABB_6_08  当前原点：[0.90, 7.17, -4.01, 0.00, 81.71, 4.11]
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

### 模板B — 舞蹈编排（多点序列，3次循环）

```
MODULE MainModule
  ! 舞蹈编排：4拍循环，3次重复
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
    VAR num i;   ! VAR必须在所有可执行语句前声明
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

## 常用操作

- 系统信息：`get_system_info`
- 读取速度：`get_speed` / 设置速度：`set_speed speed:30`
- 读取关节：`get_joints` / 世界坐标：`get_world_position`
- 事件日志：`get_event_log category_id:0 limit:20`
- 事件日志分类：`get_event_log_categories`
- 备份模块：`backup_module module_name:<名称> output_dir:<路径>`
- 重置指针：`reset_program_pointer task_name:T_ROB1`
- 列出任务：`list_tasks`

## IO与RAPID变量

- 列出IO信号：`get_io_signals`
- 过滤IO信号：`get_io_signals name_filter:EXAO limit:20`
- 读取RAPID变量：`get_rapid_variable task_name:T_ROB1 var_name:reg1`
- 指定模块：`get_rapid_variable task_name:T_ROB1 module_name:MainModule var_name:myVar`
- 列出RAPID模块：`list_rapid_modules task_name:T_ROB1`

## 安全规则

- 连接操作必须明确指定host
- 真实硬件首次运动使用 `speed:10` 或更低
- 控制器和任务错误原文报告，不做屏蔽
- 若 `rapidRunning:true` 则先运行 `stop_program`
