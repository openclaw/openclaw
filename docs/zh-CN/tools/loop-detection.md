---
title: "工具循环检测"
description: "配置可选的防护机制，防止重复或停滞的工具调用循环"
summary: "如何启用和调优检测重复工具调用循环的防护机制"
read_when:
  - agent 陷入重复工具调用的死循环
  - 需要调优重复调用检测的参数
  - 正在编辑 agent 工具/运行时策略
---

# 工具循环检测

OpenClaw 可以防止 agent 陷入重复工具调用的循环模式。该防护机制**默认关闭**。

仅在需要时启用，因为过严格的设置可能会阻止合法的重复调用。

## 为什么需要这个功能

- 检测无进展的重复调用序列。
- 检测高频无结果循环（相同工具、相同输入、重复错误）。
- 检测已知轮询工具的重复调用模式。

## 配置

全局默认配置：

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

按 agent 覆盖（可选）：

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

### 字段说明

- `enabled`：主开关。`false` 表示不执行任何循环检测。
- `historySize`：保留用于分析的最近工具调用数量。
- `warningThreshold`：将模式分类为仅警告的阈值。
- `criticalThreshold`：阻止重复循环模式的阈值。
- `globalCircuitBreakerThreshold`：全局无进展熔断器阈值。
- `detectors.genericRepeat`：检测相同工具 + 相同参数的重复模式。
- `detectors.knownPollNoProgress`：检测已知的无状态变化轮询模式。
- `detectors.pingPong`：检测交替的乒乓模式。

## 推荐配置

- 从 `enabled: true` 开始，保持默认阈值。
- 保持阈值顺序：`warningThreshold < criticalThreshold < globalCircuitBreakerThreshold`。
- 如果出现误报：
  - 提高 `warningThreshold` 和/或 `criticalThreshold`
  -（可选）提高 `globalCircuitBreakerThreshold`
  - 仅禁用导致问题的检测器
  - 减小 `historySize` 以降低历史上下文的严格程度

## 日志和预期行为

检测到循环时，OpenClaw 会报告循环事件，并根据严重程度阻止或抑制下一次工具调用周期。这可以保护用户免受失控的 token 消耗和锁定，同时保留正常的工具访问。

- 优先使用警告和临时抑制。
- 仅在累积了重复证据后才升级处理。

## 注意事项

- `tools.loopDetection` 与 agent 级别的覆盖配置合并。
- 按 agent 配置完全覆盖或扩展全局值。
- 如果没有配置，防护机制保持关闭。
