# OAG 下一阶段任务清单 — 集成 + 加固 + 文档

> Updated: 2026-03-17
> 基于全局深度审计产出
> 问题来源：7 个模块已建已测但未接入运行时 + 安全/持久/文档缺口

---

## 一、死代码集成（Critical — 不接入等于没做）

这 7 个模块目前只被自己的 test 文件引用，运行时从未执行：

### INT-1: 接入回滚守卫到维护定时器

- **问题：** `checkEvolutionHealth()` 永远不被调用。进化后没有回归检测，也没有确认。
- **文件：** `src/gateway/server-maintenance.ts` 或 `server.impl.ts`
- **改动：**
  - 在 gateway maintenance timer（每 30-60 秒 tick）中注册 `checkEvolutionHealth()` 调用
  - 当返回 `action: "reverted"` 时，记录日志并注入 OAG 通知："OAG: 检测到参数回归，已自动回滚"
  - 当返回 `action: "confirmed"` 时，记录日志
- **测试：** 集成测试验证 tick → check → revert/confirm 链路
- **优先级：** Critical
- **Status:** [ ] Not started

### INT-2: 进化后启动回滚观察窗口

- **问题：** postmortem 应用 config 后从未调用 `startEvolutionObservation`。回滚守卫有能力但无人启动。
- **文件：** `src/infra/oag-postmortem.ts`
- **改动：**
  - 在 `applyOagConfigChanges` 成功后，调用 `startEvolutionObservation`
  - 传入 `rollbackChanges`（每个 applied recommendation 的 `configPath` + `currentValue` 作为 `previousValue`）
- **测试：** postmortem 测试验证 observation 被启动
- **优先级：** Critical
- **Status:** [ ] Not started

### INT-3: postmortem 使用空闲调度器

- **问题：** `server.impl.ts` 中 postmortem 用 `void (async () => { ... })()` 直接启动，可能与用户消息处理竞争资源。
- **文件：** `src/gateway/server.impl.ts`
- **改动：**
  - 导入 `runWhenIdle` 和 `createGatewayIdleCheck`
  - 将 postmortem 调用包在 `runWhenIdle(postmortemTask, idleCheck)` 中
  - idleCheck 使用已有的 `getTotalQueueSize` / `getTotalPendingReplies` / `getActiveEmbeddedRunCount`
- **测试：** 验证 postmortem 在 queue 非空时延迟执行
- **优先级：** High
- **Status:** [ ] Not started

### INT-4: 投递索引接入队列操作

- **问题：** `delivery-index.ts` 的 `addToIndex` / `removeFromIndex` 从未被 `enqueueDelivery` / `ackDelivery` 调用。索引永远为空。
- **文件：** `src/infra/outbound/delivery-queue.ts`
- **改动：**
  - `enqueueDelivery` 末尾调用 `addToIndex`
  - `ackDelivery` 末尾调用 `removeFromIndex`
  - `moveToFailed` 末尾调用 `removeFromIndex`
  - `recoverPendingDeliveries` 开始时调用 `rebuildIndex`（冷启动修复）
  - 索引操作 try-catch 包裹，失败不影响主流程（best-effort）
- **测试：** outbound.test.ts 中验证 enqueue → index has entry → ack → index empty
- **优先级：** High
- **Status:** [ ] Not started

### INT-5: 事件总线启动文件监听

- **问题：** `startFileWatcher` 从未被调用。OAG 状态文件变更不触发任何事件。
- **文件：** `src/gateway/server.impl.ts`
- **改动：**
  - 在 gateway 启动阶段（channels 启动后），调用 `startFileWatcher(channelHealthStatePath, onUpdate)`
  - `onUpdate` 回调中触发 `emitOagEvent("health_snapshot_updated")`
  - 在 gateway close 中调用 `stopFileWatcher`
- **测试：** 验证 watcher 启动和关闭
- **优先级：** Medium
- **Status:** [ ] Not started

### INT-6: Agent 诊断触发接入

- **问题：** `requestDiagnosis` 从未被任何代码调用。postmortem 分析不足时不会升级到 agent 诊断。
- **文件：** `src/infra/oag-postmortem.ts`
- **改动：**
  - 在 `runPostRecoveryAnalysis` 末尾，如果 `result.analyzed === true && result.recommendations.length === 0 && result.patterns > 0`（有模式但无建议），调用 `requestDiagnosis`
  - 诊断结果暂存到 memory，实际 agent 调度后续接入
- **测试：** postmortem 无建议但有模式时触发 diagnosis
- **优先级：** Medium
- **Status:** [ ] Not started

### INT-7: Agent 诊断实际调度

- **问题：** `requestDiagnosis` 生成 prompt 和记录，但没有实际调用 agent。需要接入 OpenClaw 的 agent 基础设施。
- **文件：** `src/gateway/server.impl.ts` 或新建 `src/infra/oag-diagnosis-dispatch.ts`
- **改动：**
  - 在 gateway 上下文中，利用 `getReplyFromConfig` 或 embedded runner 发送诊断 prompt
  - 使用独立 agent ID + session prefix，`skipOutboundDelivery: true`
  - 响应回调调用 `completeDiagnosis` 解析结果
  - 低风险建议通过 `applyOagConfigChanges` 自动应用
- **依赖：** 需要理解 embedded runner / getReplyFromConfig 内部 API
- **测试：** mock agent reply → 验证 completeDiagnosis → 验证 config 变更
- **优先级：** Medium（可最后做）
- **Status:** [ ] Not started

---

## 二、安全 & 持久性加固

### SAFE-1: 回滚观察状态持久化

- **问题：** `activeObservation` 是内存变量。gateway 在观察窗口内重启 → 观察丢失 → 进化永远不被确认或回滚。
- **文件：** `src/infra/oag-evolution-guard.ts`
- **改动：**
  - 将 `activeObservation` 持久化到 `oag-memory.json` 的新字段 `activeObservation`
  - 启动时从 memory 恢复观察状态
  - 重启后的 `checkEvolutionHealth` 可以继续观察
- **优先级：** High
- **Status:** [ ] Not started

### SAFE-2: 事件采集器内存限制

- **问题：** `activeIncidents` Map 在长时间运行的 gateway 中无限增长。
- **文件：** `src/infra/oag-incident-collector.ts`
- **改动：**
  - 限制 Map 大小为 100 条
  - 超限时淘汰最旧的 incident（按 firstAt）
  - 或定期（每小时）清理超过 24 小时的 incident
- **优先级：** Medium
- **Status:** [ ] Not started

### SAFE-3: Memory 文件写入前备份

- **问题：** `oag-memory.json` 写入被中断（磁盘满、SIGKILL）→ 文件损坏 → 所有历史学习丢失。
- **文件：** `src/infra/oag-memory.ts`
- **改动：**
  - `saveOagMemory` 写入前先备份为 `oag-memory.json.bak`
  - `loadOagMemory` 主文件损坏时回退到 `.bak`
- **优先级：** Medium
- **Status:** [ ] Not started

### SAFE-4: 进化通知频率限制

- **问题：** 如果 gateway 频繁崩溃重启，每次 postmortem 都可能注入通知。虽然有 evolution ID 去重，但每次重启生成新 ID。
- **文件：** `src/infra/oag-postmortem.ts`
- **改动：**
  - 检查 `oag-memory.json` 最近 24 小时内的通知注入次数
  - 超过 3 次则不再注入（避免通知噪音）
- **优先级：** Low
- **Status:** [ ] Not started

### SAFE-5: 并发 postmortem 防护

- **问题：** 开发环境多 gateway 实例同时启动，都运行 postmortem → 竞争写 config。
- **文件：** `src/infra/oag-postmortem.ts`
- **改动：**
  - 复用 `withOagStateLock`（或专用锁）保护 postmortem 执行
  - 第二个实例检测到锁 → 跳过 postmortem
- **优先级：** Low
- **Status:** [ ] Not started

---

## 三、测试补全

### TEST-1: 进化全链路集成测试

- **问题：** 当前全部是 mock 单元测试，进化链路（pattern → postmortem → config write → observation → rollback）从未被端到端测试。
- **文件：** `src/infra/oag-evolution.integration.test.ts` (new)
- **范围：**
  - 模拟 3 次崩溃 lifecycle 写入 memory
  - 调用 postmortem → 验证 config 被写入
  - 模拟 metrics 回归 → 验证 config 被回滚
  - 模拟 observation 窗口过期 → 验证标记 "effective"
- **优先级：** High
- **Status:** [ ] Not started

### TEST-2: server.impl.ts 接入点测试

- **问题：** shutdown snapshot、startup postmortem、incident recording 都是 fire-and-forget async，可能静默失败。
- **文件：** 验证相关 import 和调用路径存在即可（不需要启动完整 gateway）
- **优先级：** Medium
- **Status:** [ ] Not started

### TEST-3: `inferSessionReplyLanguage` 主入口测试

- **问题：** 只测了 `detectSessionReplyLanguageFromText`（纯函数）。主入口 `inferSessionReplyLanguage`（读转录文件 → 逐行检测）未测。
- **文件：** `src/infra/session-language.test.ts`
- **优先级：** Low
- **Status:** [ ] Not started

---

## 四、文档补全

### DOC-1: OAG 配置参数用户文档

- **问题：** `gateway.oag.*` 有 7 个可调参数，但无用户文档。运维不知道可以调。
- **文件：** `docs/gateway/configuration.md` 或 `docs/gateway/oag.md` 扩展
- **内容：**

  | 参数                                    | 默认值 | 说明                   |
  | --------------------------------------- | ------ | ---------------------- |
  | `gateway.oag.delivery.maxRetries`       | 5      | 投递最大重试次数       |
  | `gateway.oag.delivery.recoveryBudgetMs` | 60000  | 恢复时间预算           |
  | `gateway.oag.lock.timeoutMs`            | 2000   | 锁获取超时             |
  | `gateway.oag.lock.staleMs`              | 30000  | 锁过期阈值             |
  | `gateway.oag.health.stalePollFactor`    | 2      | 轮询过期阈值倍数       |
  | `gateway.oag.notes.dedupWindowMs`       | 60000  | 通知去重窗口（0=禁用） |
  | `gateway.oag.notes.maxDeliveredHistory` | 20     | 已投递通知审计上限     |

- **优先级：** High
- **Status:** [ ] Not started

### DOC-2: Sentinel Schema v1/v2 规范

- **问题：** P3-10 加了 schema 版本检测，但没有文档说明 sentinel 应该产生什么字段。
- **文件：** `docs/gateway/oag-sentinel-schema.md` (new)
- **内容：** v1 字段清单 + v2 字段清单 + 示例 JSON
- **优先级：** Medium
- **Status:** [ ] Not started

### DOC-3: 运维进化操作指南

- **问题：** 如果自动进化出了问题，运维不知道怎么处理。
- **文件：** `docs/gateway/oag.md` 扩展
- **内容：**
  - 查看进化历史：`cat ~/.openclaw/sentinel/oag-memory.json | jq .evolutions`
  - 手动回滚：`openclaw config set gateway.oag.delivery.recoveryBudgetMs 60000`
  - 禁用自动进化：`openclaw config set gateway.oag.evolution.enabled false`（需要新增此配置项）
  - 查看诊断记录：`cat ~/.openclaw/sentinel/oag-memory.json | jq .diagnoses`
- **优先级：** Medium
- **Status:** [ ] Not started

### DOC-4: OAG-README 更新

- **问题：** `docs/gateway/OAG-README.md` 还是 P2 版本，不包含进化系统内容。
- **文件：** `docs/gateway/OAG-README.md`
- **内容：** 补充进化系统章节（持久记忆、事后分析、Agent 诊断、自动回滚）
- **优先级：** Low
- **Status:** [ ] Not started

---

## 五、性能优化

### PERF-1: Config 读取频率优化

- **问题：** `loadConfig()` 在 `withOagStateLock`、`deduplicateNotesByAction`、`consumePendingOagSystemNotes` 中被多次调用。
- **确认：** 检查 `loadConfig()` 是否有内存缓存。如果是每次读磁盘则需要优化。
- **优先级：** 需先确认
- **Status:** [ ] Not started

### PERF-2: Status 命令切换到事件总线缓存

- **问题：** `openclaw status` 每次调用 `readOagChannelHealthSummary()` 读磁盘。事件总线已有缓存但未接入。
- **文件：** `src/commands/oag-channel-health.ts` 或 status 命令路径
- **改动：** 优先从 `getCachedHealthSnapshot()` 读取，fallback 到文件读
- **依赖：** INT-5（事件总线启动）
- **优先级：** Low
- **Status:** [ ] Not started

---

## 优先级总览

| 优先级       | 任务                                                      | 数量   |
| ------------ | --------------------------------------------------------- | ------ |
| **Critical** | INT-1, INT-2                                              | 2      |
| **High**     | INT-3, INT-4, SAFE-1, TEST-1, DOC-1                       | 5      |
| **Medium**   | INT-5, INT-6, INT-7, SAFE-2, SAFE-3, TEST-2, DOC-2, DOC-3 | 8      |
| **Low**      | SAFE-4, SAFE-5, TEST-3, DOC-4, PERF-1, PERF-2             | 6      |
| **总计**     |                                                           | **21** |

## 建议执行顺序

```
第 1 波 (Critical + High，并行):
  INT-1 + INT-2 + INT-3 + INT-4 + SAFE-1 + TEST-1 + DOC-1

第 2 波 (Medium，并行):
  INT-5 + INT-6 + SAFE-2 + SAFE-3 + DOC-2 + DOC-3

第 3 波 (Medium + Low):
  INT-7 + TEST-2 + SAFE-4 + DOC-4 + PERF-2

第 4 波 (确认后):
  PERF-1 (需先确认 loadConfig 是否缓存)
  SAFE-5 (需确认多实例场景是否存在)
  TEST-3 (低优先级补充)
```
