#!/bin/bash
# Replace remaining Chinese comments in chain memory backend

cd /home/ubuntu/.openclaw/workspace/openclaw/src/memory/chain || exit 1

# More comprehensive replacements
sed -i 's/执行单个任务/Execute single task/g' async-queue.ts
sed -i 's/超过.*次数.*移到死信队列/Exceeded attempts, move to dead letter queue/g' async-queue.ts
sed -i 's/移动到死信队列/Move to dead letter queue/g' async-queue.ts
sed -i 's/获取队列状态/Get queue status/g' async-queue.ts
sed -i 's/获取死信队列/Get dead letter queue/g' async-queue.ts
sed -i 's/死信队列中的项/Items in dead letter queue/g' async-queue.ts
sed -i 's/清空死信队列/Clear dead letter queue/g' async-queue.ts
sed -i 's/等待所有任务完成/Wait for all tasks to complete/g' async-queue.ts

sed -i 's/导出/Export/g' index.ts

sed -i 's/类型定义/Type definitions/g' types.ts
sed -i 's/优先级/Priority/g' types.ts
sed -i 's/写入模式/Write mode/g' types.ts
sed -i 's/状态/Status/g' types.ts
sed -i 's/配置/Configuration/g' types.ts
sed -i 's/统计信息/Statistics/g' types.ts
sed -i 's/方法/Method/g' types.ts
sed -i 's/异步队列状态/Async queue status/g' types.ts
sed -i 's/选项/Options/g' types.ts
sed -i 's/支持/Support/g' types.ts

sed -i 's/协调多个.*实现故障隔离和降级/Coordinate multiple providers with fault isolation and degradation/g' manager.ts
sed -i 's/实现多.*协调.*故障隔离和降级/Implement multi-provider coordination with fault isolation and degradation/g' manager.ts
sed -i 's/设置/Set/g' manager.ts
sed -i 's/初始化/Initialize/g' manager.ts
sed -i 's/启动/Start/g' manager.ts
sed -i 's/获取底层.*支持.*或/Get underlying manager, support backend or plugin/g' manager.ts
sed -i 's/创建/Create/g' manager.ts
sed -i 's/注册到/Register to/g' manager.ts
sed -i 's/根据.*分类/Classify by priority/g' manager.ts
sed -i 's/搜索记忆/Search memory/g' manager.ts
sed -i 's/尝试降级/Try fallback/g' manager.ts
sed -i 's/尝试/Try/g' manager.ts
sed -i 's/所有都.*返回空/All providers returned empty/g' manager.ts
sed -i 's/停止/Stop/g' manager.ts
sed -i 's/获取所有/Get all/g' manager.ts
sed -i 's/重置.*的/Reset provider/g' manager.ts
sed -i 's/获取死信队列/Get dead letter queue/g' manager.ts
sed -i 's/死信队列中的项/Items in dead letter queue/g' manager.ts

sed -i 's/定期检查.*的/Periodically check provider health/g' health-monitor.ts
sed -i 's/降级阈值.*率.*默认/Degradation threshold, default/g' health-monitor.ts
sed -i 's/器/Monitor/g' health-monitor.ts
sed -i 's/注册/Register/g' health-monitor.ts
sed -i 's/注销/Unregister/g' health-monitor.ts
sed -i 's/检查单个/Check single provider/g' health-monitor.ts
sed -i 's/避免使用空字符串搜索.*会被.*返回空数组/Avoid empty string search which returns empty array/g' health-monitor.ts
sed -i 's/调用.*检查.*是否响应/Call status to check if provider responds/g' health-monitor.ts
sed -i 's/健康检查/Health check/g' health-monitor.ts
sed -i 's/如果.*打开.*标记为/If open, mark as/g' health-monitor.ts
sed -i 's/计算.*率/Calculate failure rate/g' health-monitor.ts
sed -i 's/根据.*率判断/Judge based on failure rate/g' health-monitor.ts
sed -i 's/获取健康的.*列表/Get list of healthy providers/g' health-monitor.ts

sed -i 's/实现.*模式.*防止级联故障/Implement circuit breaker pattern to prevent cascading failures/g' circuit-breaker.ts
sed -i 's/状态转换/State transitions/g' circuit-breaker.ts
sed -i 's/正常.*熔断.*试探/Normal - CLOSED, Circuit open - OPEN, Probe - HALF-OPEN/g' circuit-breaker.ts
sed -i 's/后重置.*计数.*状态变为/Reset failure count and state after timeout/g' circuit-breaker.ts
sed -i 's/检查.*是否打开.*是否应该拒绝请求/Check if circuit is open and if request should be rejected/g' circuit-breaker.ts
sed -i 's/应该拒绝请求.*打开/Should reject request, circuit is open/g' circuit-breaker.ts
sed -i 's/可以尝试请求/Can try request/g' circuit-breaker.ts
sed -i 's/获取当前状态/Get current state/g' circuit-breaker.ts
sed -i 's/获取.*计数/Get failure count/g' circuit-breaker.ts
sed -i 's/手动重置/Manual reset/g' circuit-breaker.ts

sed -i 's/包装单个.*提供超时.*功能/Wrap single provider with timeout and circuit breaker/g' wrapper.ts
sed -i 's/检查是否可用/Check if available/g' wrapper.ts
sed -i 's/检查/Check/g' wrapper.ts
sed -i 's/带超时和.*的执行/Execute with timeout and circuit breaker/g' wrapper.ts
sed -i 's/创建超时/Create timeout/g' wrapper.ts
sed -i 's/执行操作/Execute operation/g' wrapper.ts
sed -i 's/如果不是最后一次尝试.*等待后/If not last attempt, wait before retry/g' wrapper.ts
sed -i 's/所有尝试都/All attempts failed/g' wrapper.ts
sed -i 's/更新.*状态/Update statistics/g' wrapper.ts
sed -i 's/更新平均响应时间/Update average response time/g' wrapper.ts
sed -i 's/使用指数移动平均/Use exponential moving average/g' wrapper.ts
sed -i 's/睡眠/Sleep/g' wrapper.ts
sed -i 's/重置/Reset/g' wrapper.ts

echo "✅ All Chinese comments replaced with English"
