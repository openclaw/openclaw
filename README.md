# OpenClaw Performance Monitor

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个全面的性能监控和分析工具，专为 OpenClaw 项目设计。

##  特性

-  **CPU 和内存监控** - 实时追踪系统资源使用情况
-  **Agent 执行追踪** - 监控 Agent 执行时间和成功率
-  **WebSocket 指标** - 追踪连接数、消息数和延迟
-  **模型性能监控** - 追踪模型响应时间和 tokens 使用
-  **智能告警系统** - 自动检测性能瓶颈并告警
-  **报告生成** - 生成详细的性能报告
-  **零依赖** - 不依赖外部库，开箱即用

##  安装

### 方法 1: 直接复制到项目

```bash
# 创建目录
mkdir -p src/monitoring

# 复制文件
cp src/monitoring/performance-monitor.ts your-project/src/monitoring/
```

### 方法 2: 作为独立包安装

```bash
# 在 deploy-package 目录下
cd deploy-package

# 安装依赖（仅开发依赖）
pnpm install

# 构建
pnpm build
```

##  快速开始

### 基本使用

```typescript
import { createPerformanceMonitor } from './monitoring/performance-monitor';

// 创建监控实例
const monitor = createPerformanceMonitor({
  cpuThreshold: 80,        // CPU 告警阈值
  memoryThreshold: 80,     // 内存告警阈值
  latencyThreshold: 3000,  // 延迟告警阈值 (ms)
  errorRateThreshold: 10,  // 错误率告警阈值 (%)
  debug: true,             // 启用调试日志
});

// 启动监控
monitor.start();

// 监听指标更新
monitor.on('metrics', (metrics) => {
  console.log(`CPU: ${metrics.cpuUsage.toFixed(2)}%`);
  console.log(`Memory: ${(metrics.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
});

// 监听告警
monitor.on('alert', (alert) => {
  console.warn(`[${alert.severity}] ${alert.message}`);
});

// 停止监控
monitor.stop();
```

### 追踪 Agent 执行

```typescript
// 开始追踪（支持包含连字符的 ID）
const execId = monitor.startAgentExecution('agent-v2-beta', 'My Agent V2');

try {
  // 执行任务
  await performTask();
  
  // 成功结束
  monitor.endAgentExecution(execId, true);
} catch (error) {
  // 失败结束
  monitor.endAgentExecution(execId, false);
  throw error;
}
```

### 追踪模型请求

```typescript
// 开始追踪（支持包含连字符的模型 ID）
const reqId = monitor.startModelRequest('gpt-4o-mini-2024-07-18');

try {
  // 调用模型
  const response = await callModel();
  
  // 成功结束（传入 tokens 数量）
  monitor.endModelRequest(reqId, true, response.usage.total_tokens);
} catch (error) {
  // 失败结束
  monitor.endModelRequest(reqId, false);
  throw error;
}
```

### 追踪 WebSocket 延迟

```typescript
// 记录延迟
monitor.trackWebSocketLatency(45);  // 45ms

// 更新 WebSocket 统计
monitor.updateWebSocketMetrics({
  activeConnections: 10,
  messagesSent: 150,
  messagesReceived: 200,
});
```

### 生成报告

```typescript
// 生成文本报告
const report = monitor.generateReport();
console.log(report);

// 导出 JSON 格式
const json = monitor.exportMetrics();
console.log(json);
```

##  API 文档

### 构造函数选项

```typescript
interface PerformanceMonitorOptions {
  interval?: number;           // 监控间隔（毫秒），默认 5000
  cpuThreshold?: number;       // CPU 告警阈值（%），默认 80
  memoryThreshold?: number;    // 内存告警阈值（%），默认 80
  latencyThreshold?: number;   // 延迟告警阈值（ms），默认 5000
  errorRateThreshold?: number; // 错误率告警阈值（%），默认 10
  debug?: boolean;             // 启用调试日志，默认 false
  maxAlertsHistory?: number;   // 告警历史最大数量，默认 100
}
```

### 主要方法

| 方法 | 说明 | 返回值 |
|------|------|--------|
| `start()` | 启动监控 | `void` |
| `stop()` | 停止监控 | `void` |
| `getMetrics()` | 获取当前指标 | `PerformanceMetrics` |
| `getAlerts()` | 获取告警列表 | `PerformanceAlert[]` |
| `startAgentExecution(agentId, agentName)` | 开始追踪 Agent | `string` |
| `endAgentExecution(executionId, success)` | 结束追踪 Agent | `void` |
| `startModelRequest(modelId)` | 开始追踪模型请求 | `string` |
| `endModelRequest(requestId, success, tokens?)` | 结束追踪模型请求 | `void` |
| `trackWebSocketLatency(latency)` | 追踪 WebSocket 延迟 | `void` |
| `updateWebSocketMetrics(metrics)` | 更新 WebSocket 指标 | `void` |
| `resolveAlert(alertId)` | 解决告警 | `void` |
| `generateReport()` | 生成报告 | `string` |
| `exportMetrics()` | 导出 JSON | `string` |

### 事件

| 事件名 | 参数 | 说明 |
|--------|------|------|
| `metrics` | `PerformanceMetrics` | 指标更新时触发 |
| `alert` | `PerformanceAlert` | 创建告警时触发 |
| `alertResolved` | `PerformanceAlert` | 解决告警时触发 |

##  配置说明

### TypeScript 配置

确保你的 `tsconfig.json` 包含以下配置：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "moduleResolution": "node",
    "types": ["node"]
  }
}
```

### 安装类型定义

```bash
# 安装 Node.js 类型定义（开发依赖）
pnpm add -D @types/node
```

##  测试

```bash
# 运行测试
pnpm test

# 或者使用 ts-node 直接运行
npx ts-node src/monitoring/performance-monitor.test.ts
```

##  性能报告示例

```
=== OpenClaw Performance Report ===
Generated at: 2024-01-15T10:30:00.000Z

--- System Resources ---
CPU Usage: 15.23%
Memory Usage: 42.50%
RSS: 150.25 MB
Heap: 85.00 MB / 200.00 MB

--- Agent Performance ---
Agent: My Agent V2 (agent-v2-beta)
  Executions: 10
  Avg Time: 125.50ms
  Success Rate: 90.00%
  Errors: 1

--- WebSocket Performance ---
Active Connections: 15
Messages Sent: 500
Messages Received: 750
Avg Latency: 45.23ms
Reconnections: 2

--- Model Performance ---
Model: gpt-4o-mini-2024-07-18
  Requests: 25
  Avg Response Time: 850.32ms
  Avg Tokens/Second: 125.50
  Error Rate: 4.00%

--- Alerts ---
Active Alerts: 0
Total Alerts: 3
```

##  已修复的问题

### v1.0.3
-  修复依赖 Node.js `events` 模块的问题（自实现 EventEmitter）
-  修复使用 `NodeJS.*` 类型的问题（自定义类型）
-  修复连字符 ID 提取错误（使用 `::` 分隔符）
-  修复双百分比显示错误（统一使用百分比）
-  修复 CPU 基线过时问题（每次采集后更新）
-  修复 Token 平均值计算错误（添加 totalTokens 字段）
-  修复错误率警报恢复问题（添加自动恢复逻辑）

##  环境支持

-  Node.js 18+
-  TypeScript 4.7+
-  浏览器环境（功能降级，无 CPU/内存监控）

##  许可证

MIT License

##  贡献

欢迎提交 Issue 和 Pull Request！

##  联系方式

- GitHub: https://github.com/openclaw
- Issues: https://github.com/openclaw/performance-monitor/issues
