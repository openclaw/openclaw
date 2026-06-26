<!-- Language: Chinese (Simplified) -->

# Issue #97067 分析报告

**分析时间**: 2026-06-27T01:53:00+08:00
**Issue标题**: Cron heartbeat injection produces partial Conversation info block
**Issue链接**: https://github.com/openclaw/openclaw/issues/97067

## 元数据

| 字段   | 值                                                 |
| ------ | -------------------------------------------------- |
| 类型   | bug                                                |
| 严重性 | P2                                                 |
| 标签   | bug, P2, impact:session-state, impact:message-loss |
| 指派人 | 无                                                 |

## 问题描述

Cron 心跳轮询触发时，注入的 `Conversation info (untrusted metadata)` 块的 `chat_id` 缺少通道前缀（如 `qqbot:`），导致下游 agent 将心跳误判为 prompt injection 尝试。

## 根因

`buildInboundUserContextPrefix()` 使用 `ctx.OriginatingTo` 作为 `chat_id`，但心跳运行器在构建上下文时没有设置通道前缀。`Provider` 字段为 `"heartbeat"`/`"cron-event"`/`"exec-event"` 等合成值，而非真实通道名。

## 修复

在 `buildInboundUserContextPrefix()` 中，当 `Provider` 是合成类型时（`heartbeat`、`cron-event`、`exec-event`），跳过整个 `Conversation info` 块。心跳提示本身已自描述，无需该元数据块。

## Proof Strategy

**目标证据类型**: terminal
**证据采集计划**: 使用 vitest 运行心跳上下文抑制测试
