# ABB Robot Native Bridge (hw.bridge.abb)

## 简介 (Capabilities Overview)
本插件是为 OpenClaw 准备的 ABB 机器人原生通讯网关。利用此插件，基于大语言模型的 AI Agent 可以通过安全的 MCP (Model Context Protocol) 直接和局域网内的 ABB 真实物理台或虚拟示教器 (RobotStudio) 进行指令级交互。

## 核心接口 (Tool Schema)
AI 通过访问此桥接插件提供的 MCP Tools，可以下发并接收控制：
1. **获取工作状态** (`get_robot_status`, `get_joint_positions` 等）获取此时刻所有轴位的 Double 类型精确参数。
2. **安全微步移动** (`move_linear`, `move_to_joints`)。针对单一点位进行的简易、低风险动作指引。
3. **整套复杂工艺/长序列动作装载** (`execute_rapid_program`)。强烈建议 AI 对于需要长连贯或包含“舞蹈、绘图、连续穿行”指令等可能遇到（Singularity）错误的情况时，使用此方法直接输入从 `MODULE` 到 `ENDMODULE` 的完整有效 RAPID 程序。系统支持最高 30 分钟防超时护航以确保任务的彻底连续交付。

## 部署说明 
此插件包含于 OpenClaw 生态，`plugin.json` 标识了 `ABB.exe` 将作为 MCP 流入口进行 `stdio` 解析操作。使用和更新它只需覆盖至 `Plugins/hw.bridge.abb/` 目录并重启前台环境即可。
相关异常预处理指令已被提取至项目随附的 `Skills` 配置策略集中。