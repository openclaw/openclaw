---
name: abb-robot-real-control
description: >
  ABB真实控制器操作技能。适用于物理机器人或ABB RobotStudio虚拟控制器——两者使用相同PC SDK接口和同一插件。
  支持操作：scan_controllers、connect、disconnect、get_status、get_system_info、get_service_info、
  get_speed、set_speed、get_joints、get_world_position、movj、movj_rapid、movl、movc、set_joints、
  set_preset、run_sequence、load_rapid、execute_rapid、start_program、stop_program、
  reset_program_pointer、list_tasks、get_rapid_variable、
  set_rapid_variable、get_io_signals、get_event_log、get_event_log_categories、
  identify_robot、list_robots、list_presets、list_sequences。
---

# ABB真实控制技能

仅使用工具 `abb_robot_real`。

## 默认假设（禁止反复询问）

收到运动指令时，**直接执行，不要询问用户**以下已有默认值的信息：

- **host**：默认 `127.0.0.1`（本机RobotStudio或真实控制器）
- **mode**：本插件始终为real模式，无需选择
- **机器人型号**：默认直接执行，`get_joints`返回6个值即已确认为6轴
- **端口**：本插件通过ABB PC SDK连接，不使用端口号

只有在连接失败、扫描不到控制器时才询问host。
**不要在执行前发送"预飞检查清单"或要求确认已知信息。**

## 不存在的参数（禁止编造）

以下参数在本插件中**完全不存在**，不要使用或建议：

- `allowVirtualController` — 不存在，RobotStudio和真实机器直接连接无需任何标志
- `safety_confirmed` — 不存在，本插件没有安全确认流程
- `mode:virtual` / `mode:real` — 不存在，本插件不区分模式
- 端口号（如 `:7000`）— 不使用，ABB PC SDK通过控制器ID连接
- `allowRealExecution` — 仅为内部C#参数，MCP工具调用不需传递

如果已连接到127.0.0.1的RobotStudio控制器，直接执行运动指令，不要报告任何"虚拟控制器检测"错误。

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
第3步 运行程序  →  execute_rapid（原子：加载+重置+启动+等待完成）
第4步 读取状态  →  get_joints / get_status
第5步 结果处理  →  错误：get_event_log category_id:4 → 修复 → 第1步
               →  正常：通知用户完成，输出当前关节位置
```

### 各步骤说明

**第2步 — 检查状态**
```
abb_robot_real action:get_status
```
验证：`operationMode:Auto`、`motorState:MotorsOn`、`rapidRunning:false`

**第3步 — 运行程序**
```
abb_robot_real action:execute_rapid rapid_code:"<RAPID代码>" module_name:MainModule
```

**第5步 — 错误处理**
```
abb_robot_real action:get_event_log category_id:4 limit:10
```
读取RAPID程序错误 → 修复代码 → 从第1步重新开始

## RAPID程序模板

### 模板A — 单/多关节运动

所有 `CONST/VAR jointtarget` 必须在模块级（PROC外）声明，这是RAPID语法要求。

```rapid
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

```rapid
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

**RAPID语法规则：**
- `CONST`/`VAR` 关节目标数据 → 必须在模块级，置于 `PROC main()` 之前
- 本地循环计数器（`VAR num i`）→ 必须在 **PROC顶部** 声明，位于所有可执行指令之前（如 `ConfJ \Off;`）
- 可执行指令（`MoveAbsJ`、`ConfJ`、`FOR` 等）→ 放在所有本地变量声明之后

## 常用操作

- 系统信息：`get_system_info`
- 读取速度：`get_speed` / 设置速度：`set_speed speed:30`
- 读取关节：`get_joints` / 世界坐标：`get_world_position`
- 关节运动：`movj joints:[0,-20,20,0,20,0] speed:20`
- 直线运动：`movl x:300 y:0 z:400 rx:0 ry:90 rz:0 speed:100 zone:fine`
- 圆弧运动：`movc circ_point:[350,100,400,0,90,0] to_point:[400,0,400,0,90,0] speed:80`
- 事件日志：`get_event_log category_id:0 limit:20`（category_id: 0=全部 4=RAPID错误 5=运动）
- 事件日志分类：`get_event_log_categories`
- 重置指针：`reset_program_pointer task_name:T_ROB1`（无main时自动回退到已加载模块的第一个PROC）
- 明确指定：`reset_program_pointer task_name:T_ROB1 module_name:OpenClawMotionMod routine_name:AgentMoveProc`
- 列出任务：`list_tasks`

## 电机 / IO与RAPID变量

<!-- @@DISABLED: 以下操作暂时禁用，AI不得执行这些操作 -->
<!-- @@DISABLED_START: 电机 / 变量与IO -->
<!--
### 电机控制（已禁用 — PC SDK DefaultUser权限不支持）
`motors_on` 和 `motors_off` 在当前实现中始终返回错误。
请通过FlexPendant示教器或控制器面板手动切换电机状态。
```
# abb_robot_real action:motors_on   → 错误：DefaultUser权限不支持
# abb_robot_real action:motors_off  → 错误：DefaultUser权限不支持
```

### 变量与IO（已禁用）
以下操作当前被禁止执行，仅供参考：
- 列出IO信号：`get_io_signals`
- 过滤IO信号：`get_io_signals name_filter:EXAO limit:20`
- 读取RAPID变量：`get_rapid_variable task_name:T_ROB1 var_name:reg1`
- 指定模块：`get_rapid_variable task_name:T_ROB1 module_name:MainModule var_name:myVar`
- 写入RAPID变量：`set_rapid_variable task_name:T_ROB1 module_name:MainModule var_name:reg1 value:42`
- 列出RAPID变量：`list_rapid_variables task_name:T_ROB1`
- 指定模块过滤：`list_rapid_variables task_name:T_ROB1 module_name:MainModule limit:50`
-->
<!-- @@DISABLED_END: 电机 / 变量与IO -->

## 关节轴数说明

本系统连接的机器人为 **6轴机器人**（如 IRB 120、IRB 1200 等）。
`get_joints` 始终返回6个值，`movj`/`execute_rapid` 始终使用6个关节角度。
**不要补第7轴，不要要求用户提供7个参数。**

RAPID jointtarget 格式：`[[j1,j2,j3,j4,j5,j6],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]]`
第二组 `9E+09` 是外部轴占位符，固定不变，不是第7轴。

## 安全规则

- 连接操作必须明确指定host
- 真实硬件首次运动使用 `speed:10` 或更低
- 控制器和任务错误原文报告，不做屏蔽
- 若 `rapidRunning:true` 则先运行 `stop_program`
