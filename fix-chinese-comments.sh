#!/bin/bash
# Replace Chinese comments with English in chain memory backend

WORKSPACE="/home/ubuntu/.openclaw/workspace/openclaw/src/memory/chain"

# File-by-file replacements
cd "$WORKSPACE" || exit 1

# async-queue.ts
sed -i 's/异步写入队列/Async write queue/g' async-queue.ts
sed -i 's/处理次要 provider 的异步写入操作/Handles async write operations for secondary providers/g' async-queue.ts
sed -i 's/异步队列配置/Async queue configuration/g' async-queue.ts
sed -i 's/最大并发数，默认 10/Max concurrent tasks, default 10/g' async-queue.ts
sed -i 's/重试延迟，默认 1000ms/Retry delay in ms, default 1000ms/g' async-queue.ts
sed -i 's/最大重试次数，默认 3/Max retry attempts, default 3/g' async-queue.ts
sed -i 's/死信队列最大大小，默认 1000/Max dead letter queue size, default 1000/g' async-queue.ts
sed -i 's/队列处理器/Queue processor/g' async-queue.ts
sed -i 's/触发处理/Trigger processing/g' async-queue.ts
sed -i 's/执行任务/Execute task/g' async-queue.ts
sed -i 's/处理失败/Processing failed/g' async-queue.ts
sed -i 's/添加任务/Add task/g' async-queue.ts
sed -i 's/获取状态/Get status/g' async-queue.ts
sed -i 's/等待队列清空/Wait for queue to drain/g' async-queue.ts
sed -i 's/超时时间（毫秒），默认 30 秒。设置为 0 表示无限等待/Timeout in ms, default 30s. Set to 0 for no timeout/g' async-queue.ts
sed -i 's/清空队列/Clear queue/g' async-queue.ts
sed -i 's/获取配置/Get configuration/g' async-queue.ts

# circuit-breaker.ts
sed -i 's/熔断器状态/Circuit breaker state/g' circuit-breaker.ts
sed -i 's/熔断器配置/Circuit breaker configuration/g' circuit-breaker.ts
sed -i 's/失败阈值，默认 5/Failure threshold, default 5/g' circuit-breaker.ts
sed -i 's/重置超时，默认 60000ms/Reset timeout in ms, default 60000ms/g' circuit-breaker.ts
sed -i 's/检查是否应该进入 HALF-OPEN 状态/Check if should enter HALF-OPEN state/g' circuit-breaker.ts
sed -i 's/允许一个试探请求/Allow one probe request/g' circuit-breaker.ts
sed -i 's/仍然打开/Still open/g' circuit-breaker.ts
sed -i 's/记录失败/Record failure/g' circuit-breaker.ts
sed -i 's/记录成功/Record success/g' circuit-breaker.ts
sed -i 's/获取状态/Get state/g' circuit-breaker.ts
sed -i 's/获取配置/Get configuration/g' circuit-breaker.ts

# health-monitor.ts
sed -i 's/健康监控/Health monitor/g' health-monitor.ts
sed -i 's/健康监控配置/Health monitor configuration/g' health-monitor.ts
sed -i 's/健康检查间隔，默认 30000ms/Health check interval in ms, default 30000ms/g' health-monitor.ts
sed -i 's/检查超时，默认 5000ms/Check timeout in ms, default 5000ms/g' health-monitorer.ts
sed -i 's/降级阈值（失败率），默认 0.3/Degradation threshold (failure rate), default 0.3/g' health-monitor.ts
sed -i 's/记录错误但不影响其他 provider 的检查/Log error but do not affect other provider checks/g' health-monitor.ts
sed -i 's/使用 status() 方法进行健康检查/Use status() method for health check/g' health-monitor.ts
sed -i 's/执行健康检查/Perform health check/g' health-monitor.ts
sed -i 's/健康检查成功/Health check succeeded/g' health-monitor.ts
sed -i 's/健康检查失败/Health check failed/g' health-monitor.ts
sed -i 's/计算健康状态/Calculate health status/g' health-monitor.ts
sed -i 's/如果熔断器打开，标记为 unhealthy/If circuit breaker is open, mark as unhealthy/g' health-monitor.ts
sed -i 's/没有请求，假设健康/No requests, assume healthy/g' health-monitor.ts
sed -i 's/根据失败率判断/Judge based on failure rate/g' health-monitor.ts
sed -i 's/获取所有 provider 的健康状态/Get health status of all providers/g' health-monitor.ts
sed -i 's/启动监控/Start monitoring/g' health-monitor.ts
sed -i 's/停止监控/Stop monitoring/g' health-monitor.ts
sed -i 's/调度下一次检查/Schedule next check/g' health-monitor.ts

# manager.ts
sed -i 's/验证配置/Validate configuration/g' manager.ts
sed -i 's/新增/Newly added/g' manager.ts
sed -i 's/初始化异步队列/Initialize async queue/g' manager.ts
sed -i 's/设置队列处理器/Set queue processor/g' manager.ts
sed -i 's/初始化健康监控/Initialize health monitor/g' manager.ts
sed -i 's/启动健康监控/Start health monitor/g' manager.ts
sed -i 's/初始化 providers/Initialize providers/g' manager.ts
sed -i 's/跳过禁用的 provider/Skip disabled provider/g' manager.ts
sed -i 's/使用 backend/Use backend/g' manager.ts
sed -i 's/使用 plugin/Use plugin/g' manager.ts
sed -i 's/理论上不会发生（config-validator 已经验证）/Should not happen (validated by config-validator)/g' manager.ts
sed -i 's/探测 embedding 可用性/Probe embedding availability/g' manager.ts
sed -i 's/委托给 primary provider/Delegate to primary provider/g' manager.ts
sed -i 's/探测 vector 可用性/Probe vector availability/g' manager.ts
sed -i 's/获取状态/Get status/g' manager.ts
sed -i 's/获取详细状态/Get detailed status/g' manager.ts
sed -i 's/关闭 manager/Close manager/g' manager.ts
sed -i 's/停止健康监控/Stop health monitor/g' manager.ts
sed -i 's/等待异步队列完成/Wait for async queue to complete/g' manager.ts
sed -i 's/清空队列/Clear queue/g' manager.ts
sed -i 's/关闭所有子 providers/Close all child providers/g' manager.ts
sed -i 's/获取 provider/Get provider/g' manager.ts
sed -i 's/执行搜索/Execute search/g' manager.ts
sed -i 's/尝试 primary/Try primary/g' manager.ts
sed -i 's/尝试 fallback/Try fallback/g' manager.ts
sed -i 's/读取文件/Read file/g' manager.ts
sed -i 's/主入口/Main entry/g' manager.ts

# types.ts
sed -i 's/backend 或 plugin 二选一/Either backend or plugin (mutually exclusive)/g' types.ts
sed -i 's/熔断器状态/Circuit breaker state/g' types.ts
sed -i 's/性能统计/Performance statistics/g' types.ts
sed -i 's/上次请求时间/Last request time/g' types.ts
sed -i 's/熔断器/Circuit breaker/g' types.ts
sed -i 's/异步写入任务/Async write task/g' types.ts
sed -i 's/死信队列项/Dead letter queue item/g' types.ts
sed -i 's/Chain Manager 状态/Chain manager status/g' types.ts
sed -i 's/全局配置/Global configuration/g' types.ts
sed -i 's/Chain Memory 配置/Chain memory configuration/g' types.ts
sed -i 's/Provider 配置/Provider configuration/g' types.ts
sed -i 's/健康状态/Health status/g' types.ts

# wrapper.ts
sed -i 's/Provider 包装器/Provider wrapper/g' wrapper.ts
sed -i 's/初始化熔断器/Initialize circuit breaker/g' wrapper.ts
sed -i 's/初始化统计信息/Initialize statistics/g' wrapper.ts
sed -i 's/初始化熔断器状态/Initialize circuit breaker state/g' wrapper.ts
sed -i 's/检查是否启用/Check if enabled/g' wrapper.ts
sed -i 's/检查熔断器/Check circuit breaker/g' wrapper.ts
sed -i 's/执行请求/Execute request/g' wrapper.ts
sed -i 's/记录成功/Record success/g' wrapper.ts
sed -i 's/记录失败/Record failure/g' wrapper.ts
sed -i 's/获取统计信息/Get statistics/g' wrapper.ts
sed -i 's/获取配置/Get configuration/g' wrapper.ts

# index.ts
sed -i 's/Chain Memory Backend - 多 Provider 记忆系统/Chain Memory Backend - Multi-provider memory system/g' index.ts
sed -i 's/导出所有模块/Export all modules/g' index.ts

echo "✅ Chinese comments replaced with English"
