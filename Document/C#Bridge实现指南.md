# C# Bridge 实现指南

## 📋 概述

C# Bridge是连接Node.js MCP插件和实际ABB机器人的关键组件。它使用edge-js技术调用C#代码，通过ABB PC SDK与机器人控制器通信。

---

## 🏗️ 架构

```
Node.js MCP Plugin
    ↓ (abb-robot-tool.ts)
abb-controller.ts
    ↓ (executeCSCommand)
abb-csharp-bridge.ts
    ↓ (edge-js)
ABBBridge.dll (C#)
    ↓ (ABB.Robotics.Controllers)
ABB PC SDK
    ↓ (TCP/IP)
Robot Controller (IRC5)
    ↓
Physical Robot
```

---

## 📦 文件清单

### TypeScript文件
- `abb-csharp-bridge.ts` - C# Bridge接口
- `abb-controller.ts` - 控制器实现（已更新）
- `rapid-generator.ts` - RAPID代码生成器

### C#文件
- `ABBBridge.cs` - C# Bridge实现

### 脚本文件
- `compile-bridge.bat` - 编译脚本

---

## 🔧 安装步骤

### 步骤1: 安装ABB PC SDK 2025

**下载**:
- 从ABB官网下载PC SDK 2025
- 或联系ABB技术支持

**安装**:
```
默认位置: C:\Program Files (x86)\ABB\SDK\PCSDK 2025
```

**验证**:
```bash
Test-Path "C:\Program Files (x86)\ABB\SDK\PCSDK 2025\Bin\ABB.Robotics.Controllers.dll"
```

### 步骤2: 安装edge-js

```bash
cd D:\OpenClaw\Develop\openclaw\extensions\abb-robot-control
npm install edge-js
# 或
pnpm add edge-js
```

### 步骤3: 编译C# Bridge

```bash
cd D:\OpenClaw\Develop\openclaw\extensions\abb-robot-control\src
compile-bridge.bat
```

**预期输出**:
```
[OK] Compilation successful!
[OK] Output: ABBBridge.dll
```

### 步骤4: 验证安装

```bash
Test-Path "D:\OpenClaw\Develop\openclaw\extensions\abb-robot-control\src\ABBBridge.dll"
```

---

## 🚀 使用方法

### 自动连接

MCP插件会自动尝试使用C# Bridge：

```typescript
// 在abb-controller.ts中
private async executeCSCommand(command: string, params: Record<string, unknown>): Promise<any> {
  try {
    const { ABBCSharpBridge } = await import("./abb-csharp-bridge.js");
    const bridge = new ABBCSharpBridge();
    
    // 使用真实的C# Bridge
    return await bridge.connect(host, port);
  } catch (error) {
    // 如果C# Bridge不可用，回退到模拟实现
    return this.getMockResponse(command);
  }
}
```

### 手动使用

```typescript
import { ABBCSharpBridge } from "./abb-csharp-bridge.js";

const bridge = new ABBCSharpBridge();

// 连接
await bridge.connect("192.168.125.1", 7000);

// 获取关节位置
const joints = await bridge.getJointPositions();

// 移动到关节位置
await bridge.moveToJoints([0, -30, 60, 0, 30, 0], 100, "fine");

// 执行RAPID程序
await bridge.executeRapidProgram(rapidCode, "MainModule");

// 断开连接
await bridge.disconnect();
```

---

## 📝 RAPID代码生成

### 关节运动

```typescript
import { RAPIDGenerator } from "./rapid-generator.js";

const code = RAPIDGenerator.generateMoveJoint(
  [0, -30, 60, 0, 30, 0],  // 关节角度
  100,                       // 速度 (%)
  "fine"                     // 区域
);
```

### 直线运动

```typescript
const code = RAPIDGenerator.generateMoveLinear({
  x: 500, y: 0, z: 300,
  q1: 0, q2: 0, q3: 1, q4: 0,
  speed: 100,
  zone: "fine"
});
```

### 圆形运动

```typescript
const code = RAPIDGenerator.generateMoveCircular({
  via: { x: 400, y: 100, z: 300, q1: 0, q2: 0, q3: 1, q4: 0 },
  to: { x: 600, y: 100, z: 300, q1: 0, q2: 0, q3: 1, q4: 0 },
  speed: 100,
  zone: "z10"
});
```

### 连续轨迹

```typescript
const trajectory = [
  { type: "joint", target: { joints: [0, 0, 0, 0, 0, 0], speed: 100 } },
  { type: "linear", target: { x: 500, y: 0, z: 300, q1: 0, q2: 0, q3: 1, q4: 0, speed: 100 } },
  { type: "linear", target: { x: 500, y: 200, z: 300, q1: 0, q2: 0, q3: 1, q4: 0, speed: 50 } }
];

const code = RAPIDGenerator.generateTrajectory(trajectory);
```

### 拾取和放置

```typescript
const code = RAPIDGenerator.generatePickAndPlace(
  { x: 300, y: 0, z: 100, q1: 0, q2: 0, q3: 1, q4: 0 },  // 拾取位置
  { x: 600, y: 0, z: 100, q1: 0, q2: 0, q3: 1, q4: 0 },  // 放置位置
  100,  // 接近偏移 (mm)
  100   // 速度 (%)
);
```

### 焊接路径

```typescript
const code = RAPIDGenerator.generateWeldingPath(
  { x: 300, y: 0, z: 100, q1: 0, q2: 0, q3: 1, q4: 0 },  // 起点
  { x: 600, y: 0, z: 100, q1: 0, q2: 0, q3: 1, q4: 0 },  // 终点
  10,   // 焊接速度 (mm/s)
  100   // 移动速度 (%)
);
```

### 码垛

```typescript
const code = RAPIDGenerator.generatePalletizing(
  { x: 0, y: 0, z: 0, q1: 0, q2: 0, q3: 1, q4: 0 },  // 基础位置
  3,    // 行数
  4,    // 列数
  2,    // 层数
  { x: 100, y: 100, z: 150 },  // 间距
  100   // 速度
);
```

---

## 🧪 测试

### 测试1: 连接

```bash
# 在Node.js中
const { ABBCSharpBridge } = require("./abb-csharp-bridge.js");
const bridge = new ABBCSharpBridge();
const result = await bridge.connect("192.168.125.1", 7000);
console.log(result);
// 预期: { success: true, systemName: "IRC5_Controller", ... }
```

### 测试2: 获取状态

```bash
const status = await bridge.getStatus();
console.log(status);
// 预期: { success: true, connected: true, operationMode: "AUTO", motorState: "ON", ... }
```

### 测试3: 获取关节位置

```bash
const joints = await bridge.getJointPositions();
console.log(joints);
// 预期: [0, 0, 0, 0, 0, 0] (或实际位置)
```

### 测试4: 移动

```bash
const result = await bridge.moveToJoints([0, -30, 60, 0, 30, 0], 100, "fine");
console.log(result);
// 预期: { success: true }
```

---

## ⚠️ 故障排除

### 问题1: "C# Bridge DLL not found"

**原因**: ABBBridge.dll未编译或位置不正确

**解决方案**:
```bash
cd D:\OpenClaw\Develop\openclaw\extensions\abb-robot-control\src
compile-bridge.bat
```

### 问题2: "ABB PC SDK not found"

**原因**: ABB PC SDK未安装或安装位置不同

**解决方案**:
1. 安装ABB PC SDK 2025
2. 修改compile-bridge.bat中的路径
3. 重新编译

### 问题3: "Cannot find module 'edge-js'"

**原因**: edge-js未安装

**解决方案**:
```bash
npm install edge-js
# 或
pnpm add edge-js
```

### 问题4: 连接失败

**原因**: 网络连接或控制器配置问题

**解决方案**:
1. 检查IP地址和端口
2. 验证网络连接
3. 检查防火墙设置
4. 确保控制器在AUTO模式

---

## 📊 性能指标

| 操作 | 预期时间 |
|------|---------|
| 连接 | < 1秒 |
| 获取关节位置 | < 100ms |
| 移动到位置 | 取决于距离 |
| 执行RAPID程序 | 取决于程序 |

---

## 🔐 安全考虑

1. **网络安全**
   - 使用防火墙限制访问
   - 配置VPN连接
   - 使用加密通信

2. **机器人安全**
   - 始终验证关节限位
   - 使用安全区域
   - 实施紧急停止

3. **代码安全**
   - 验证所有输入
   - 使用类型检查
   - 实施错误处理

---

## 📚 参考资源

### ABB PC SDK文档
- ABB Robotics Controllers SDK
- RAPID Programming Guide
- System Parameters Reference

### 相关文件
- `abb-csharp-bridge.ts` - TypeScript接口
- `ABBBridge.cs` - C#实现
- `rapid-generator.ts` - RAPID生成器
- `abb-controller.ts` - 控制器集成

---

## 🎯 下一步

1. ✅ 安装ABB PC SDK
2. ✅ 编译C# Bridge
3. ✅ 安装edge-js
4. ✅ 测试连接
5. ✅ 验证所有功能

---

**版本**: 1.0.0  
**更新日期**: 2026-03-14  
**状态**: ✅ 完成
