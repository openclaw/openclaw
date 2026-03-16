# ABB Robot Control Plugin for OpenClaw

> 通过ABB PC SDK控制实际ABB机器人的OpenClaw MCP插件

## Overview | 概述

This OpenClaw plugin enables natural language control of actual ABB robots through the ABB PC SDK.

本OpenClaw插件通过ABB PC SDK实现对实际ABB机器人的自然语言控制。

### Features | 功能特性

- **PC SDK Integration** - Native connection to ABB robot controllers
- **Auto-Identification** - Automatically identifies robot model from controller data
- **Multi-Robot Support** - Manage multiple robot configurations
- **RAPID Generation** - Automatically generates RAPID code for movements
- **Safety Validation** - Joint limits validated before execution
- **Natural Language** - Control robots through conversational commands

### System Requirements | 系统要求

- **Operating System**: Windows 10/11 (64-bit)
- **ABB PC SDK**: Version 2025 or later
- **Node.js**: Version 18 or later
- **Network**: TCP/IP connectivity to robot controller
- **Robot Controller**: ABB IRC5 or compatible

## Installation | 安装

1. **Install ABB PC SDK | 安装ABB PC SDK**
   ```
   Install from ABB website
   Default: C:\Program Files (x86)\ABB\SDK\PCSDK 2025
   ```

2. **Install Plugin | 安装插件**
   ```bash
   cd extensions/abb-robot-control
   pnpm install
   ```

3. **Configure | 配置**
   
   Edit `~/.openclaw/openclaw.json`:
   ```json
   {
     "plugins": {
       "entries": {
         "abb-robot-control": {
           "enabled": true,
           "config": {
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

1. **Connect to Robot | 连接机器人**
   ```
   User: Connect to the ABB robot at 192.168.125.1
   AI: [Connects and identifies robot model]
   ```

2. **Control Robot | 控制机器人**
   ```
   User: Move to home position
   User: Set joint 1 to 45 degrees
   User: Execute wave sequence
   ```

## MCP Tool Actions | MCP工具动作

### Connection | 连接

- `connect` - Connect to robot controller
- `disconnect` - Disconnect from controller
- `get_status` - Get controller status

### Motion | 运动

- `get_joints` - Get current joint positions
- `set_joints` - Move to joint positions
- `movj` - Continuous MoveJ from current/start joints to target with speed
- `set_preset` - Apply named preset
- `run_sequence` - Execute motion sequence
- `dance_two_points` - Build and execute continuous interpolated trajectory between two joint points
- `dance_template` - Execute built-in dance templates (wave/bounce/sway/twist) with continuity
- `go_home` - Return to home position
- `get_motion_memory` - Inspect last trajectory endpoint used for continuity
- `reset_motion_memory` - Reset continuity memory

### RAPID Programs | RAPID程序

- `execute_rapid` - Execute RAPID code
- `load_rapid` - Load RAPID program
- `start_program` - Start RAPID execution
- `stop_program` - Stop RAPID execution

### Utilities | 工具

- `motors_on` / `motors_off` - Control motor state
- `list_robots` - List available robot configs
- `list_presets` - List presets for robot
- `list_sequences` - List motion sequences

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
  },
  "sequences": {
    "wave_sequence": {
      "steps": [
        {
          "joints": [45, -30, 60, 0, 30, 0],
          "durationMs": 800,
          "speed": 100
        }
      ]
    }
  }
}
```

## Architecture | 架构

```
OpenClaw Chat UI
     ↓
abb_robot MCP Tool
     ↓
ABB Controller Interface
     ↓
C# Bridge (PC SDK)
     ↓
Robot Controller (IRC5)
     ↓
Physical Robot
```

## Safety | 安全

- Joint limits validated before execution
- Automatic clamping to safe limits
- Violation reporting
- Speed control (1-100%)
- Zone control (fine/blended)

## Examples | 示例

**Basic Movement | 基本运动:**
```
User: Connect to robot at 192.168.125.1
AI: abb_robot action:connect host:192.168.125.1

User: Move to ready position
AI: abb_robot action:set_preset preset:ready

User: Move joint 1 to 90 degrees
AI: abb_robot action:set_joints joints:[90,0,0,0,0,0]

User: MoveJ to target joints at speed 40
AI: abb_robot action:movj joints:[30,-20,55,15,25,10] speed:40
```

**Execute Sequence | 执行序列:**
```
User: Make the robot wave
AI: abb_robot action:run_sequence sequence:wave_sequence
```

**Continuous Dance Segment | 连续舞蹈片段（双点自动补轨迹）:**
```
User: Use joint points A=[0,-40,55,0,30,0] and B=[35,-20,65,10,20,15], make smooth continuous motion for 8 beats
AI: abb_robot action:dance_two_points point_a:[0,-40,55,0,30,0] point_b:[35,-20,65,10,20,15] repeat:8 speed:45 max_joint_step:5 auto_connect:true
```

This action automatically:
- connects from previous segment endpoint to point A (when available)
- interpolates dense waypoints between A/B for continuous movement
- keeps endpoint in motion memory so the next dance command continues smoothly

Advanced controls:
- `interpolation`: `linear | smoothstep | cosine` (default: `cosine`)
- `min_samples`: minimum points per segment (default: 2)
- `max_joint_step`: max per-joint degree step (smaller = smoother)

**Template Dance | 模板舞蹈动作:**
```
User: Use a wave dance template for 16 beats, smooth motion
AI: abb_robot action:dance_template template:wave beats:16 speed:45 interpolation:cosine max_joint_step:5 auto_connect:true
```

## Troubleshooting | 故障排除

**Connection Issues | 连接问题:**
- Verify controller IP and network
- Check firewall (port 7000)
- Ensure PC SDK installed
- Controller in AUTO mode

**Movement Issues | 运动问题:**
- Check motor state
- Turn motors on
- Verify no active programs
- Check for obstructions

## File Structure | 文件结构

```
extensions/abb-robot-control/
├── index.ts                    # Plugin entry
├── package.json                # Dependencies
├── openclaw.plugin.json        # Metadata
├── src/
│   ├── abb-controller.ts       # Controller interface
│   ├── abb-robot-tool.ts       # MCP tool
│   ├── abb-robot-tool-actions.ts  # Actions
│   └── robot-config-loader.ts  # Config loader
├── robots/
│   ├── abb-crb-15000.json      # Robot config
│   └── robot-config.schema.json # Schema
└── README.md                   # This file
```

## Development Notes | 开发说明

**Current Implementation | 当前实现:**
- Mock responses for development
- C# bridge not yet implemented
- Requires PC SDK for production

**TODO | 待办:**
- Implement C# bridge with edge-js
- Add real PC SDK integration
- Error handling for SDK exceptions
- Coordinated movements
- I/O control
- External axes support

## License | 许可证

Part of the OpenClaw project.

---

**Version | 版本**: 1.0.0  
**Date | 日期**: 2026-03-14  
**Author | 作者**: OpenClaw Development Team

For detailed documentation, see:
- English: [docs/README_EN.md](docs/README_EN.md)
- 中文: [docs/README_ZH.md](docs/README_ZH.md)
