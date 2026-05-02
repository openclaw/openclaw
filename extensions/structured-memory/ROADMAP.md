# Structured Memory Plugin — 开发路线图

## 当前状态

- RFC 协议 v1.0 完成
- 插件骨架完成（config / SQLite schema / CRUD / 衰减 / 维护 / supplement）
- 三个工具完成：memory_record_add / find / archive
- 分类 pipeline 通过外部脚本验证：qwen:7b 73% 脏数据准确率，qwen2.5:3b 60%
- **待补：零测试、Perceptor 未实现、协议硬性约束缺失**

---

## Phase 1：协议补齐（1-2 天）

目标：让实现不再有协议漏洞，否则拿到社区会被指着 RFC 逐条撕。

### 1.1 Schema 补齐

```
[ ] critical 字段 —— SQLite column + insertRecord/updateRecord 支持
[ ] activate_at 字段 —— SQLite column，insertRecord 支持
[ ] allow_coexistence 字段 —— SQLite column
[ ] consolidated_count 字段 —— SQLite column
```

改 db.ts 的 `ensureSchema` 加列，改 `insertRecord`/`updateRecord`/`castRow` 传值。SQLite 加列只需 `ALTER TABLE ADD COLUMN`，不破坏已有数据。

### 1.2 critical 免疫

```
[ ] computeRelevance 里加判断：critical === 1 → should_archive = false，maintenance_score 保持当前值
[ ] runSessionMaintenance / runFullMaintenanceCycle 里 critical 记录直接跳过
```

### 1.3 activate_at 保护

```
[ ] computeRelevance 里：activate_at > now → should_archive = false
[ ] 同时降低 relevance 权重（尚未激活的记忆不应该排在检索结果前面）
```

### 1.4 域默认置信度

```
[ ] config.ts 里加 domainDefaults 配置项：personal=0.5, work=0.3, health=0.1, legal=0.1
[ ] insertRecord 或 add tool 里：未提供 confidence 时查域默认，没有则 0.3
    当前兜底是 0.5，需要改成 RFC 的 0.3
```

### 1.5 矛盾检测加固

当前 `findConflictingRecords` 是关键词 LIKE 匹配，太弱。

```
[ ] 矛盾检测改为：同 type + 同 agent_id + active + 至少 3 个关键词重叠
[ ] 检测到矛盾时设置 contradiction_flag = 1，自动降低 confidence（min(原值, 0.5)）
[ ] allow_coexistence = true 时不降低 confidence 但保留 flag
```

---

## Phase 2：Perceptor（2-3 天）

目标：实现消息级规则信号检测器，纯规则，不调 LLM。

### 2.1 规则引擎

`src/perceptor.ts`

```
[ ] 五类规则检测器：
    1. 时间承诺检测 —— "周五之前" / "下周三" / "月底" + 动作动词
    2. 显式偏好检测 —— "我不喜欢" / "更倾向" / "最好用"
    3. 身份信息检测 —— "我的X是Y" / "我叫" / "住在"
    4. 规则/约束检测 —— "必须" / "禁止" / "不允许" / "一定要"
    5. 纠正/否定检测 —— "不对" / "上次说的不对" / "不是X是Y"

[ ] 每个检测器返回 { hit: boolean, type: RecordType | null, pre_importance: number,
    pre_confidence: number, extracted_keywords: string[] }

[ ] 联合判决：多个检测器命中时取优先级最高的
    纠正 > 规则 > 偏好 > 承诺 > 身份信息

[ ] 性能硬约束：单条消息检测 < 5ms
    纯正则 + 关键词字典，不做语义分析
```

### 2.2 消息级 Hook

```
[ ] 注册 message_received hook
[ ] 每条用户消息过 Perceptor
[ ] 命中信号的暂存到 pendingSignals Map<sessionKey, Signal[]>
[ ] agent_end 时批量消费 pendingSignals → 触发分类 → 写入
```

**已确认：SDK 支持 `message_received` hook。**

`PluginHookMessageReceivedEvent` 包含 `content`（消息文本）、`from`、`sessionKey`、`timestamp`。

注册方式：`api.on("message_received", async (event, ctx) => { ... })`

完整 hook 列表（共 31 个）：`message_received`、`agent_end`、`before_prompt_build`、`before_compaction`、`after_compaction`、`before_reset`、`session_start`、`session_end`、`gateway_start`、`gateway_stop` 等。详见 `src/plugins/hook-types.ts`。

### 2.3 纯规则 fallback 分类

```
[ ] Perceptor 高置信度信号（如显式"必须/禁止" → rule, confidence 0.9）
    直接写入，不走 LLM 分类
[ ] 节省 LLM 调用，降低延迟，兜底 LLM 不可用时记忆系统仍能工作
```

---

## Phase 3：测试（1-2 天）

目标：让代码能被 review，数据能被引用。

### 3.1 单元测试

```
[ ] db.test.ts —— insertRecord / updateRecord / findRecords / archiveRecord / findConflictingRecords
[ ] decay.test.ts —— computeRelevance 各种时间边界、critical 免疫、activate_at 保护
[ ] config.test.ts —— resolveStructuredMemoryConfig 边界值
[ ] tools.test.ts —— add tool 幂等更新、find tool 过滤组合、archive tool 不存在记录
```

### 3.2 分类基准测试

```
[ ] 把 test-classification.py 的结果写进 docs/classification-benchmark.md
[ ] 包含：干净数据 14/14、脏数据 qwen:7b 73% vs qwen2.5:3b 60%
[ ] 注明测试环境（MBP14, Ollama, 模型版本）
[ ] 每周跑一次回归，防止 prompt 改动导致退化
```

### 3.3 端到端测试

```
[ ] 启动 OpenClaw gateway，加载插件
[ ] 模拟对话：发送 10 条包含可记忆信息的消息
[ ] 验证 memory_record_add 被正确触发
[ ] 验证 memory_record_find 能检索到写入的记录
[ ] 验证 expir_at 到期记录被 maintenance 归档
```

---

## Phase 4：发布准备（1 天）

### 4.1 README

```
[ ] 一句话说明：结构化类型记忆插件，确定性检索 + Perceptor 预检测
[ ] 架构图（ASCII）：[Messages] → [Perceptor] → [LLM Classify] → [SQLite] → [Decay]
[ ] 与现有记忆方案对比表（vs memory-lancedb / supermemory / mem0）
[ ] 一条命令安装：openclaw plugins install structured-memory
[ ] 配置示例
[ ] 分类 benchmark 数据
[ ] 本地模型推荐（qwen2.5:3b / qwen:7b）
```

### 4.2 ClawHub 发布

```
[ ] package.json 补 compat/build 字段
[ ] clawhub package publish --dry-run 验证
[ ] 正式发布
```

---

## Phase 5：Perceptor 的硬仗（后续）

Perceptor 是这套方案里最关键的差异化组件，但也是最容易被挑战的：

- **规则覆盖率**：五类规则能覆盖多少真实对话？需要拿真实 OpenClaw 会话日志跑统计
- **误报率**：闲聊被误判为可记忆信号的概率。高了用户会烦（agent 不断写无用记忆）
- **多语言**：当前检测规则只用中文，英文/中英混杂需要额外规则

这些不是 Phase 1-4 要解决的，但在社区推广过程中会被问到，需要提前准备应对口径。核心论点：**Perceptor 不需要 100% 召回，只需要降低 LLM 分类的调用量。** 宁可漏掉，不能堵住。

---

## 不做的事

- 不先做 `links` 的顶层化（当前在 JSON attributes 里够用，等有人抱怨再说）
- 不做语义检索集成（那是 LanceDB 的地盘，互补不重造）
- 不做多语言 Perceptor（先中文验证，英文用户自己贡献规则）
- 不加 `note` 兜底类型（先跑一段时间看 parse fail 率，数据说话）
