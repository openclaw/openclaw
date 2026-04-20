---
title: "工具循环检测"
summary: "如何启用和调整检测重复工具调用循环的护栏"
read_when:
  - 用户报告代理陷入重复工具调用
  - 你需要调整重复调用保护
  - 你正在编辑代理工具/运行时策略
---

# 工具循环检测

OpenClaw 可以防止代理陷入重复的工具调用模式。
该保护**默认禁用**。

仅在需要时启用它，因为严格的设置可能会阻止合法的重复调用。

## 为什么存在此功能

- 检测没有进展的重复序列。
- 检测高频无结果循环（相同工具，相同输入，重复错误）。
- 检测已知轮询工具的特定重复调用模式。

## 配置块

全局默认值：

```json5
{
  tools: {
    loopDetection: {
      enabled: false,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

每代理覆盖（可选）：

```json5
{
  agents: {
    list: [
      {
        id: "safe-runner",
        tools: {
          loopDetection: {
            enabled: true,
            warningThreshold: 8,
            criticalThreshold: 16,
          },
        },
      },
    ],
  },
}
```

### 字段行为

- `enabled`：主开关。`false` 表示不执行循环检测。
- `historySize`：用于分析的最近工具调用数量。
- `warningThreshold`：将模式分类为仅警告之前的阈值。
- `criticalThreshold`：阻止重复循环模式的阈值。
- `globalCircuitBreakerThreshold`：全局无进展断路器阈值。
- `detectors.genericRepeat`：检测重复的相同工具 + 相同参数模式。
- `detectors.knownPollNoProgress`：检测无状态变化的已知轮询模式。
- `detectors.pingPong`：检测交替的 ping-pong 模式。

## 推荐设置

- 从 `enabled: true` 开始，保持默认值不变。
- 保持阈值顺序为 `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold`。
- 如果出现误报：
  - 提高 `warningThreshold` 和/或 `criticalThreshold`
  - （可选）提高 `globalCircuitBreakerThreshold`
  - 仅禁用导致问题的检测器
  - 减少 `historySize` 以降低历史上下文的严格性

## 日志和预期行为

当检测到循环时，OpenClaw 会报告循环事件，并根据严重程度阻止或抑制下一个工具周期。
这可以保护用户免受失控的令牌消耗和锁定，同时保留正常的工具访问。

- 首先优先警告和临时抑制。
- 仅当重复证据累积时才升级。

## 注意事项

- `tools.loopDetection` 与代理级覆盖合并。
- 每代理配置完全覆盖或扩展全局值。
- 如果不存在配置，护栏保持关闭状态。