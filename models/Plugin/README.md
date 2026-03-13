# OpenClaw Robot Kinematic Viewer Plugin

> 通过自然语言聊天控制 3D 机器人运动学查看器，支持同时控制多台机器人。

---

## 目录

1. [功能概述](#功能概述)
2. [系统架构](#系统架构)
3. [目录结构](#目录结构)
4. [环境要求](#环境要求)
5. [快速开始](#快速开始)
6. [机器人配置文件](#机器人配置文件)
7. [XML 配置转换工具](#xml-配置转换工具)
8. [WebSocket 协议](#websocket-协议)
9. [MCP 工具 robot_control](#mcp-工具-robot_control)
10. [多机器人同时控制](#多机器人同时控制)
11. [自动连接识别](#自动连接识别)
12. [内置预设与动作序列](#内置预设与动作序列)
13. [ABB CRB 15000 关节参数](#abb-crb-15000-关节参数)
14. [添加新机器人](#添加新机器人)
15. [常见问题](#常见问题)

---

## 功能概述

| 功能 | 说明 |
|------|------|
| 自然语言控制 | 通过聊天发送指令，如"让机器人挥手"、"执行巡检序列" |
| 多机器人同步 | 在浏览器中同时打开多个查看器标签，可独立或同步控制多台机器人 |
| 自动连接识别 | 查看器连接时自动上报机器人型号，与 robots/ 目录中的配置文件自动匹配 |
| 关节安全验证 | 所有关节角度在发送前经过范围校验，超限自动截断并告知用户 |
| XML 转 JSON  | Python 工具将 rlkin/rlmdl XML 精确转换为插件 JSON，含逐字段完整校验 |
| 一键打包 EXE | build_exe.bat 调用 PyInstaller，生成免安装单文件可执行程序 |
| 实时状态监控 | HTTP GET http://127.0.0.1:9877/status 返回所有已连接机器人的实时状态 |
| 内置动作库   | 挥手、跳舞、点头、巡检等预设序列，支持自定义扩展 |

---

## 系统架构

```
+--------------------------------------------------+
|              OpenClaw 聊天对话                     |
|  "让机器人挥手" / "同时控制两台机器人跳舞"            |
+--------------------+-----------------------------+
                     | MCP 工具调用
                     v
+--------------------------------------------------+
|           robot_control 工具                      |
|      (src/robot-kinematic-tool.ts)               |
|  - 解析动作指令                                    |
|  - 从 robots/*.json 加载机器人配置                  |
|  - 验证并截断关节值                                 |
|  - 路由到目标机器人实例                              |
+--------------------+-----------------------------+
                     | 内部调用
                     v
+--------------------------------------------------+
|        WebSocket 桥接服务器  port:9877             |
|           (src/ws-bridge.ts)                     |
|  - 维护 per-robot 会话注册表                        |
|  - HTTP /status 实时状态                           |
|  - N:N 多机器人多实例路由                           |
+----------+-----------+-----------+---------------+
           |           |           |
     WS    |     WS    |     WS    |
           v           v           v
  +----------+  +----------+  +----------+
  | 浏览器   |  | 浏览器   |  | 浏览器   |
  | 标签 1   |  | 标签 2   |  | 标签 3   |
  | CRB15000 |  | CRB15000 |  | 其他机器人|
  +----------+  +----------+  +----------+
```

### 核心设计原则

- **会话注册**：每个查看器标签打开后向桥接服务器发送 `register` 消息，声明 `robotId` 与唯一 `instanceId`。
- **配置自动匹配**：桥接服务器根据 `robotId` 在 `robots/` 目录中查找同名 JSON 配置，连接状态包含 `configFound` 字段。
- **多级路由**：命令可定向到「特定实例」、「同类型全部实例」或「全部已连接机器人」。
- **安全截断**：关节值在 `robot-config-loader.ts` 按配置文件限制进行截断，截断信息明确反馈给用户。

---

## 目录结构

```
models/Plugin/
+-- README.md                      <- 本文档
+-- index.ts                       <- OpenClaw 扩展入口
+-- package.json                   <- 插件包声明
+-- openclaw.plugin.json           <- 插件元数据
+-- convert_robots.bat             <- 一键批量转换所有机器人 XML
+-- build_exe.bat                  <- 一键打包 convert_robot_xml.exe
|
+-- robots/
|   +-- robot-config.schema.json   <- JSON Schema 验证格式
|   +-- abb-crb-15000.json         <- ABB CRB 15000 配置（由 XML 生成）
|
+-- src/
|   +-- robot-config-loader.ts     <- 配置加载、验证、截断
|   +-- robot-kinematic-tool.ts    <- MCP 代理工具 robot_control
|   +-- ws-bridge.ts               <- 多机器人 WebSocket 桥接服务器
|
+-- tools/
|   +-- convert_robot_xml.py       <- Python XML->JSON 转换脚本
|
+-- docs/
    +-- robot-config-format.md     <- 配置文件格式详解
    +-- websocket-protocol.md      <- WebSocket 消息协议参考
```

---

## 环境要求

| 组件 | 最低版本 | 用途 |
|------|----------|------|
| Node.js | 22+ | 运行桥接服务器 |
| Bun | 1.0+ | 推荐运行时（启动更快） |
| Python | 3.8+ | 仅用于 XML 转换工具 |
| PyInstaller | 6.0+ | 仅用于打包 exe（可选） |
| 现代浏览器 | Chrome/Edge/Firefox | 查看器需 WebSocket + WebGL |

---

## 快速开始

### 第一步：安装依赖

```bash
cd models/Plugin
pnpm install   # 或 npm install / bun install
```

### 第二步：启动 WebSocket 桥接服务器

桥接服务器需要持续运行，是查看器与 MCP 工具的通信中枢。

```bash
# 推荐：Bun
bun src/ws-bridge.ts

# 或 Node.js + tsx
node --import tsx src/ws-bridge.ts

# 自定义端口（默认 9877）
bun src/ws-bridge.ts 9878
```

启动成功输出：

```
[bridge] listening on ws://127.0.0.1:9877
[bridge] status: http://127.0.0.1:9877/status
[bridge] known configs: abb-crb-15000
```

### 第三步：打开查看器

1. 用浏览器打开 `models/robot_kinematic_viewer.html`
2. 左侧面板设置：地址 `127.0.0.1`，端口 `9877`
3. 点击 **Connect（连接）** 按钮
4. 拖放 GLB 模型文件（如 `ABB-CRB-15000.glb`）到查看器

连接成功后桥接服务器输出：
```
[bridge] registered  robot=abb-crb-15000  instance=tab-xxxx  configFound=true  total=1
```

### 第四步：安装插件

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "plugins": [
    { "path": "./models/Plugin" }
  ]
}
```

或通过 CLI：

```bash
openclaw plugin install ./models/Plugin
```

### 第五步：开始对话控制

```
让机器人挥手
执行巡检序列
将关节 1 设置为 90 度
回到初始位置
跳舞！
查看所有连接的机器人
```

---

## 机器人配置文件

每台机器人对应 `robots/<id>.json` 一个文件，格式由 `robots/robot-config.schema.json` 定义。

### 完整字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `id` | string | Y | 唯一标识（kebab-case），用于 WebSocket 注册匹配 |
| `version` | string | Y | 配置版本号 |
| `manufacturer` | string | Y | 制造商 |
| `model` | string | Y | 型号 |
| `description` | string | N | 描述信息 |
| `dof` | integer | Y | 自由度数量 |
| `mechanismType` | string | Y | `serial_6dof` / `serial` / `delta` / `scara` |
| `glbFile` | string | N | GLB 文件名（相对于配置文件） |
| `joints` | array | Y | 关节配置数组（见下表） |
| `dhParameters` | array | Y | DH 参数数组 |
| `linkOffsets` | array | N | 连杆偏移（来自 rlmdl XML） |
| `gravity` | [x,y,z] | N | 重力矢量，单位 m/s² |
| `presets` | object | N | 命名关节角度预设 |
| `sequences` | object | N | 命名运动序列 |

### 关节字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `index` | int | 关节序号（0 起） |
| `id` | string | 关节 ID |
| `label` | string | 显示名称 |
| `type` | string | `revolute`（转动）/ `prismatic`（平移） |
| `min` | number | 最小角度（度） |
| `max` | number | 最大角度（度） |
| `speed` | number | 最大速度（°/s） |
| `home` | number | 零位角度（度） |
| `axis` | [x,y,z] | 转轴方向 |
| `unit` | string | `deg` / `rad` / `mm` / `m` |

---

## XML 配置转换工具

### 工具说明

`tools/convert_robot_xml.py` 从 ABB 机器人的 `rlkin`（运动学）和 `rlmdl`（动力学）XML 文件中
提取所有关节参数，生成符合插件格式的 JSON 配置，并执行逐字段完整校验。

**数据来源映射：**

| XML 源字段 | JSON 目标字段 | 说明 |
|-----------|-------------|------|
| `<revolute>/<min>` | `joints[i].min` | 关节最小角度 |
| `<revolute>/<max>` | `joints[i].max` | 关节最大角度 |
| `<revolute>/<speed>` | `joints[i].speed` | 最大速度 |
| `<dh>/<d>` | `dhParameters[i].d` | DH 参数 d |
| `<dh>/<theta>` | `dhParameters[i].theta` | DH 参数 theta |
| `<dh>/<a>` | `dhParameters[i].a` | DH 参数 a |
| `<dh>/<alpha>` | `dhParameters[i].alpha` | DH 参数 alpha |
| `<fixed>/<translation>` | `linkOffsets[i].translation` | 连杆偏移（rlmdl） |
| `<world>/<g>` | `gravity` | 重力矢量（rlmdl） |

### 命令行用法

```bash
# 方式一：自动扫描机器人目录（含 rlkin/ 和 rlmdl/ 子目录）
python tools/convert_robot_xml.py \
    --robot-dir "../ABB Robot/CRB-15000" \
    --out robots/abb-crb-15000.json \
    --robot-id abb-crb-15000 \
    --glb ABB-CRB-15000.glb \
    --presets --verify

# 方式二：明确指定 XML 文件路径
python tools/convert_robot_xml.py \
    --rlkin "../ABB Robot/CRB-15000/rlkin/abb-crb-15000.xml" \
    --rlmdl "../ABB Robot/CRB-15000/rlmdl/abb-crb-15000.xml" \
    --out robots/abb-crb-15000.json --presets --verify
```

### 参数说明

| 参数 | 说明 |
|------|------|
| `--robot-dir` | 包含 rlkin/ 和 rlmdl/ 子目录的机器人目录 |
| `--rlkin` | rlkin XML 文件路径（与 --robot-dir 二选一）|
| `--rlmdl` | rlmdl XML 文件路径（与 --robot-dir 二选一）|
| `--out` | 输出 JSON 文件路径（必填）|
| `--robot-id` | 机器人 ID（默认取输出文件名）|
| `--glb` | GLB 模型文件名 |
| `--presets` | 生成预设和运动序列（默认开启）|
| `--no-presets` | 不生成预设和序列 |
| `--verify` | 生成后立即校验每个关节和 DH 参数 |

### 一键批量转换（Windows）

双击运行 `convert_robots.bat`，自动扫描 `../ABB Robot/` 下所有含 rlkin/rlmdl 的子目录并批量转换：

```
models/
+-- Plugin/
|   +-- convert_robots.bat   <- 双击运行
+-- ABB Robot/
    +-- CRB-15000/
    |   +-- rlkin/abb-crb-15000.xml
    |   +-- rlmdl/abb-crb-15000.xml
    +-- IRB-1200/              <- 将自动处理
    |   +-- rlkin/irb-1200.xml
    |   +-- rlmdl/irb-1200.xml
    ...
```

### 打包为单文件 EXE

双击 `build_exe.bat`，自动安装 PyInstaller 并打包：

```
双击 build_exe.bat
  --> 自动检测 Python
  --> 安装 PyInstaller（如未安装）
  --> 打包 tools/convert_robot_xml.py
  --> 输出 dist/convert_robot_xml.exe
```

打包后可在无 Python 环境的机器上直接使用：

```cmd
dist\convert_robot_xml.exe --robot-dir "ABB Robot\CRB-15000" --out robots\abb-crb-15000.json --verify
```

### 校验输出示例

```
Converting: abb-crb-15000.xml + abb-crb-15000.xml -> robots/abb-crb-15000.json
  Robot: ABB CRB 15000 (6 joints)
    joint0: [-180.0, 180.0] speed=250.0 dh={d:0.0, theta:0.0, a:0.0, alpha:0.0}
    joint3: [-225.0, 85.0]  speed=320.0 dh={d:0.0, theta:0.0, a:10.0, alpha:0.0}
  Written: robots/abb-crb-15000.json (9640 bytes)

--- Verification ---
  OK   joint0 (joint0): min=-180.0 max=180.0 speed=250.0
  OK   joint3 (joint3): min=-225.0 max=85.0  speed=320.0
  OK   DH joint3: d=0.0 theta=0.0 a=10.0 alpha=0.0
  ALL CHECKS PASSED
```

---

## WebSocket 协议

### 连接流程

```
查看器打开
    |
    +-- 连接到 ws://127.0.0.1:9877
    |
    +-- 发送 register 消息
    |   { cmd:"register", robotId:"abb-crb-15000", instanceId:"tab-uuid" }
    |
    +-- 收到 registered 确认
    |   { cmd:"registered", robotId, instanceId, configFound:true,
    |     manufacturer:"ABB", model:"CRB 15000", dof:6,
    |     totalConnected:1, knownRobots:["abb-crb-15000"] }
    |
    +-- 开始接收控制命令
```

### 消息格式

#### 查看器 -> 桥接服务器

| 消息 | 格式 | 说明 |
|------|------|------|
| 注册 | `{cmd:"register", robotId, instanceId}` | 打开连接后立即发送 |
| 关节回报 | `{cmd:"joints", joints:[j0,j1,...]}` | 响应 get_joints 请求 |
| 确认 | `{cmd:"ok"}` | 通用操作确认 |

#### 桥接服务器 -> 查看器

| 消息 | 格式 | 说明 |
|------|------|------|
| 注册确认 | `{cmd:"registered", configFound, ...}` | 注册成功响应 |
| 设置关节 | `{cmd:"set_joints", joints:[j0,...,j5]}` | 移动到指定关节角度 |
| 回零位 | `{cmd:"home"}` | 所有关节回到 home 位置 |
| 查询关节 | `{cmd:"get_joints"}` | 请求当前关节角度 |

### HTTP 状态接口

```
GET http://127.0.0.1:9877/status
```

返回示例：

```json
{
  "connected": [
    {
      "robotId": "abb-crb-15000",
      "instanceId": "tab-1234",
      "manufacturer": "ABB",
      "model": "CRB 15000",
      "dof": 6,
      "connectedAt": "2026-03-12T10:00:00.000Z",
      "lastSeen": "2026-03-12T10:05:30.000Z",
      "joints": [0, -30, 60, 0, 30, 0]
    }
  ],
  "knownRobots": ["abb-crb-15000"],
  "totalSessions": 1
}
```

---

## MCP 工具 robot_control

插件向 OpenClaw 注册一个名为 `robot_control` 的代理工具，AI 通过调用此工具控制机器人。

### 支持的 action

| action | 说明 | 关键参数 |
|--------|------|----------|
| `set_joints` | 设置关节角度 | `joints:[j0..j5]`, `robot_id?`, `instance_id?` |
| `set_preset` | 应用命名预设 | `preset`, `robot_id?`, `instance_id?` |
| `run_sequence` | 执行运动序列 | `sequence`, `robot_id?`, `instance_id?` |
| `go_home` | 回到零位 | `robot_id?`, `instance_id?` |
| `get_state` | 查询当前关节状态 | `robot_id?`, `instance_id?` |
| `list_robots` | 列出已知配置和已连接查看器 | — |
| `list_connections` | 列出所有活跃连接详情 | — |
| `list_presets` | 列出指定机器人的预设 | `robot_id?` |
| `list_sequences` | 列出指定机器人的序列 | `robot_id?` |

### 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 必填，操作类型 |
| `robot_id` | string | 目标机器人 ID，如 `abb-crb-15000`；省略时自动选择首个连接 |
| `instance_id` | string | 目标特定查看器实例；省略时广播给同类型所有实例 |
| `joints` | number[] | 关节角度数组（度），用于 set_joints |
| `preset` | string | 预设名称，用于 set_preset |
| `sequence` | string | 序列名称，用于 run_sequence |

### 对话示例

```
用户：让机器人挥手
AI 调用：robot_control {action:"run_sequence", sequence:"wave_sequence"}
回复：序列 "wave_sequence" 在 1 个查看器上完成（6 步）

用户：把关节 1 转到 90 度
AI 调用：robot_control {action:"set_joints", joints:[90,0,0,0,0,0]}
回复：关节值已应用到 abb-crb-15000 的 1 个查看器

用户：现在有几台机器人连接？
AI 调用：robot_control {action:"list_connections"}
回复：已连接查看器 (2):
  [1] ABB CRB 15000  instance=tab-1234  joints=[0.0, 0.0, ...]
  [2] ABB CRB 15000  instance=tab-5678  joints=[45.0, -30.0, ...]
```

---

## 多机器人同时控制

### 同时打开多个查看器

1. 打开第一个浏览器标签，加载 `robot_kinematic_viewer.html`，连接端口 9877，加载 `ABB-CRB-15000.glb`
2. 打开第二个浏览器标签，重复上述步骤
3. 桥接服务器为每个标签分配唯一 `instanceId`

```
[bridge] registered  robot=abb-crb-15000  instance=tab-0001  total=1
[bridge] registered  robot=abb-crb-15000  instance=tab-0002  total=2
```

### 广播到同类型所有机器人

不指定 `instance_id` 时，命令广播给该 `robot_id` 的所有实例：

```
用户：让所有机器人同时跳舞
AI 调用：robot_control {action:"run_sequence", sequence:"dance_sequence", robot_id:"abb-crb-15000"}
回复：序列 "dance_sequence" 在 2 个查看器上完成（5 步）
```

### 单独控制特定实例

先查询 instanceId，再用它单独控制：

```
用户：单独控制第二个机器人挥手
AI 调用：robot_control {action:"list_connections"}
  --> 获得 instanceId: "tab-0002"
AI 调用：robot_control {action:"run_sequence", sequence:"wave_sequence",
                         robot_id:"abb-crb-15000", instance_id:"tab-0002"}
```

### 控制不同型号的机器人

打开多个标签，加载不同型号的 GLB 和 robotId：

```
标签1：robot_id=abb-crb-15000   加载 ABB-CRB-15000.glb
标签2：robot_id=irb-1200        加载 IRB-1200.glb

用户：让 CRB 挥手，让 IRB 回到初始位置
AI 调用 1：robot_control {action:"run_sequence", sequence:"wave_sequence", robot_id:"abb-crb-15000"}
AI 调用 2：robot_control {action:"go_home", robot_id:"irb-1200"}
```

---

## 自动连接识别

### 识别流程

```
查看器连接
    |
    +--> 发送 {cmd:"register", robotId:"abb-crb-15000", instanceId:"tab-uuid"}
    |
    +--> 桥接服务器在 robots/ 目录查找 abb-crb-15000.json
    |
    +--> 返回 configFound:true / false 及完整机器人信息
    |
    +--> 查看器 UI 更新显示："ABB CRB 15000 已连接（配置已找到）"
```

### 连接状态检查

通过 HTTP 接口实时查询：

```bash
curl http://127.0.0.1:9877/status
```

或在聊天中询问：

```
用户：当前连接了哪些机器人？
AI 调用：robot_control {action:"list_connections"}
```

### 配置文件未找到时

若 `robots/` 目录中无对应 JSON，桥接服务器仍接受连接，但返回 `configFound:false`，
此时关节验证将使用默认值（±180°），建议及时补充配置文件。

生成配置文件：

```bash
python tools/convert_robot_xml.py \
    --robot-dir "../ABB Robot/MyRobot" \
    --out robots/my-robot.json --presets --verify
```

---

## 内置预设与动作序列

### ABB CRB 15000 内置预设

| 预设名 | 关节值 [J1..J6] | 说明 |
|--------|----------------|------|
| `home` | [0, 0, 0, 0, 0, 0] | 所有关节归零 |
| `ready` | [0, -30, 60, 0, 30, 0] | 准备工作姿态 |
| `inspect` | [0, -45, 90, 0, -45, 0] | 向下检查姿态 |
| `pick_low` | [0, 30, 90, 0, -30, 0] | 低位抓取姿态 |
| `stretch_up` | [0, -90, 0, 0, 0, 0] | 向上伸展 |
| `stretch_fwd` | [0, 0, -90, 0, 90, 0] | 向前伸展 |
| `tuck` | [0, 90, -90, 0, 0, 0] | 收缩姿态 |
| `wave` | [45, -30, 60, 0, 30, 0] | 挥手起始位置 |
| `salute` | [0, -60, 0, 0, 60, 0] | 敬礼姿态 |
| `dance_a` | [90, -30, 60, 45, 30, 0] | 舞蹈 A 姿态 |
| `dance_b` | [-90, -30, 60, -45, 30, 0] | 舞蹈 B 姿态 |

### 内置动作序列

| 序列名 | 步数 | 总时长 | 说明 |
|--------|------|--------|------|
| `wave_sequence` | 6 | ~3.2 s | 挥手 2 次后归零 |
| `dance_sequence` | 5 | ~3.2 s | 左右摇摆跳舞后归零 |
| `nod_sequence` | 5 | ~2.1 s | 点头 2 次后归零 |
| `inspect_sequence` | 5 | ~3.5 s | 左右扫描巡检后归零 |

### 自定义序列

在 `robots/<id>.json` 的 `sequences` 字段中添加：

```json
"sequences": {
  "my_sequence": {
    "description": "自定义动作",
    "steps": [
      { "joints": [30, -45, 90, 0, -30, 0], "durationMs": 800 },
      { "joints": [-30, -45, 90, 0, -30, 0], "durationMs": 800 },
      { "joints": [0, 0, 0, 0, 0, 0], "durationMs": 600 }
    ]
  }
}
```

保存后无需重启，直接调用：`robot_control {action:"run_sequence", sequence:"my_sequence"}`

---

## ABB CRB 15000 关节参数

数据来源：`ABB Robot/CRB-15000/rlkin/abb-crb-15000.xml` + `rlmdl/abb-crb-15000.xml`

### 关节限位与速度

| 关节 | 名称 | 最小角度 | 最大角度 | 最大速度 | 转轴 |
|------|------|:--------:|:--------:|:--------:|------|
| J1 | 基座旋转 Base Rotation | -180 deg | +180 deg | 250 deg/s | Z [0,0,1] |
| J2 | 肩部 Shoulder | -180 deg | +180 deg | 250 deg/s | Y [0,1,0] |
| J3 | 肘部 Elbow | -180 deg | +180 deg | 250 deg/s | Y [0,1,0] |
| J4 | 前臂滚转 Forearm Roll | -225 deg | +85 deg | 320 deg/s | X [1,0,0] |
| J5 | 腕部俯仰 Wrist Pitch | -180 deg | +180 deg | 320 deg/s | Y [0,1,0] |
| J6 | 法兰滚转 Flange Roll | -180 deg | +180 deg | 420 deg/s | X [1,0,0] |

> **注意**：J4 关节（前臂滚转）范围不对称：-225 deg ~ +85 deg，超出此范围的命令将被自动截断。

### Denavit-Hartenberg 参数

| 关节 | d | theta | a | alpha |
|------|--:|------:|--:|------:|
| joint0 | 0.0 | 0.0 | 0.0 | 0.0 |
| joint1 | 10.0 | 0.0 | 0.0 | 0.0 |
| joint2 | 0.0 | 0.0 | 0.0 | 0.0 |
| joint3 | 0.0 | 0.0 | 10.0 | 0.0 |
| joint4 | 0.0 | 0.0 | 10.0 | 0.0 |
| joint5 | 0.0 | 0.0 | -0.001 | 0.0 |

### 连杆偏移（来自 rlmdl）

| 关节 | 偏移 translation [x, y, z] |
|------|----------------------------|
| joint0 | [0, 0, 0] |
| joint1 | [0, 0, 10] |
| joint2 | [0, 0, 0] |
| joint3 | [10, 0, 0] |
| joint4 | [10, 0, 0] |
| joint5 | [-0.001, 0, 0] |

---

## 添加新机器人

### 步骤一：准备 XML 文件

将机器人 XML 文件放入以下结构：

```
models/ABB Robot/
+-- MyRobot/
    +-- rlkin/
    |   +-- my-robot.xml
    +-- rlmdl/
        +-- my-robot.xml
```

### 步骤二：转换为 JSON

```bash
python tools/convert_robot_xml.py \
    --robot-dir "../ABB Robot/MyRobot" \
    --out robots/my-robot.json \
    --robot-id my-robot \
    --glb MyRobot.glb \
    --presets --verify
```

或直接双击 `convert_robots.bat` 自动扫描全部。

### 步骤三：在查看器中使用

查看器 HTML 的 `register` 消息中将 `robotId` 设置为 `my-robot`，
桥接服务器将自动匹配 `robots/my-robot.json`。

无需修改任何插件代码，无需重启桥接服务器。

### 步骤四：验证

```
用户：列出所有已知机器人
AI 调用：robot_control {action:"list_robots"}
回复：Known robot configs:
  - abb-crb-15000 (1 viewer connected)
  - my-robot (0 viewers connected)
```

---

## 常见问题

**Q: 启动桥接服务器报错 `Cannot find module ws`**
```bash
cd models/Plugin && npm install
```

**Q: 查看器连接后显示 configFound:false**

检查 `robots/` 目录中是否存在与查看器 `robotId` 同名的 JSON 文件。
使用转换工具生成，或手动创建符合 `robot-config.schema.json` 格式的文件。

**Q: 发送关节命令后提示部分值被截断**

正常行为。超出关节限位的值会自动截断到最近的边界值，并在回复中明确标注。
ABB CRB 15000 的 J4 关节范围为 -225~+85 deg，注意不对称范围。

**Q: 多个查看器只有一个响应**

确认所有查看器都已点击 **Connect** 并完成注册（桥接服务器日志中可见 `registered` 行）。
命令中不要指定 `instance_id`（或指定 `robot_id` 不带 `instance_id`）以广播给全部实例。

**Q: Python 转换工具运行超时**

使用完整路径调用 Python：
```cmd
"C:\Python\Python310\python.exe" tools\convert_robot_xml.py --help
```

**Q: build_exe.bat 打包失败**

手动安装 PyInstaller：
```cmd
"C:\Python\Python310\python.exe" -m pip install pyinstaller
```
然后重新运行 `build_exe.bat`。

**Q: 关节值为 NaN 或 undefined**

检查 `robots/*.json` 中对应关节是否有 `min`/`max` 数字字段，
确认 XML 转换时使用了 `--verify` 标志，所有字段均通过校验。

---

## 开发参考

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/robot-config-loader.ts` | 配置加载、关节验证（`validateJointValues`）、截断（`clampJoint`）、预设解析（`resolvePreset`）、序列解析（`resolveSequence`） |
| `src/ws-bridge.ts` | WebSocket 服务器、会话注册表、多级路由（`sendToViewer` / `broadcastToRobot`）、HTTP 状态端点 |
| `src/robot-kinematic-tool.ts` | OpenClaw 代理工具定义，所有 action 处理逻辑 |
| `tools/convert_robot_xml.py` | XML 解析、JSON 生成、完整校验 |
| `robots/robot-config.schema.json` | 配置文件 JSON Schema 定义 |

### 扩展工具 action

在 `src/robot-kinematic-tool.ts` 的 `execute` 函数中添加新的 `if (action === "my_action")` 分支，
同时在 `parameters.properties.action.enum` 数组中加入新 action 名称即可。

---

*文档版本：1.0.0 | 生成日期：2026-03-12*
