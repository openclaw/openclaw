---
title: "工具循环检测"
description: "配置可选的防护措施，防止重复或停滞的工具调用循环"
summary: "如何启用和调整检测重复工具调用循环的防护措施"
read_when:
  - 用户报告智能体一直重复调用工具
  - 你需要调整重复调用保护
  - 你正在编辑智能体工具/运行时策略
x-i18n:
  source_path: tools/loop-detection.md
---

# 工具循环检测

OpenClaw 可以防止智能体陷入重复的工具调用模式。
此防护措施**默认禁用**。

仅在需要时启用，因为严格的设置可能会阻止合理的重复调用。

## 为什么需要这个功能

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

按智能体覆盖（可选）：

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
- `historySize`：保留用于分析的最近工具调用数量。
- `warningThreshold`：将模式分类为仅警告的阈值。
- `criticalThreshold`：阻止重复循环模式的阈值。
- `globalCircuitBreakerThreshold`：全局无进展熔断器阈值。
- `detectors.genericRepeat`：检测相同工具加相同参数的重复模式。
- `detectors.knownPollNoProgress`：检测已知的轮询类模式且无状态变化。
- `detectors.pingPong`：检测交替的乒乓模式。

## 推荐设置

- 从 `enabled: true` 开始，保持默认值不变。
- 保持阈值顺序为 `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold`。
- 如果出现误报：
  - 提高 `warningThreshold` 和/或 `criticalThreshold`
  - （可选）提高 `globalCircuitBreakerThreshold`
  - 仅禁用导致问题的检测器
  - 减小 `historySize` 以降低历史上下文的严格程度

## 日志和预期行为

检测到循环时，OpenClaw 会报告循环事件，并根据严重程度阻止或抑制下一个工具调用周期。
这在保持正常工具访问的同时，保护用户免受 token 消耗失控和死锁的影响。

- 优先使用警告和临时抑制。
- 仅在反复出现证据时才升级。

## 注意事项

- `tools.loopDetection` 与智能体级别的覆盖合并。
- 按智能体配置完全覆盖或扩展全局值。
- 如果没有配置，防护措施保持关闭。
