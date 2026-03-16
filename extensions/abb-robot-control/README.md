# ABB Robot Control Plugin for OpenClaw

> ABB机器人控制插件 — 支持虚拟3D查看器和真实机器人双模式

## Overview | 概述

This OpenClaw plugin enables control of ABB robots through two modes:
- **Virtual Mode** — Connects to the 3D kinematic viewer via WebSocket for smooth animated motion simulation
- **Real Mode** — Connects to actual ABB robot controllers via PC SDK/C# bridge

本OpenClaw插件支持两种模式控制ABB机器人:
- **虚拟模式** — 通过WebSocket连接3D运动学查看器，实现平滑动画运动仿真
- **真实模式** — 通过ABB PC SDK/C#桥接连接实际ABB机器人控制器

### Features | 功能特性

- **Dual Mode** — Virtual (3D viewer) and Real (PC SDK) control in one plugin
- **movj Command** — Smooth joint-space motion from start to target with configurable speed
- **WebSocket Bridge** — Real-time communication with the 3D kinematic viewer
- **PC SDK Integration** — Native connection to ABB robot controllers (real mode)
- **Auto-Identification** — Automatically identifies robot model from controller data
- **RAPID Generation** — Automatically generates RAPID code for movements
- **Safety Validation** — Joint limits validated before execution
- **Natural Language** — Control robots through conversational commands

### System Requirements | 系统要求

**Virtual Mode (all platforms):**
- Node.js 18+ (or Bun)
- WebSocket bridge running (`models/Plugin/src/ws-bridge.ts`)
- Browser with `robot_kinematic_viewer.html` open

**Real Mode (Windows only):**
- Windows 10/11 (64-bit)
- ABB PC SDK Version 2025 or later
- TCP/IP connectivity to robot controller
- ABB IRC5 or compatible controller

## Installation | 安装

### Virtual Mode Setup | 虚拟模式设置

1. **Start WebSocket bridge | 启动WebSocket桥接**
   ```bash
   cd models/Plugin
   npm install
   node --import tsx src/ws-bridge.ts
   # Bridge listens on ws://127.0.0.1:9877
   ```

2. **Open 3D viewer | 打开3D查看器**
   Open `models/robot_kinematic_viewer.html` in a browser, load a robot model (.glb), and click "Connect".

3. **Configure plugin | 配置插件**
   ```json
   {
     "plugins": {
       "entries": {
         "abb-robot-control": {
           "enabled": true,
           "config": {
             "defaultMode": "virtual",
             "wsBridgePort": 9877
           }
         }
       }
     }
   }
   ```

### Real Mode Setup | 真实模式设置

1. **Install ABB PC SDK | 安装ABB PC SDK**
   ```
   Default: C:\Program Files (x86)\ABB\SDK\PCSDK 2025
   ```

2. **Configure | 配置**
   ```json
   {
     "plugins": {
       "entries": {
         "abb-robot-control": {
           "enabled": true,
           "config": {
             "defaultMode": "real",
             "controllerHost": "192.168.125.1",
             "controllerPort": 7000,
             "defaultRobot": "abb-crb-15000"
           }
         }
       }
     }
   }
   ```

## Quick Start | 快速开始

### Virtual Mode | 虚拟模式

```
User: Connect to the virtual robot
AI: abb_robot action:connect mode:virtual

User: Move to [30, -20, 55, 15, 25, 10] at speed 40
AI: abb_robot action:movj joints:[30,-20,55,15,25,10] speed:40
(viewer shows smooth animated motion from current position to target)

User: Go home
AI: abb_robot action:go_home
```

### Real Mode | 真实模式

```
User: Connect to the ABB robot at 192.168.125.1
AI: abb_robot action:connect mode:real host:192.168.125.1

User: Move to ready position
AI: abb_robot action:set_preset preset:ready
```

## MCP Tool Actions | MCP工具动作

### Connection | 连接

- `connect` — Connect to controller (virtual or real)
- `disconnect` — Disconnect
- `get_status` — Get controller status (includes WebSocket state in virtual mode)
- `get_version` — Get plugin version

### Motion | 运动

- `get_joints` — Get current joint positions (reads from viewer in virtual mode)
- `set_joints` — Set joint positions instantly (sends to viewer in virtual mode)
- `movj` — **Smooth joint-space motion** from current/start to target with speed parameter
  - `joints`: target joint angles `[J1, J2, J3, J4, J5, J6]` (degrees)
  - `start_joints`: optional starting position (if not current)
  - `speed`: 1–100% (default: 45)
  - In virtual mode: viewer animates smooth eased motion and reports duration
  - In real mode: sends to ABB controller via PC SDK
- `go_home` — Return all joints to home position
- `set_preset` — Apply named preset
- `run_sequence` — Execute named motion sequence

### RAPID Programs (Real Mode) | RAPID程序

- `execute_rapid` — Execute RAPID code
- `load_rapid` — Load RAPID program
- `start_program` — Start RAPID execution
- `stop_program` — Stop RAPID execution

### Utilities | 工具

- `motors_on` / `motors_off` — Control motor state
- `list_robots` — List available robot configs

## Architecture | 架构

```
                    OpenClaw Chat UI
                         ↓
                  abb_robot MCP Tool
                    ↙           ↘
         Virtual Mode           Real Mode
              ↓                     ↓
     WebSocket Bridge        C# Bridge (PC SDK)
     (ws-bridge.ts)                ↓
         ↓                  Robot Controller (IRC5)
   3D Kinematic Viewer            ↓
  (browser / Three.js)      Physical Robot
```

### movj Flow (Virtual Mode) | movj流程（虚拟模式）

1. Plugin sends `{cmd:"movj", joints:[...], speed:N}` via WebSocket
2. Bridge routes command to the connected 3D viewer instance
3. Viewer performs smooth eased animation (`smoothstep`) from current to target
4. Viewer replies `{cmd:"movj_done", joints:[...], durationMs:N}`
5. Plugin returns completion result to the user

## Robot Configuration | 机器人配置

Each robot requires a JSON configuration file in `robots/<robot-id>.json`:

```json
{
  "id": "abb-crb-15000",
  "manufacturer": "ABB",
  "model": "CRB 15000",
  "dof": 6,
  "joints": [
    {
      "index": 0,
      "id": "joint0",
      "label": "J1 - Base Rotation",
      "type": "revolute",
      "min": -180.0,
      "max": 180.0,
      "speed": 250.0,
      "home": 0.0
    }
  ],
  "presets": {
    "home": [0, 0, 0, 0, 0, 0],
    "ready": [0, -30, 60, 0, 30, 0]
  }
}
```

## Safety | 安全

- Joint limits validated before execution
- Automatic clamping to safe limits
- Violation reporting
- Speed control (1–100%)
- Zone control (fine/blended) for real mode

## Troubleshooting | 故障排除

**Virtual Mode Issues | 虚拟模式问题:**
- Ensure WebSocket bridge is running: `node --import tsx models/Plugin/src/ws-bridge.ts`
- Ensure browser viewer is open and connected (green dot)
- Check port 9877 is not blocked
- Plugin auto-reconnects on connection loss

**Connection Issues (Real) | 连接问题（真实模式）:**
- Verify controller IP and network
- Check firewall (port 7000)
- Ensure PC SDK installed
- Controller in AUTO mode

## File Structure | 文件结构

```
extensions/abb-robot-control/
├── index.js                    # Plugin entry (runtime, dual-mode)
├── index.ts                    # TypeScript source
├── package.json                # Dependencies (ws for WebSocket)
├── openclaw.plugin.json        # Plugin metadata
├── src/
│   ├── abb-controller.ts       # Controller interface
│   ├── abb-csharp-bridge.ts    # C# bridge for PC SDK
│   ├── abb-robot-tool.ts       # MCP tool definition
│   ├── abb-robot-tool-actions.ts  # Action handlers
│   ├── rapid-generator.ts      # RAPID code generator
│   ├── robot-config-loader.ts  # Config loader
│   ├── ABBBridge.cs            # C# bridge source
│   └── ABBBridge.dll           # Compiled bridge
├── robots/
│   ├── abb-crb-15000.json      # ABB CRB-15000 config
│   └── robot-config.schema.json # Config schema
└── README.md                   # This file
```

## License | 许可证

Part of the OpenClaw project.

---

**Version | 版本**: 1.0.2
**Date | 日期**: 2026-03-16
**Author | 作者**: OpenClaw Development Team
