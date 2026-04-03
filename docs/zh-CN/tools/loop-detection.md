---
title: "工具循环检测"
summary: "如何启用和调整检测重复工具调用循环的防护栏"
read_when:
  - 用户报告代理陷入重复工具调用
  - 您需要调整重复调用保护
  - 您正在编辑代理工具/运行时策略
---

# 工具循环检测

OpenClaw 可以防止代理陷入重复工具调用模式。防护栏**默认禁用**。

仅在需要时启用它，因为使用严格设置可能会阻止合法的重复调用。

## 为什么存在

- 检测没有进展的重复序列。
- 检测高频无结果循环（相同工具、相同输入、重复错误）。
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

每个代理覆盖（可选）：

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
- `historySize`：保留用于分析的最近工具调用数。
- `warningThreshold`：将模式分类为仅警告的阈值。
- `criticalThreshold`：阻止重复循环模式的阈值。
- `globalCircuitBreakerThreshold`：全局无进展断路器阈值。
- `detectors.genericRepeat`：检测相同的工具 + 相同参数重复模式。
- `detectors.knownPollNoProgress`：检测没有状态变化的已知轮询式模式。
- `detectors.pingPong`：检测交替的乒乓球模式。

## 推荐设置

- 从 `enabled: true` 开始，保持默认值不变。
- 保持阈值有序为 `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold`。
- 如果出现误报：
  - 提高 `warningThreshold` 和/或 `criticalThreshold`
  - （可选）提高 `globalCircuitBreakerThreshold`
  - 仅禁用导致问题的检测器
  - 减小 `historySize` 以获得不那么严格的历史上下文

## 日志和预期行为

当检测到循环时，OpenClaw 报告循环事件并根据严重程度阻止或抑制下一个工具循环。
这可以保护用户免受失控的 token 消耗和锁定，同时保留正常的工具访问。

- 首先首选警告和临时抑制。
- 仅当重复证据积累时才升级。

## 备注

- `tools.loopDetection` 与代理级别覆盖合并。
- 每个代理配置完全覆盖或扩展全局值。
- 如果不存在配置，防护栏保持关闭。