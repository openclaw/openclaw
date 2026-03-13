# 机器人配置文件格式详解

本文档说明 `robots/*.json` 配置文件的完整格式规范。
所有字段由 `robots/robot-config.schema.json` 进行 JSON Schema 验证。

## 顶层字段

```jsonc
{
  "$schema": "../robot-config.schema.json",  // 可选，IDE 格式校验
  "id": "abb-crb-15000",      // 必填：唯一标识符，kebab-case，与查看器 robotId 匹配
  "version": "1.0.0",         // 必填：配置版本
  "manufacturer": "ABB",      // 必填：制造商
  "model": "CRB 15000",       // 必填：型号
  "description": "...",       // 可选：描述
  "dof": 6,                   // 必填：自由度数（1-12）
  "mechanismType": "serial_6dof", // 必填：见下方类型列表
  "glbFile": "ABB-CRB-15000.glb", // 可选：GLB 模型文件名
  "joints": [ ... ],          // 必填：关节数组
  "dhParameters": [ ... ],    // 可选：DH 参数
  "linkOffsets": [ ... ],     // 可选：连杆偏移
  "gravity": [0, 0, 9.81],    // 可选：重力矢量 [x,y,z] m/s²
  "presets": { ... },         // 可选：命名预设
  "sequences": { ... }        // 可选：命名序列
}
```

## mechanismType 枚举

| 值 | 说明 |
|----|------|
| `serial_6dof` | 6 轴串联机械臂（最常见） |
| `serial` | 通用串联机构 |
| `scara` | SCARA 机器人 |
| `delta` | Delta 并联机器人 |
| `parallel` | 通用并联机构 |
| `coupled` | 耦合关节机构 |

## joints 数组

每个元素描述一个关节：

```jsonc
{
  "index": 0,           // 必填：关节序号（0 起始）
  "id": "joint0",       // 必填：关节 ID（唯一）
  "label": "J1 - Base", // 可选：显示名称
  "type": "revolute",   // 必填：revolute（转动）| prismatic（平移）
  "min": -180.0,        // 必填：最小值（度 or mm）
  "max": 180.0,         // 必填：最大值
  "speed": 250.0,       // 可选：最大速度（°/s or mm/s）
  "home": 0.0,          // 必填：归零位置
  "axis": [0, 0, 1],    // 可选：转轴方向向量 [x,y,z]
  "unit": "deg"         // 可选：deg | rad | mm | m
}
```

> **重要**：`min` 必须 <= `max`，否则配置加载时抛出错误。
> J4 等非对称关节（如 -225 ~ +85）是合法的。

## dhParameters 数组

Denavit-Hartenberg 标准参数，每个元素对应一个关节：

```jsonc
{
  "jointId": "joint0",  // 对应 joints[i].id
  "d": 0.0,             // 连杆偏移（沿 z 轴）
  "theta": 0.0,         // 关节角（绕 z 轴）
  "a": 0.0,             // 连杆长度（沿 x 轴）
  "alpha": 0.0          // 连杆扭角（绕 x 轴）
}
```

## linkOffsets 数组

来自 rlmdl XML 的 `<fixed>` 变换，描述连杆相对父坐标系的偏移：

```jsonc
{
  "jointId": "joint1",
  "translation": [0.0, 0.0, 10.0],  // [x, y, z]
  "rotation":    [0.0, 0.0,  0.0]   // [rx, ry, rz] 欧拉角（度）
}
```

## presets 对象

键为预设名，值为关节角度数组（长度必须等于 `dof`）：

```json
"presets": {
  "home":   [0, 0, 0, 0, 0, 0],
  "ready":  [0, -30, 60, 0, 30, 0],
  "custom": [45, -45, 90, 0, -30, 0]
}
```

所有值在加载时被截断到对应关节的 `[min, max]` 范围内。

## sequences 对象

键为序列名，值为含 `steps` 数组的对象：

```json
"sequences": {
  "my_sequence": {
    "description": "可选描述",
    "steps": [
      { "joints": [30, -45, 90, 0, -30, 0], "durationMs": 800 },
      { "joints": [-30, -45, 90, 0, -30, 0], "durationMs": 800 },
      { "joints": [0, 0, 0, 0, 0, 0], "durationMs": 600 }
    ]
  }
}
```

- `durationMs`：该步骤持续时间（毫秒），最小值 1
- 序列执行完毕后自动发送 `home` 命令
- 每步关节值在执行前均经过截断验证
