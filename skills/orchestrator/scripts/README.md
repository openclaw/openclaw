# Orchestrator Skill 脚本目录

本目录包含辅助orchestration工作流的可执行脚本。

## 文件说明

| 文件 | 说明 |
|------|------|
| `orchestrator.py` | 主CLI入口，提供`decompose`和`synthesize`命令 |
| `decomposer.ts` | TypeScript分解库（供agent内部import使用） |
| `dependency.ts` | 依赖图构建工具 |
| `matcher.ts` | Agent匹配工具 |
| `synthesizer.ts` | 结果合成与冲突检测 |
| `types.ts` | 共享类型定义 |
| `orchestrator.ts` | 完整的orchestrate函数（待完善） |

## 使用方式

### 方式1: 直接CLI调用（推荐用于bash）

```bash
# 分解任务
python3 orchestrator.py decompose "重构auth模块并更新测试" --output subtasks.json

# 合成报告
python3 orchestrator.py synthesize --results collected.json --conflicts conflicts.json --output report.txt
```

### 方式2: 在agent中import TS库

```typescript
import { decomposeTask, buildBatches, matchAgents, synthesizeResults } from './orchestrator/scripts';

// 1. 分解
const decomposition = await decomposeTask("重构auth模块...");

// 2. 构建批次
const batches = buildBatches(decomposition.subtasks);

// 3. 匹配agent
const matches = matchAgents(decomposition.subtasks, config);

// 4. spawn并收集结果（略）
// ...

// 5. 合成
const final = synthesizeResults(results, conflicts);
```

## 待实现

- [ ] `decompose`命令实际调用主agent LLM（需要网关API访问）
- [ ] `orchestrator.ts` 中的 `spawnAndWaitForSubtask` 与 `sessions_spawn` 集成
- [ ] 添加配置文件自动发现（`config/orchestrator.yaml`）
- [ ] 添加进度回调支持
- [ ] 添加详细的日志/错误处理

## 测试

目前无自动化测试，建议手动验证：

```bash
# 测试分解
python3 orchestrator.py decompose "测试分解功能" --output /tmp/test.json
cat /tmp/test.json

# 测试合成
echo '[{"subtaskId":"t1","status":"completed","output":"ok","durationMs":1000,"artifacts":[]}]' > /tmp/results.json
python3 orchestrator.py synthesize --results /tmp/results.json --output /tmp/report.txt
cat /tmp/report.txt
```
