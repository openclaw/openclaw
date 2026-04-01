---
name: orchestrator
description: 自动任务分解、依赖调度、并行执行和结果合成。用于复杂任务的元技能。
metadata:
  {
    "openclaw": {
      "emoji": "🔄",
      "requires": {
        anyBins: [],
      },
    },
  }
---

# Orchestrator Skill

指导agent如何自动分解复杂任务、并行执行子代理、并合成最终结果。

## 核心理念

OpenClaw已经支持`maxSpawnDepth >= 2`的多层子代理架构。本skill提供完整的orchestration模式：
1. **任务分解**: 将复杂任务拆分为原子子任务
2. **依赖调度**: 构建DAG，按批次并行执行
3. **Agent匹配**: 根据子任务类型自动选择合适的agent
4. **结果合成**: 收集所有子代理输出，自动合并/标记冲突

## 何时使用

✅ **使用orchestration当**:
- 任务需要跨多个独立模块工作
- 任务可以分解为无明显依赖的子任务
- 希望加快完成速度（并行）
- 需要不同专业领域的agent协作

❌ **避免orchestration当**:
- 任务强序列依赖（每个子任务必须等上一个完成）
- 子任务总数<2（并行开销不值得）
- 任务本身很简单（<10分钟工作量）

## 架构模式

```
主Agent (用户)
  │
  ├─ exec orchestrator.py decompose "任务描述"
  │    → 输出 subtasks.json (结构化的任务列表)
  │
  ├─ 解析 subtasks.json，生成执行计划
  │
  ├─ 对每个批次(batch)循环：
  │    ├─ 批次内并行调用: sessions_spawn
  │    │     (为每个子任务spawn一个子代理)
  │    │
  │    └─ 等待批次完成:
  │         ├─ 轮询 sessions_list 检查状态
  │         ├─ 读取 sessions_history 获取结果
  │         └─ collectSubtasks[子任务ID] = 结果
  │
  └─ 所有批次完成后：
       ├─ exec orchestrator.py synthesize --results collected.json --conflicts conflicts.json
       │    → 生成最终报告（包括冲突检测）
       └─ 向用户返回合成后的结果
```

## 快速开始

### 0. 配置要求

`config.yaml` 必须启用深度2：
```yaml
agents:
  defaults:
    subagents:
      maxSpawnDepth: 2     # 必需：允许子代理再spawn子代理
      maxChildrenPerAgent: 10
      maxConcurrent: 8
```

### 1. 分解任务

调用分解脚本：
```bash
python3 scripts/orchestrator.py decompose "重构auth模块并更新所有测试"
```

输出 `subtasks.json`:
```json
{
  "subtasks": [
    {
      "id": "refactor_auth",
      "description": "重构 src/auth/auth.service.ts",
      "type": "refactor",
      "dependencies": []
    },
    {
      "id": "update_tests",
      "description": "更新 src/auth/__tests__/ 下的所有测试文件",
      "type": "test",
      "dependencies": ["refactor_auth"]
    }
  ]
}
```

### 2. 生成执行计划

主agent读取`subtasks.json`，使用`buildBatches`函数生成批处理计划：
```typescript
// 伪代码
const batches = buildBatches(subtasks);
// → [["refactor_auth"], ["update_tests"]]
```

### 3. 并行执行

对每个批次，使用`sessions_spawn`并行启动子代理：
```markdown
# 批次1
sessions_spawn task="重构auth服务" agentId="coding-agent"
sessions_spawn task="重构auth中间件" agentId="coding-agent"
# … 等待所有完成
# 收集结果
```

### 4. 合成结果

所有子任务完成后，调用合成脚本：
```bash
python3 scripts/orchestrator.py synthesize --results collected.json --conflicts conflicts.json
```

生成完整报告。

## 工具与参考

### 辅助脚本（`scripts/`）

| 脚本 | 用途 | 调用方式 |
|------|------|----------|
| `orchestrator.py` | 主入口，提供`decompose`和`synthesize`子命令 | `python3 orchestrator.py decompose "..."` |
| `decomposer.ts` | TypeScript库（供agent直接调用） | `import { decomposeTask } from '...'` |
| `dependency.ts` | 依赖图构建 (`buildBatches`) | `buildBatches(subtasks)` |
| `matcher.ts` | Agent匹配逻辑 | `matchAgents(subtasks, config)` |
| `synthesizer.ts` | 结果合成与冲突检测 | `synthesizeResults(results, conflicts)` |

### 参考配置

- `references/config-example.yaml` - 完整配置示例
- `references/decompose-system.txt` - 分解LLM提示词
- `references/decompose-user.txt` (optional) - 用户级定制提示词

## 配置详解

### Agent映射

orchestrator根据`type`字段选择agent。配置优先级：

1. **临时指定**: `agentMap`参数（最高）
2. **全局配置**: `config/orchestrator.yaml` 中的 `agentMapping`
3. **默认回退**: `defaultAgent` 或主agent

示例：
```yaml
agentMapping:
  code: "coding-agent"
  test: "testing-agent"
  refactor: "coding-agent"  # 覆盖type映射
```

### 并发控制

- 全局: `agents.defaults.subagents.maxConcurrent` (default: 8)
- 临时: orchestrate时传入`maxConcurrent`
- 每agent: `agents.defaults.subagents.maxChildrenPerAgent` (default: 10)

### 超时

建议长任务设置`timeoutPerTask`（秒），默认900（15分钟）。

## 限制

- **最大深度**: 5层（orchestrator通常只用2层）
- ** announce持久化**: gateway重启会丢失未完成announce
  - 建议：单次orchestration总时长 < 30分钟，或实现checkpoint机制
- **上下文大小**: 子代理继承父上下文，超大任务可能溢出
  - Mitigation: 分批orchestrate，或手动传递关键文件作为attachment
- **冲突合并**: 仅自动合并完全相同或完全不重叠的修改
  - 复杂冲突需人工介入，查看`conflicts`字段

## 故障排查

### 分解质量差
- 检查`references/decompose-system.txt`提示词
- 调整`config/decomposePrompt`定制提示
- 复杂任务可能需要few-shot examples

### 子任务失败率高
- 检查agentId是否正确（`agentMap`配置）
- 检查子agent可用性（`agents list`）
- 缩短`timeoutPerTask`

### 死锁/进度卡住
- 检查依赖图是否有循环（buildBatches会throw）
- 检查sessions_spawn是否达到`maxChildrenPerAgent`限制
- 检查gateway日志：`openclaw logs agents`

### 内存/性能
- 设置合理的`maxConcurrent`
- 大项目（>20子任务）建议分阶段orchestrate

## 示例对话

用户: "重构auth模块，更新所有依赖代码，补充完整测试"

助手（orchestrator）:
1. exec: `python3 orchestrator.py decompose "重构auth模块..."`
2. 收到 5 个子任务，生成 3 批次
3. 批次1: spawn 2个 coding-agent 并行重构两个文件
4. 等待批次1完成 → 收集2个结果
5. 批次2: spawn 2个 testing-agent 写测试
6. 批次3: spawn 1个 docs-writer 更新文档
7. exec: `python3 orchestrator.py synthesize --results all.json`
8. 返回完整报告，包括文件列表和冲突检测结果

---

## 实现说明（开发者）

orchestrator skill采用"文档+辅助脚本"模式，不侵入OpenClaw核心。agent通过标准工具（sessions_spawn, exec, read, write）实现orchestration逻辑，orchestrator skill提供：

- **TS/JS库**（`scripts/`）供agent在实现中import
- **Python CLI**（`orchestrator.py`）供bash快速调用
- **提示词模板**（`references/`）用于LLM分解

未来可能需要：
- 添加orchestrate专用工具注册（通过`createOpenClawTools`）
- 添加sessions_spawn自动附件注入（基于context）
- 添加announce结果自动收集助手

当前PR1为基础设施，PR2考虑工具注册集成。
