# OAG 下一阶段任务清单 — 集成收尾 + 加固 + 优化

> Updated: 2026-03-17
> 当前状态：已部署到本地，204 测试全绿，OAG 运行时验证通过
> 来源：深度审计 + 部署验证后发现

---

## 已完成任务回顾

| 阶段        | 完成任务                                       | 测试 |
| ----------- | ---------------------------------------------- | ---- |
| P0          | 7 个 bug 修复 + 核心测试                       | 65   |
| P1          | 语言扩展 (ja/ko) + 通知去重                    | 71   |
| P2          | 原子锁 + 指标 + 配置化 + 收口                  | 148  |
| P3-10       | Schema 版本化                                  | 165  |
| Evolution   | 记忆 + 分析 + 采集 + 通知 + 回滚 + 诊断 + 调度 | 199  |
| Integration | 7 个模块接入运行时                             | 204  |

---

## 一、集成收尾（Medium — 模块已建待接入）

### INT-5: 事件总线启动

- **问题：** `startFileWatcher` 和 `emitOagEvent` 从未被调用。事件总线是死代码。
- **文件：** `src/gateway/server.impl.ts`
- **改动：**
  - Gateway 启动时调用 `startFileWatcher(channelHealthStatePath, onUpdate)`
  - Gateway 关闭时调用 `stopFileWatcher`
  - 为后续 status 命令缓存读取铺路
- **优先级：** Medium
- **Status:** [ ] Not started

### INT-6: Agent 诊断触发接入

- **问题：** postmortem 分析无结果但检测到模式时，不会升级到 agent 诊断。
- **文件：** `src/infra/oag-postmortem.ts`
- **改动：** 在 postmortem 末尾，如果 `analyzed && recommendations.length === 0 && patterns > 0`，调用 `requestDiagnosis`
- **优先级：** Medium
- **Status:** [ ] Not started

### INT-7: Agent 诊断实际调度

- **问题：** `requestDiagnosis` 生成 prompt 但没有实际调用 agent。需要接入 OpenClaw embedded runner。
- **文件：** `src/gateway/server.impl.ts` 或新建 `src/infra/oag-diagnosis-dispatch.ts`
- **改动：** 利用 `getReplyFromConfig` 或 embedded runner 发送诊断 prompt，响应回调调用 `completeDiagnosis`
- **依赖：** 需要理解 embedded runner API
- **优先级：** Medium
- **Status:** [ ] Not started

---

## 二、安全加固

### SAFE-2: 事件采集器内存限制

- **问题：** `activeIncidents` Map 在长时间运行的 gateway 中无限增长。
- **文件：** `src/infra/oag-incident-collector.ts`
- **改动：** 限制 Map 大小 100 条，超限淘汰最旧 incident
- **优先级：** Medium
- **Status:** [ ] Not started

### SAFE-3: Memory 文件写入前备份

- **问题：** `oag-memory.json` 写入被中断 → 文件损坏 → 历史学习全部丢失。
- **文件：** `src/infra/oag-memory.ts`
- **改动：** 写入前先备份为 `.bak`，加载时主文件损坏回退到 `.bak`
- **优先级：** Medium
- **Status:** [ ] Not started

### SAFE-4: 进化通知频率限制

- **问题：** gateway 频繁崩溃重启时，每次可能注入通知。
- **文件：** `src/infra/oag-postmortem.ts`
- **改动：** 24 小时内最多 3 次进化通知
- **优先级：** Low
- **Status:** [ ] Not started

### SAFE-5: 并发 postmortem 防护

- **问题：** 多 gateway 实例同时启动时 postmortem 竞争写 config。
- **文件：** `src/infra/oag-postmortem.ts`
- **改动：** 用文件锁保护 postmortem 执行
- **优先级：** Low
- **Status:** [ ] Not started

---

## 三、测试补全

### TEST-2: server.impl.ts 接入点验证

- **问题：** shutdown snapshot、startup postmortem、incident recording 是 fire-and-forget async，可能静默失败。
- **优先级：** Medium
- **Status:** [ ] Not started

### TEST-3: `inferSessionReplyLanguage` 主入口测试

- **问题：** 只测了 `detectSessionReplyLanguageFromText`。主入口读转录文件未测。
- **优先级：** Low
- **Status:** [ ] Not started

---

## 四、文档补全

### DOC-2: Sentinel Schema v1/v2 规范

- **问题：** 有 schema 版本检测但无文档说明字段规范。
- **文件：** `docs/gateway/oag-sentinel-schema.md` (new)
- **优先级：** Medium
- **Status:** [ ] Not started

### DOC-3: 运维进化操作指南

- **问题：** 自动进化出问题时运维不知如何处理。
- **文件：** `docs/gateway/oag.md` 扩展
- **内容：** 查看进化历史、手动回滚、禁用自动进化
- **优先级：** Medium
- **Status:** [ ] Not started

---

## 五、性能优化

### PERF-1: Config 读取缓存确认

- **问题：** `loadConfig()` 在 OAG 热路径中被多次调用。需确认是否有内存缓存。
- **改动：** 如果是每次读磁盘，在 OAG 函数入口缓存一次
- **优先级：** 需先确认
- **Status:** [ ] Not started

### PERF-2: Status 命令切换到事件总线缓存

- **问题：** `openclaw status` 每次读磁盘。事件总线已有 `getCachedHealthSnapshot()` 但未接入。
- **依赖：** INT-5（事件总线启动）
- **优先级：** Low
- **Status:** [ ] Not started

---

## 六、深度优化方向（新增）

### OPT-1: 进化效果量化仪表盘

- **问题：** 进化是否有效只有日志记录，运维无法直观看到趋势。
- **方案：**
  - 在 `/health` 端点增加 `oagEvolution` 字段：上次进化时间、应用参数、outcome（effective/reverted/pending）
  - 在 `openclaw status` 增加一行 `OAG evolution: last applied 2h ago · effective · recoveryBudgetMs 60→90s`
- **优先级：** Medium
- **Status:** [ ] Not started

### OPT-2: 多模式进化策略

- **问题：** 当前进化只有启发式规则。可以增加更多策略：
  - **时间相关：** 工作日 vs 周末流量模式差异 → 按时段调整阈值
  - **频道相关：** 不同频道的崩溃模式不同 → 每频道独立参数
  - **渐进式：** 小步调整 + 长时间观察，而非一次性大调整
- **优先级：** Low
- **Status:** [ ] Not started

### OPT-3: 进化 A/B 测试框架

- **问题：** 当前进化是单向的（应用或回滚）。可以支持：
  - 同时跑两组参数（A=旧值 B=新值），按比例分流
  - 自动收集对比指标，选择更优方案
  - 类似于 ML 的 bandit 算法进行在线学习
- **优先级：** Low（研究方向）
- **Status:** [ ] Not started

### OPT-4: 投递队列性能基准测试

- **问题：** JSON 索引已加入但没有量化收益。
- **方案：**
  - 生成 1000/5000/10000 条模拟投递
  - 对比有索引 vs 无索引的 recovery 扫描时间
  - 如果索引带来 10x 改进，考虑后续依赖索引做增量恢复
- **优先级：** Low
- **Status:** [ ] Not started

### OPT-5: 多语言 OAG 通知翻译

- **问题：** ja/ko 检测已支持但通知文本回退到英文。
- **方案：** 为 `resolveLocalizedOagMessage` 添加 ja/ko 翻译映射
- **优先级：** Low
- **Status:** [ ] Not started

### OPT-6: OAG 状态 WebSocket 实时推送

- **问题：** 控制台 Web UI 无法实时看到 OAG 状态变化，需要手动刷新。
- **方案：** 事件总线 → WebSocket broadcast → 控制台 UI 自动更新
- **依赖：** INT-5（事件总线启动）
- **优先级：** Low
- **Status:** [ ] Not started

---

## 优先级总览

| 优先级     | 任务                                                             | 数量   |
| ---------- | ---------------------------------------------------------------- | ------ |
| **Medium** | INT-5, INT-6, INT-7, SAFE-2, SAFE-3, TEST-2, DOC-2, DOC-3, OPT-1 | 9      |
| **Low**    | SAFE-4, SAFE-5, TEST-3, PERF-2, OPT-2~6                          | 9      |
| **TBD**    | PERF-1 (需确认)                                                  | 1      |
| **总计**   |                                                                  | **19** |

## 建议执行顺序

```
第 1 波 (Medium 核心，并行):
  INT-5 + INT-6 + SAFE-2 + SAFE-3 + DOC-2 + DOC-3

第 2 波 (Medium 进阶):
  INT-7 + TEST-2 + OPT-1

第 3 波 (Low + 确认):
  PERF-1 + SAFE-4 + OPT-5 + TEST-3

第 4 波 (研究方向):
  OPT-2 + OPT-3 + OPT-4 + OPT-6 + SAFE-5 + PERF-2
```
